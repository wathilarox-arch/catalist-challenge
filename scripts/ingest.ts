import { parseArgs } from "node:util";
import { z } from "zod";
import { initializeMemory, openMemory } from "../lib/db";
import { extractMeeting, windowTurns } from "../lib/extract";
import { isComplete, loadMeetingTurns, selectMeetings } from "../lib/ingest";
import { createLlmClient } from "../lib/llm/client";
import { loadLocalEnv, readLlmSettings, readModels } from "../lib/llm/config";
import { getFreeModels } from "../lib/llm/openrouter";
import { teamIdSchema, type Meeting } from "../lib/parse";
import { reconcileMeeting } from "../lib/reconcile";

async function main() {
  loadLocalEnv();
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { teams: { type: "string" }, limit: { type: "string" } } });
  const stage = z.enum(["extract", "reconcile"]).parse(positionals[0]);
  const teams = values.teams?.split(",").map((team) => teamIdSchema.parse(team.trim().toUpperCase()));
  const limit = z.coerce.number().int().positive().optional().parse(values.limit);
  const settings = readLlmSettings();
  const db = openMemory(undefined, { readonly: false });
  try {
    initializeMemory(db);
    const selected = selectMeetings(db, teams, limit);
    const meetings = selected.filter(({ meeting_id }) => !isComplete(db, meeting_id, stage));
    console.log(`${stage}: ${meetings.length} pending, ${selected.length - meetings.length} already complete.`);
    if (!meetings.length) return;
    if (stage === "reconcile") {
      const missing = meetings.find(({ meeting_id }) => !isComplete(db, meeting_id, "extract"));
      if (missing) throw new Error(`${missing.meeting_id}: run extraction before reconciliation.`);
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const models = readModels();
    const model = stage === "extract" ? models.extract : models.agent ?? models.extract;
    if (!apiKey || !model) throw new Error("Set OPENROUTER_API_KEY and the stage model in .env.local.");
    const catalog = await getFreeModels();
    const available = new Map(catalog.map((entry) => [entry.id, entry.context_length]));
    const configured = [...new Set([model, ...models.fallbacks])];
    const missing = configured.filter((id) => !available.get(id));
    if (missing.length) throw new Error(`Configured models unavailable: ${missing.join(", ")}. Run npm run models to select an available model.`);
    const context = Math.min(...configured.map((id) => available.get(id)!));
    const client = createLlmClient({ apiKey, db, settings, fallbacks: models.fallbacks });
    const calls = new Map(meetings.map((meeting) => [meeting.meeting_id, stage === "extract" ?
      windowTurns(loadMeetingTurns(db, meeting.meeting_id), context, settings.extractInputTokens).length : 1]));
    let pending = [...calls.values()].reduce((sum, count) => sum + count, 0);
    console.log(`${await client.remainingBudget()} requests available for ${pending} estimated completion calls.`);

    const byTeam = new Map<string, Meeting[]>();
    for (const meeting of meetings) {
      const group = byTeam.get(meeting.team) ?? [];
      group.push(meeting);
      byTeam.set(meeting.team, group);
    }
    const groups = [...byTeam.values()];
    let next = 0;
    let failure: { error: unknown } | undefined;
    async function worker() {
      while (!failure && next < groups.length) {
        for (const meeting of groups[next++]) {
          if (failure) return;
          const work = calls.get(meeting.meeting_id)!;
          const options = { model: model!, context, maxInputTokens: settings.extractInputTokens, complete: client.complete,
            pendingCalls: Math.max(1, pending - work + 1) };
          console.log(`${meeting.meeting_id}: ${stage} started.`);
          try {
            const result = stage === "extract" ? await extractMeeting(db, meeting, options) : await reconcileMeeting(db, meeting, options);
            pending -= work;
            if (result) {
              const rejected = Array.isArray(result.rejected) ? result.rejected.length : result.rejected;
              console.log(`${meeting.meeting_id}: ${result.count} saved, ${rejected} rejected; ${await client.remainingBudget()} requests remaining.`);
              if (Array.isArray(result.rejected) && rejected) console.warn(`Rejected ledger ops: ${result.rejected.join(", ")}`);
            }
          } catch (error) {
            failure ??= { error: new Error(`${meeting.meeting_id}: ${error instanceof Error ? error.message : String(error)}`) };
            return;
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(settings.concurrency, groups.length) }, worker));
    if (failure) throw failure.error;
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Ingestion failed.");
  process.exitCode = 1;
});
