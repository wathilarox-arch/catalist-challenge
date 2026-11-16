import { randomUUID } from "node:crypto";
import { z } from "zod";
import { answerQuestion } from "./agent";
import { addCitationContext, readAskTeams, savedQuestions, transcriptContext } from "./ask-data";
import { matchSavedQuestion, maxQuestionLength, normalizeQuestion, type AskAnswer, type AskEvent } from "./ask";
import { initializeMemory, openMemory } from "./db";
import { createLlmClient, DailyBudgetError } from "./llm/client";
import { readLlmSettings, readModels, readOpenRouterKeys } from "./llm/config";
import { teamIdSchema } from "./parse";

const askInput = z.object({
  question: z.string().trim().min(1).max(maxQuestionLength),
  team: z.string().trim().toUpperCase().pipe(teamIdSchema).optional(),
}).strict();
type AskInput = z.infer<typeof askInput>;
type LiveQuestion = AskInput & { team: string };
type StepEvent = Extract<AskEvent, { type: "step" }>;
class AskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const hour = 60 * 60_000;
const day = 24 * hour;
const sessionCookie = "catalist_ask_session";
const answerCacheSize = 128;
const missingCorpus = "Live questions require the meeting transcript database. Saved answers are available.";
const missingConfig = "Live questions are unavailable until OpenRouter is configured. Saved answers are available.";
type Counter = { used: number; reset: number };

function resolveAskTeam({ question, team }: AskInput, teams: readonly string[]) {
  const mentioned = new Set([...question.matchAll(/\b([A-Z]{2}\d{4})[a-d]?\b/gi)].map((match) => match[1].toUpperCase()));
  if (mentioned.size > 1) throw new AskError("team_required", "Ask about one team at a time.");
  const [named] = mentioned;
  if (team && named && team !== named) {
    throw new AskError("team_conflict", "The team in your question differs from the selected team.");
  }
  const scopedTeam = team ?? named;
  if (!scopedTeam) throw new AskError("team_required", "Choose a team below or include its ID in your question.");
  if (!teams.includes(scopedTeam)) throw new AskError("unknown_team", `There are no indexed meetings for team ${scopedTeam}.`);
  return scopedTeam;
}

function getLiveConfig() {
  try {
    const apiKeys = readOpenRouterKeys();
    const { agent: model, fallbacks } = readModels();
    const settings = readLlmSettings();
    if (apiKeys.length && model) return { apiKeys, model, fallbacks, settings };
  } catch {
    // The saved catalog is still available when the server configuration is invalid.
  }
}

export function liveAvailability(hasCorpus: boolean) {
  if (!hasCorpus) return missingCorpus;
  if (!getLiveConfig()) return missingConfig;
}

function withCorpus<T>(read: (db: ReturnType<typeof openMemory>) => T) {
  const db = openMemory();
  try {
    return read(db);
  } finally {
    db.close();
  }
}

let liveClient: ReturnType<typeof createLlmClient> | undefined;
async function runLiveQuestion(input: LiveQuestion, onStep: (event: StepEvent) => void, signal: AbortSignal) {
  const config = getLiveConfig();
  if (!config) throw new AskError("live_unavailable", missingConfig);
  liveClient ??= (() => {
    const db = openMemory(":memory:", { readonly: false });
    try {
      initializeMemory(db);
      return createLlmClient({ ...config, db });
    } catch (error) {
      db.close();
      throw error;
    }
  })();
  const client = liveClient;
  const remaining = await client.remainingBudget(signal).catch(() => {
    signal.throwIfAborted();
    throw new AskError("provider_unavailable", "OpenRouter quota could not be checked. Try again shortly or browse saved answers.");
  });
  if (!remaining) throw new DailyBudgetError(1);
  signal.throwIfAborted();
  const corpus = openMemory();
  try {
    const answer = await answerQuestion(corpus, {
      question_id: randomUUID(), question: input.question, team: input.team,
    }, {
      model: config.model, purpose: "web:ask", maxOutputTokens: config.settings.agentOutputTokens,
      complete: (request) => client.complete(request, signal),
      onStep: ({ step, action, turnIds }) => onStep({
        type: "step", step, action: action.action, turns: turnIds.length,
      }),
    });
    return addCitationContext({ text: answer.answer, citations: answer.citations }, transcriptContext(corpus));
  } finally {
    corpus.close();
  }
}

function errorEvent(error: unknown): Extract<AskEvent, { type: "error" }> {
  if (error instanceof AskError) return { type: "error", code: error.code, message: error.message };
  if (error instanceof DailyBudgetError) {
    return {
      type: "error", code: "quota_exhausted",
      message: "The live request budget is exhausted. Browse saved answers or try again after the UTC reset.",
    };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { type: "error", code: "timeout", message: "The live question timed out. Please try again." };
  }
  return {
    type: "error", code: "answer_unavailable",
    message: "A verified answer could not be produced. Try a more specific question or browse saved answers.",
  };
}

function streamAnswer(request: Request, work: (send: (event: AskEvent) => void, signal: AbortSignal) => Promise<void>, cookie?: string) {
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  const timeout = AbortSignal.timeout(280_000);
  const disconnected = AbortSignal.any([request.signal, cancelled.signal]);
  const signal = AbortSignal.any([disconnected, timeout]);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: AskEvent) => {
        if (!closed && !disconnected.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (!cancelled.signal.aborted) controller.close();
      };
      const stop = () => {
        if (timeout.aborted) send(errorEvent(timeout.reason));
        close();
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
        await work(send, signal);
      } catch (error) {
        send(errorEvent(timeout.aborted ? timeout.reason : error));
      } finally {
        signal.removeEventListener("abort", stop);
        close();
      }
    },
    cancel() { cancelled.abort(); },
  });
  const headers = new Headers({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(body, { headers });
}

export function createAskHandler({
  teams = () => withCorpus(readAskTeams),
  readSaved = (answer: AskAnswer) => {
    try { return withCorpus((db) => addCitationContext(answer, transcriptContext(db))); }
    catch { return answer; }
  },
  run = runLiveQuestion,
  available = () => liveAvailability(true) === undefined,
  now = Date.now,
  clientIp = (request: Request) => process.env.VERCEL
    ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() || "unknown"
    : "local",
} = {}) {
  const cached = new Map<string, AskAnswer>();
  const sessions = new Map<string, Counter>();
  const addresses = new Map<string, Counter>();
  const fail = (error: unknown, status: number) => Response.json(errorEvent(error), {
    status, headers: { "Cache-Control": "no-store" },
  });

  return async function POST(request: Request) {
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return fail(new AskError("invalid_request", "Open the Ask page to submit a question."), 403);
    }
    const parsed = askInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(new AskError("invalid_question", `Enter a question of up to ${maxQuestionLength} characters and an optional valid team ID.`), 400);
    }
    const { question, team } = parsed.data;
    const saved = matchSavedQuestion(savedQuestions, question, team);
    if (saved) return streamAnswer(request, async (send) => send({ type: "answer", answer: readSaved(saved.answer), source: "saved" }));

    let indexedTeams: string[];
    try { indexedTeams = teams(); }
    catch { return fail(new AskError("live_unavailable", missingCorpus), 503); }
    if (!indexedTeams.length) return fail(new AskError("live_unavailable", missingCorpus), 503);
    let scopedTeam: string;
    try { scopedTeam = resolveAskTeam(parsed.data, indexedTeams); }
    catch (error) { return fail(error, 400); }

    const key = JSON.stringify([scopedTeam, normalizeQuestion(question)]);
    const existing = cached.get(key);
    if (existing) {
      cached.delete(key);
      cached.set(key, existing);
      return streamAnswer(request, async (send) => send({ type: "answer", answer: existing, source: "cached" }));
    }
    if (!available()) return fail(new AskError("live_unavailable", missingConfig), 503);

    const instant = now();
    for (const counts of [sessions, addresses]) {
      for (const [id, counter] of counts) {
        if (counter.reset <= instant) counts.delete(id);
      }
    }
    const existingId = request.headers.get("cookie")?.match(/(?:^|;\s*)catalist_ask_session=([0-9a-f-]{36})(?:;|$)/)?.[1];
    const session = existingId ?? randomUUID();
    const ip = clientIp(request);
    const sessionCount = sessions.get(session) ?? { used: 0, reset: Math.floor(instant / day + 1) * day };
    const addressCount = addresses.get(ip) ?? { used: 0, reset: instant + hour };
    if (sessionCount.used >= 5) {
      return fail(new AskError("session_limit", "This browser has reached today’s live question limit. Saved answers are still available."), 429);
    }
    if (addressCount.used >= 10) {
      return fail(new AskError("ip_limit", "This network has reached its hourly live question limit. Try again later or browse saved answers."), 429);
    }
    sessionCount.used++;
    addressCount.used++;
    sessions.set(session, sessionCount);
    addresses.set(ip, addressCount);
    const secure = new URL(request.url).protocol === "https:" || process.env.VERCEL;
    const cookie = existingId ? undefined : `${sessionCookie}=${session}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

    return streamAnswer(request, async (send, signal) => {
      const answer = await run({ question, team: scopedTeam }, send, signal);
      signal.throwIfAborted();
      if (cached.size >= answerCacheSize) {
        const oldest = cached.keys().next();
        if (!oldest.done) cached.delete(oldest.value);
      }
      cached.set(key, answer);
      send({ type: "answer", source: "live", answer });
    }, cookie);
  };
}
