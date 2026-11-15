import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import type { MemoryDatabase } from "../db";
import { freeModelSchema, readLlmSettings } from "./config";
import { type Clock, realClock, RequestLimiter } from "./limiter";
import { type FreeQuota, getFreeQuota, openRouterUrl } from "./openrouter";

const messageSchema = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() });
const requestSchema = z.object({
  model: freeModelSchema,
  messages: z.array(messageSchema).min(1),
  purpose: z.string().min(1),
  temperature: z.number().min(0).max(0.2).default(0.1),
  maxTokens: z.number().int().positive().optional(),
  pendingCalls: z.number().int().positive().default(1),
});

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});
const responseSchema = z.object({
  text: z.string().min(1),
  usage: usageSchema.nullable(),
});
const errorSchema = z.object({
  error: z.object({ metadata: z.object({ limit_source: z.string().optional() }).optional() }).optional(),
  metadata: z.object({ limit_source: z.string().optional() }).optional(),
});

export type LlmRequest = z.input<typeof requestSchema>;
export type LlmResponse = z.infer<typeof responseSchema> & { model: string; cached: boolean; discard?: () => void };
export type Complete = (request: LlmRequest) => Promise<LlmResponse>;
type ChatRequest = { model: string; messages: z.infer<typeof messageSchema>[]; temperature: number; max_tokens?: number; stream: false; reasoning?: { enabled: false } | { effort: NonNullable<Settings["reasoningEffort"]> } };
type Transport = (request: ChatRequest) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
type Settings = ReturnType<typeof readLlmSettings>;

export class DailyBudgetError extends Error {
  constructor(readonly pendingCalls: number) {
    super(`Free-model request budget exhausted. ${pendingCalls} estimated completion call(s) pending. Resume after the UTC reset or raise the configured cap if quota is available.`);
    this.name = "DailyBudgetError";
  }
}

class RetryableResponse extends Error {
  constructor(readonly status: string, readonly usage: LlmResponse["usage"] = null) {
    super(status);
  }
}

function limitSource(error: unknown) {
  const parsed = errorSchema.safeParse(error);
  if (!parsed.success) return;
  const source = parsed.data.error?.metadata?.limit_source ?? parsed.data.metadata?.limit_source;
  if (source && /^(?:openrouter|upstream)_[a-z0-9_]{1,70}$/.test(source)) return source;
}

function retryDelay(headers: Headers | undefined, now: number) {
  const retry = headers?.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
    if (Number.isFinite(delay)) return Math.max(0, delay);
  }
  const reset = Number(headers?.get("x-ratelimit-reset"));
  if (reset > 0) return Math.max(0, (reset < 1e12 ? reset * 1000 : reset) - now);
  return 0;
}

export function stripThinking(content: string) {
  return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
}

export function createLlmClient({
  apiKey, db, fallbacks = [], settings = readLlmSettings(), clock = realClock,
  quota = () => getFreeQuota(apiKey), transport,
}: {
  apiKey: string;
  db: MemoryDatabase;
  fallbacks?: readonly string[];
  settings?: Settings;
  clock?: Clock;
  quota?: () => Promise<FreeQuota>;
  transport?: Transport;
}) {
  const validatedFallbacks = z.array(freeModelSchema).parse(fallbacks);
  const sdk = new OpenAI({ apiKey, baseURL: openRouterUrl, maxRetries: 0, timeout: 45_000 });
  const send: Transport = transport ?? ((params) => sdk.chat.completions.create(params, {
    timeout: Math.max(45_000, Math.ceil((params.max_tokens ?? 0) * 6)),
  }));
  const limiter = new RequestLimiter(settings.rpm, settings.concurrency, clock);
  const cacheGet = db.prepare<[string], { response: string }>("SELECT response FROM llm_cache WHERE key = ?");
  const cachePut = db.prepare("INSERT OR REPLACE INTO llm_cache (key, response, created_at) VALUES (?, ?, ?)");
  const cacheRemove = db.prepare("DELETE FROM llm_cache WHERE key = ? AND response = ?");
  const countToday = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM llm_calls WHERE cached = 0 AND ts >= ?");
  const insertLog = db.prepare(`
    INSERT INTO llm_calls (ts, model, purpose, prompt_tokens, completion_tokens, latency_ms, cached, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const finishLog = db.prepare(`
    UPDATE llm_calls SET status = ?, prompt_tokens = ?, completion_tokens = ?, latency_ms = ? WHERE id = ?
  `);
  let dailyQuota: { day: string; remaining: number } | undefined;
  let quotaRead: Promise<void> | undefined;
  const day = () => new Date(clock.now()).toISOString().slice(0, 10);
  const usedToday = () => countToday.get(`${day()}T00:00:00.000Z`)?.count ?? 0;

  async function remainingBudget() {
    const today = day();
    if (dailyQuota?.day !== today) {
      quotaRead ??= quota().then(({ remaining }) => {
        dailyQuota = { day: today, remaining };
      }).finally(() => { quotaRead = undefined; });
      await quotaRead;
    }
    const local = settings.dailyBudget === undefined ? Infinity : settings.dailyBudget - usedToday();
    return Math.max(0, Math.min(local, dailyQuota!.remaining));
  }

  function logCall(model: string, purpose: string, status: string, cached: boolean, start: number, usage: LlmResponse["usage"]) {
    return insertLog.run(new Date(start).toISOString(), model, purpose, usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null, Math.max(0, Math.round(clock.now() - start)), Number(cached), status).lastInsertRowid;
  }

  const reserveAttempt = db.transaction((model: string, request: z.output<typeof requestSchema>, start: number) => {
    if (!dailyQuota?.remaining || usedToday() >= (settings.dailyBudget ?? Infinity)) {
      throw new DailyBudgetError(request.pendingCalls);
    }
    const id = logCall(model, request.purpose, "started", false, start, null);
    dailyQuota.remaining--;
    return id;
  });

  const pending = new Map<string, Promise<LlmResponse>>();
  const complete: Complete = async (input) => {
    const request = requestSchema.parse(input);
    const models = [...new Set([request.model, ...validatedFallbacks])];
    const candidates = models.map((model) => {
      const params: ChatRequest = { model, messages: request.messages, temperature: request.temperature, max_tokens: request.maxTokens, stream: false,
        ...(settings.disableReasoning ? { reasoning: { enabled: false } as const } :
          settings.reasoningEffort ? { reasoning: { effort: settings.reasoningEffort } } : {}) };
      const key = createHash("sha256").update(JSON.stringify(params)).digest("hex");
      return { params, key };
    });
    for (const { params, key } of candidates) {
      const cached = cacheGet.get(key);
      if (!cached) continue;
      const result = responseSchema.parse(JSON.parse(cached.response));
      logCall(params.model, request.purpose, "ok", true, clock.now(), result.usage);
      return { ...result, model: params.model, cached: true, discard: () => { cacheRemove.run(key, cached.response); } };
    }
    const inFlightKey = candidates.map(({ key }) => key).join(":");
    const existing = pending.get(inFlightKey);
    if (existing) {
      const result = await existing;
      logCall(result.model, request.purpose, "ok", true, clock.now(), result.usage);
      return { ...result, cached: true };
    }

    const execute = async (): Promise<LlmResponse> => {
      let lastStatus = "unavailable";
      for (const { params, key } of candidates) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (!await remainingBudget()) throw new DailyBudgetError(request.pendingCalls);
            return await limiter.run(async () => {
              if (dailyQuota?.day !== day()) await remainingBudget();
              const start = clock.now();
              // Every live attempt consumes quota, including failed or interrupted requests.
              const callId = reserveAttempt.immediate(params.model, request, start);
              const finish = (status: string, usage: LlmResponse["usage"]) => finishLog.run(
                status, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, clock.now() - start, callId,
              );

              let result: z.infer<typeof responseSchema>;
              try {
                const reply = await send(params);
                const usage = reply.usage ? usageSchema.parse(reply.usage) : null;
                const choice = reply.choices?.[0];
                const providerError = (choice && "error" in choice ? choice.error : undefined) ??
                  ("error" in reply ? reply.error : undefined);
                if (limitSource({ error: providerError }) === "openrouter_free_tier_daily") {
                  throw new DailyBudgetError(request.pendingCalls);
                }
                if (String(choice?.finish_reason) === "error" || providerError) throw new RetryableResponse("provider_error", usage);
                const text = stripThinking(choice?.message?.content ?? "");
                if (!text) throw new RetryableResponse("empty", usage);
                result = { text, usage };
              } catch (error) {
                const daily = error instanceof DailyBudgetError ||
                  (error instanceof OpenAI.APIError && limitSource(error.error) === "openrouter_free_tier_daily");
                if (daily) dailyQuota!.remaining = 0;
                const status = daily ? "429_daily" : error instanceof RetryableResponse ? error.status :
                  error instanceof OpenAI.APIError && error.status ? String(error.status) : "transport_error";
                finish(status, error instanceof RetryableResponse ? error.usage : null);
                if (daily) throw new DailyBudgetError(request.pendingCalls);
                throw error;
              }
              const serialized = JSON.stringify(result);
              db.transaction(() => {
                cachePut.run(key, serialized, new Date(start).toISOString());
                finish("ok", result.usage);
              })();
              return { ...result, model: params.model, cached: false, discard: () => { cacheRemove.run(key, serialized); } };
            });
          } catch (error) {
            if (error instanceof DailyBudgetError) throw error;
            const apiError = error instanceof OpenAI.APIError ? error : undefined;
            const status = apiError?.status;
            const retryable = error instanceof RetryableResponse || error instanceof OpenAI.APIConnectionError ||
              status === 429 || (status !== undefined && status >= 500);
            if (!retryable && status !== 404) {
              if (status) throw new Error(`OpenRouter completion returned HTTP ${status}. Check key and model configuration.`);
              throw error;
            }
            const source = limitSource(apiError?.error);
            lastStatus = status ? `HTTP ${status}${source ? ` ${source}` : ""}` :
              error instanceof RetryableResponse ? error.status : "network error";
            if (!retryable || attempt === 2) break;
            const delay = Math.max(1_000 * 2 ** attempt + Math.floor(clock.random() * 500), retryDelay(apiError?.headers, clock.now()));
            // Long provider cooldowns skip this model rather than blocking the whole run.
            if (delay > 60_000) {
              lastStatus += `, retry after ${Math.ceil(delay / 1000)}s`;
              break;
            }
            await clock.sleep(delay);
          }
        }
      }
      throw new Error(`No configured free model completed the request (${lastStatus}). Check npm run models and account quota.`);
    };

    const promise = execute();
    pending.set(inFlightKey, promise);
    try {
      return await promise;
    } finally {
      pending.delete(inFlightKey);
    }
  };

  return { complete, remainingBudget };
}
