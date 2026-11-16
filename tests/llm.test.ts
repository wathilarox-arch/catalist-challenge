import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { initializeMemory, openMemory, type MemoryDatabase } from "../lib/db";
import { createLlmClient, DailyBudgetError, type LlmRequest } from "../lib/llm/client";
import { readOpenRouterKeys } from "../lib/llm/config";
import { completeJson, firstJsonObject } from "../lib/llm/json";
import { RequestLimiter } from "../lib/llm/limiter";
import { getFreeModels, getFreeQuota } from "../lib/llm/openrouter";

const request: LlmRequest = {
  model: "example/primary:free", purpose: "extract", messages: [{ role: "user", content: "Give JSON." }],
};
const fallback = "example/fallback:free";
const schema = z.object({ answer: z.number() });

function completion(content: string, reason = "stop"): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "test", object: "chat.completion", created: 0, model: request.model,
    choices: [{ index: 0, message: { role: "assistant", content, refusal: null }, logprobs: null,
      finish_reason: reason as OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function fakeClock() {
  let ms = Date.UTC(2026, 10, 14);
  return { now: () => ms, random: () => 0, sleep: vi.fn(async (delay: number) => { ms += delay; }) };
}

let db: MemoryDatabase;
beforeEach(() => {
  db = openMemory(":memory:", { readonly: false });
  initializeMemory(db);
});
afterEach(() => db.close());

function setup(transport = vi.fn(async () => completion('{"answer":42}')), budget = 50, dailyBudget?: number) {
  const clock = fakeClock();
  const quota = vi.fn(async () => ({ limit: 50, remaining: budget, used: 50 - budget }));
  const options = { apiKeys: ["test"], db, transport, clock, quota, settings: { rpm: 15, concurrency: 1, dailyBudget } };
  return { ...createLlmClient({ ...options, fallbacks: [fallback] }), transport, options, clock, quota };
}

const calls = () => db.prepare("SELECT model, purpose, status, cached, prompt_tokens, completion_tokens FROM llm_calls ORDER BY id").all();

it("reads numbered keys in numerical order, skipping gaps, blanks, and duplicates", () => {
  expect(readOpenRouterKeys({
    OPENROUTER_API_KEY: " primary ", OPENROUTER_CONTINUATION_KEY_10: "last",
    OPENROUTER_CONTINUATION_KEY_2: "second", OPENROUTER_CONTINUATION_KEY_1: "primary",
    OPENROUTER_CONTINUATION_KEY_5: " ",
  })).toEqual(["primary", "second", "last"]);
});

describe("OpenRouter client", () => {
  it("persists usage and reuses cached completions across clients at zero quota", async () => {
    const { complete, transport, options } = setup();
    transport.mockResolvedValueOnce(completion('<think>intermediate</think>\n {"answer":42}'));
    await expect(complete(request)).resolves.toMatchObject({ cached: false, text: '{"answer":42}' });
    const quota = vi.fn(async () => ({ limit: 50, remaining: 0, used: 50 }));
    const client = createLlmClient({ ...options, quota });
    await expect(client.complete(request)).resolves.toMatchObject({ cached: true, text: '{"answer":42}' });
    expect(quota).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
    expect(calls()).toMatchObject([{ cached: 0, prompt_tokens: 10, completion_tokens: 5 }, { cached: 1 }]);
  });

  it("honors Retry-After on a transient 429 and charges each attempt", async () => {
    const { complete, transport, clock, remainingBudget } = setup();
    transport.mockRejectedValueOnce(OpenAI.APIError.generate(429, { error: { message: "slow down" } }, undefined, new Headers({ "Retry-After": "7" })));
    await complete(request);
    expect(clock.sleep).toHaveBeenCalledWith(7000);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await remainingBudget()).toBe(48);
    expect(calls()).toMatchObject([{ status: "429" }, { status: "ok" }]);
  });

  it("retries empty and error-finish responses, then caches the fallback", async () => {
    const { complete, transport } = setup();
    transport.mockResolvedValueOnce(completion("")).mockResolvedValueOnce(completion("partial", "error"))
      .mockRejectedValueOnce(OpenAI.APIError.generate(503, { error: { message: "unavailable" } }, undefined, new Headers()));
    await expect(complete(request)).resolves.toMatchObject({ model: fallback, cached: false });
    await expect(complete(request)).resolves.toMatchObject({ model: fallback, cached: true });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(calls()).toMatchObject([{ status: "empty" }, { status: "provider_error" }, { status: "503" }, { status: "ok" }, { status: "ok", cached: 1 }]);
  });

  it("stops without retries or fallback when the provider reports the daily cap", async () => {
    const { complete, transport, remainingBudget, clock } = setup();
    transport.mockRejectedValueOnce(OpenAI.APIError.generate(429, {
      error: { message: "cap", metadata: { limit_source: "openrouter_free_tier_daily" } },
    }, undefined, new Headers({ "Retry-After": "6000" })));
    await expect(complete({ ...request, pendingCalls: 9 })).rejects.toThrow("9 estimated completion call(s) pending");
    expect(await remainingBudget()).toBe(0);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(calls()).toMatchObject([{ status: "429_daily" }]);
  });

  it("uses the next key when the quota check reports that the primary is exhausted", async () => {
    const { options } = setup();
    const quota = vi.fn(async (key: string) => ({ limit: 50, remaining: key === "test" ? 0 : 2, used: 48 }));
    const client = createLlmClient({ ...options, apiKeys: ["test", "backup", "later"], quota });
    expect(await client.remainingBudget()).toBe(2);
    await expect(client.complete(request)).resolves.toMatchObject({ model: request.model });
    expect(quota.mock.calls).toEqual([["test"], ["backup"]]);
    expect(options.transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: request.model }), "backup");
  });

  it.each([[429, "openrouter_free_tier_daily", "429_daily"], [402, "openrouter_key_limit", "402"]] as const)(
    "switches keys on HTTP %i quota exhaustion and keeps the same model",
    async (status, source, loggedStatus) => {
      const { options } = setup();
      const client = createLlmClient({ ...options, apiKeys: ["test", "backup"], fallbacks: [fallback] });
      options.transport.mockRejectedValueOnce(OpenAI.APIError.generate(status, {
        error: { message: "cap", metadata: { limit_source: source } },
      }, undefined, new Headers()));
      await client.complete(request);
      await client.complete({ ...request, maxTokens: 50 });
      expect(options.transport).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: request.model }), "test");
      expect(options.transport).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: request.model }), "backup");
      expect(options.transport).toHaveBeenNthCalledWith(3, expect.objectContaining({ model: request.model }), "backup");
      expect(calls()).toMatchObject([{ status: loggedStatus }, { status: "ok" }, { status: "ok" }]);
    },
  );

  it("enforces the same local cap across keys", async () => {
    const { options } = setup(undefined, 1, 2);
    const client = createLlmClient({ ...options, apiKeys: ["test", "backup", "unneeded"] });
    await client.complete(request);
    await client.complete({ ...request, maxTokens: 50 });
    await expect(client.complete({ ...request, maxTokens: 51 })).rejects.toBeInstanceOf(DailyBudgetError);
    expect(options.quota).toHaveBeenCalledTimes(2);
    expect(options.transport).toHaveBeenCalledTimes(2);
  });

  it("moves concurrent requests to the backup when the primary's last slot is reserved", async () => {
    const { options } = setup(undefined, 1);
    const client = createLlmClient({
      ...options, apiKeys: ["test", "backup"], settings: { ...options.settings, concurrency: 2 },
    });
    await Promise.all([client.complete(request), client.complete({ ...request, maxTokens: 50 })]);
    expect(options.transport).toHaveBeenCalledTimes(2);
    expect(options.transport).toHaveBeenNthCalledWith(1, expect.any(Object), "test");
    expect(options.transport).toHaveBeenNthCalledWith(2, expect.any(Object), "backup");
  });

  it("reserves the local budget durably and enforces it after a restart", async () => {
    const { complete, transport, options } = setup(undefined, 50, 1);
    await complete(request);
    const restarted = createLlmClient(options);
    await expect(restarted.complete({ ...request, maxTokens: 50 })).rejects.toBeInstanceOf(DailyBudgetError);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("coalesces equivalent in-flight requests", async () => {
    const { complete, transport, quota } = setup();
    const result = await Promise.all([complete(request), complete(request)]);
    expect(transport).toHaveBeenCalledOnce();
    expect(quota).toHaveBeenCalledOnce();
    expect(result.map(({ cached }) => cached)).toEqual([false, true]);
  });
});

describe("JSON completions", () => {
  it("finds the first balanced object amid prose, fences, and quoted braces", () => {
    expect(firstJsonObject('Result:\n```json\n{"a":{"b":"}\\\"{"}}\n```\n{"second":true}'))
      .toBe('{"a":{"b":"}\\\"{"}}');
    expect(() => firstJsonObject('{"incomplete":true')).toThrow();
  });

  it("sends the validation error and logs a single repair", async () => {
    const { complete, transport } = setup();
    transport.mockResolvedValueOnce(completion('{"answer":"wrong"}'));
    await expect(completeJson(complete, request, schema)).resolves.toMatchObject({ repaired: true, data: { answer: 42 } });
    expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({ messages: expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("answer:") }),
    ]) }), "test");
    expect(calls()).toMatchObject([{ purpose: "extract" }, { purpose: "extract:repair" }]);
  });

  it("stops after the repair fails and fetches a fresh response on rerun", async () => {
    const { complete, transport } = setup(vi.fn(async () => completion("This is prose.")));
    await expect(completeJson(complete, request, schema)).rejects.toThrow("after one repair");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) FROM llm_cache").pluck().get()).toBe(0);
    transport.mockResolvedValueOnce(completion('{"answer":42}'));
    await expect(completeJson(complete, request, schema)).resolves.toMatchObject({ repaired: false, data: { answer: 42 } });
    expect(transport).toHaveBeenCalledTimes(3);
  });
});

it("spaces request starts and limits concurrent calls", async () => {
  const clock = fakeClock();
  const limiter = new RequestLimiter(15, 1, clock);
  let release!: () => void;
  const first = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
  const second = vi.fn(async () => {});
  const queued = limiter.run(second);
  expect(second).not.toHaveBeenCalled();
  release();
  await Promise.all([first, queued]);
  expect(second).toHaveBeenCalledOnce();
  expect(clock.sleep).toHaveBeenCalledWith(4000);
});

it("validates the catalog and reads the provider's free-request quota", async () => {
  const models = [request.model, "example/paid"].map((id) => ({ id, context_length: 32768, supported_parameters: [] }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: models }))
    .mockResolvedValueOnce(Response.json({ data: { free_model_daily_requests: { limit: 50, remaining: 4, used: 46 } } }));
  await expect(getFreeModels(fetcher)).resolves.toEqual([models[0]]);
  await expect(getFreeQuota("test", fetcher)).resolves.toMatchObject({ remaining: 4 });
});
