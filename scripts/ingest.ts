import { parseArgs } from "node:util";
import { z } from "zod";
import { initializeMemory, openMemory } from "../lib/db";
import { extractMeeting, windowTurns } from "../lib/extract";
import { completedMeetings, loadMeetingTurns, selectMeetings, type Stage } from "../lib/ingest";
import { createLlmClient } from "../lib/llm/client";
import { loadLocalEnv, readLlmSettings, readModels } from "../lib/llm/config";
import { getFreeModels } from "../lib/llm/openrouter";
import { teamIdSchema, type Meeting } from "../lib/parse";
import { reconcileMeeting } from "../lib/reconcile";

async function main() {
  loadLocalEnv();
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { teams: { type: "string" }, limit: { type: "string" } } });
  const mode = z.enum(["extract", "reconcile", "all"]).parse(positionals[0]);
  const teams = values.teams?.split(",").map((team) => teamIdSchema.parse(team.trim().toUpperCase()));
  const limit = z.coerce.number().int().positive().optional().parse(values.limit);
  const settings = readLlmSettings();
  const db = openMemory(undefined, { readonly: false });
  try {
    initializeMemory(db);
    const selected = selectMeetings(db, teams, limit);
    const extracted = completedMeetings(db, "extract");
    const reconciled = completedMeetings(db, "reconcile");
    const needsExtraction = selected.filter(({ meeting_id }) => mode !== "reconcile" && !extracted.has(meeting_id));
    const needsReconciliation = selected.filter(({ meeting_id }) => mode !== "extract" && !reconciled.has(meeting_id));
    if (mode === "reconcile") {
      const missing = needsReconciliation.find(({ meeting_id }) => !extracted.has(meeting_id));
      if (missing) throw new Error(`${missing.meeting_id}: run extraction before reconciliation.`);
    }
    console.log(`${needsExtraction.length} meetings pending extraction, ${needsReconciliation.length} pending reconciliation for this run.`);
    if (!needsExtraction.length && !needsReconciliation.length) return;

    const apiKey = process.env.OPENROUTER_API_KEY;
    const models = readModels();
    const model = { extract: models.extract, reconcile: models.agent ?? models.extract };
    const stages = (["extract", "reconcile"] as const).filter((stage) => stage === "extract" ? needsExtraction.length : needsReconciliation.length);
    if (!apiKey || stages.some((stage) => !model[stage])) throw new Error("Set OPENROUTER_API_KEY and the stage model in .env.local.");
    const catalog = await getFreeModels();
    const available = new Map(catalog.map((entry) => [entry.id, entry.context_length]));
    const configured = [...new Set([...stages.map((stage) => model[stage]!), ...models.fallbacks])];
    const missing = configured.filter((id) => !available.get(id));
    if (missing.length) throw new Error(`Configured models unavailable: ${missing.join(", ")}. Run npm run models to select an available model.`);
    const context = needsExtraction.length ? Math.min(...[model.extract!, ...models.fallbacks].map((id) => available.get(id)!)) : 0;
    const client = createLlmClient({ apiKey, db, settings, fallbacks: models.fallbacks });
    const extractCalls = new Map(needsExtraction.map(({ meeting_id }) => [meeting_id,
      windowTurns(loadMeetingTurns(db, meeting_id), context, settings.extractInputTokens).length]));
    const reconcileIds = new Set(needsReconciliation.map(({ meeting_id }) => meeting_id));
    let pending = [...extractCalls.values()].reduce((sum, count) => sum + count, needsReconciliation.length);
    console.log(`${await client.remainingBudget()} requests available for ${pending} estimated completion calls.`);

    const byTeam = new Map<string, { meeting: Meeting; stage: Stage; calls: number }[]>();
    for (const meeting of selected) {
      const calls = extractCalls.get(meeting.meeting_id);
      const group = byTeam.get(meeting.team) ?? [];
      if (calls !== undefined) group.push({ meeting, stage: "extract", calls });
      if (reconcileIds.has(meeting.meeting_id)) group.push({ meeting, stage: "reconcile", calls: 1 });
      if (group.length) byTeam.set(meeting.team, group);
    }
    const groups = [...byTeam.values()];
    let next = 0;
    let failure: { error: unknown } | undefined;
    async function worker() {
      while (!failure && next < groups.length) {
        for (const { meeting, stage, calls } of groups[next++]) {
          if (failure) return;
          const options = { model: model[stage]!, context, maxInputTokens: settings.extractInputTokens, complete: client.complete,
            pendingCalls: Math.max(1, pending - calls + 1) };
          console.log(`${meeting.meeting_id}: ${stage} started.`);
          try {
            const result = stage === "extract" ? await extractMeeting(db, meeting, options) : await reconcileMeeting(db, meeting, options);
            pending -= calls;
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
