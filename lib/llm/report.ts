import type { MemoryDatabase } from "../db";
import type { readModels } from "./config";

export type CallLog = {
  id: number;
  model: string;
  purpose: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  cached: 0 | 1;
  status: string;
};

export function readCalls(db: MemoryDatabase) {
  return db.prepare<[], CallLog>(`SELECT id, model, purpose, prompt_tokens, completion_tokens,
    latency_ms, cached, status FROM llm_calls ORDER BY id`).all();
}

export const percent = (part: number, total: number) => total ? `${(100 * part / total).toFixed(1)}% (${part}/${total})` : "Pending";

export function callSummary(calls: CallLog[], models: ReturnType<typeof readModels>) {
  const primary: Record<string, string | undefined> = {
    extract: models.extract, reconcile: models.agent ?? models.extract, smoke: models.extract,
    eval: models.agent, agent: models.agent, brief: models.agent,
  };
  const live = calls.filter(({ cached }) => !cached);
  const status = new Map<string, number>();
  for (const { status: code } of live) status.set(code, (status.get(code) ?? 0) + 1);
  const repairs = calls.filter(({ purpose }) => purpose.endsWith(":repair")).length;
  const throttled = (status.get("429") ?? 0) + (status.get("429_daily") ?? 0);
  const fallback = new Set(live.filter(({ status, purpose, model }) => {
    const expected = primary[purpose.replace(/:repair$/, "")];
    return status === "ok" && expected && expected !== model && models.fallbacks.includes(model);
  }).map(({ model }) => model));

  return [
    `- Calls logged: ${calls.length} (${live.length} live attempts).`,
    `- JSON repair calls as a share of logged calls: ${percent(repairs, calls.length)}.`,
    `- Cache hit rate: ${percent(calls.length - live.length, calls.length)}.`,
    `- Logged HTTP 429s: ${throttled}, including ${status.get("429_daily") ?? 0} identified as account-wide daily exhaustion.`,
    `- Live status counts: ${[...status].map(([code, count]) => `${code} (${count})`).join(", ") || "no attempts"}.`,
    ...(throttled ? ["- The provider rejected those attempts with rate-limit responses. The log does not distinguish upstream throttling from other unclassified 429s."] : []),
    ...(status.has("empty") ? ["- Some provider attempts returned no usable completion text and required retry or fallback."] : []),
    ...(status.has("started") ? ["- Some attempts have no final status in SQLite. Their outcome is unknown."] : []),
    `- Configured fallback models observed on successful live calls: ${[...fallback].join(", ") || "none"}. Attribution uses the current configuration, since the log stores only the attempted model.`,
  ];
}
