import { parseArgs } from "node:util";
import { z } from "zod";
import { openMemory } from "../lib/db";
import { windowTurns } from "../lib/extract";
import { completedMeetings, loadMeetingTurns, selectMeetings } from "../lib/ingest";
import { loadLocalEnv, readLlmSettings, readModels } from "../lib/llm/config";
import { getFreeModels, getFreeQuota } from "../lib/llm/openrouter";
import { teamIdSchema } from "../lib/parse";

async function main() {
  loadLocalEnv();
  const { values } = parseArgs({ options: { teams: { type: "string" }, limit: { type: "string" } } });
  const selectedTeams = values.teams?.split(",").map((id) => teamIdSchema.parse(id.trim().toUpperCase()));
  const limit = z.coerce.number().int().positive().optional().parse(values.limit);
  const { extract, fallbacks } = readModels();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!extract || !apiKey) throw new Error("Set MODEL_EXTRACT and OPENROUTER_API_KEY in .env.local before planning calls.");
  const [models, quota] = await Promise.all([getFreeModels(), getFreeQuota(apiKey)]);
  const contexts = [extract, ...fallbacks].map((model) => {
    const context = models.find(({ id }) => id === model)?.context_length;
    if (!context) throw new Error(`No context limit found for ${model}. Run npm run models and select a listed extraction model.`);
    return context;
  });
  const context = Math.min(...contexts);
  const settings = readLlmSettings();
  const db = openMemory();
  try {
    const meetings = selectMeetings(db, selectedTeams, limit);
    const extracted = completedMeetings(db, "extract");
    const reconciled = completedMeetings(db, "reconcile");
    const extraction = meetings.filter(({ meeting_id }) => !extracted.has(meeting_id)).reduce((total, meeting) =>
      total + windowTurns(loadMeetingTurns(db, meeting.meeting_id), context, settings.extractInputTokens).length, 0);
    const reconciliation = meetings.filter(({ meeting_id }) => !reconciled.has(meeting_id)).length;
    const calls = extraction + reconciliation;
    const today = new Date().toISOString().slice(0, 10);
    const localUsed = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM llm_calls WHERE cached = 0 AND ts >= ?")
      .get(`${today}T00:00:00.000Z`)?.count ?? 0;
    const daily = Math.min(quota.limit, settings.dailyBudget ?? Infinity);
    const remaining = Math.min(quota.remaining, Math.max(0, (settings.dailyBudget ?? Infinity) - localUsed));
    const days = calls === 0 ? 0 : calls <= remaining ? 1 : daily > 0 ? 1 + Math.ceil((calls - remaining) / daily) : Infinity;
    console.log(`${meetings.length} meetings across ${new Set(meetings.map(({ team }) => team)).size} teams.`);
    console.log(`${calls} estimated remaining completion requests (${extraction} extraction + ${reconciliation} reconciliation).`);
    console.log(`${remaining} requests available today / ${daily} per UTC quota day. Provider quota: ${quota.remaining}/${quota.limit} remaining.`);
    console.log(Number.isFinite(days) ? `${days} quota day(s) including today.` : "The configured daily cap is zero.");
    console.log(`Request pacing at ${settings.rpm} RPM: ~${(calls / settings.rpm).toFixed(1)} min (concurrency ${settings.concurrency}).`);
    console.log("Ingestion estimate excludes retries, JSON repairs, cache hits and time waiting for quota resets. Model latency can increase runtime.");
    console.log(`Team order: ${[...new Set(meetings.map(({ team }) => team))].join(", ")}`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Call planning failed.");
  process.exitCode = 1;
});
