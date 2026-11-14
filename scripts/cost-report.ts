import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { openMemory } from "../lib/db";
import { completedMeetings } from "../lib/ingest";
import { loadLocalEnv, readLlmSettings, readModels } from "../lib/llm/config";
import { getFreeQuota } from "../lib/llm/openrouter";
import { callSummary, readCalls } from "../lib/llm/report";

const price = z.object({ input_usd_per_million: z.number().nonnegative(), output_usd_per_million: z.number().nonnegative() });
const pricesSchema = z.object({ models: z.record(z.string(), price) });
const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

async function main() {
  loadLocalEnv();
  const { values } = parseArgs({ options: { "live-quota": { type: "boolean" } } });
  const settings = readLlmSettings();
  const models = readModels();
  const prices = pricesSchema.parse(JSON.parse(readFileSync("config/prices.json", "utf8"))).models;
  const db = openMemory();
  try {
    const calls = readCalls(db);
    console.log(["# Meeting Memory cost report", "", "## Free tier as run", "", ...callSummary(calls, models), ""].join("\n"));

    const stages = (["extract", "reconcile"] as const).map((stage) => {
      const completed = completedMeetings(db, stage).size;
      const attempts = calls.filter(({ purpose, cached }) => !cached && (purpose === stage || purpose === `${stage}:repair`));
      const usage = attempts.filter(({ prompt_tokens, completion_tokens }) => prompt_tokens !== null && completion_tokens !== null);
      const input = usage.reduce((sum, call) => sum + call.prompt_tokens!, 0);
      const output = usage.reduce((sum, call) => sum + call.completion_tokens!, 0);
      console.log(`- ${stage}: ${completed} completed meetings, ${attempts.length} live attempts, ${number(input)} input and ${number(output)} output tokens (${usage.length}/${attempts.length} attempts with usage).`);
      if (completed) console.log(`  Observed per completed meeting: ${number(input / completed)} input, ${number(output / completed)} output, ${number(attempts.length / completed)} live attempts.`);
      let usd = 0;
      const unpriced = new Set<string>();
      for (const call of usage) {
        const rates = prices[call.model];
        if (!rates) unpriced.add(call.model);
        else usd += (call.prompt_tokens! * rates.input_usd_per_million + call.completion_tokens! * rates.output_usd_per_million) / 1_000_000;
      }
      return { completed, attempts, usage, input, output, usd, unpriced };
    });

    console.log("\n## Projection for 1,000 meetings\n");
    if (stages.some(({ completed, usage }) => !completed || !usage.length)) {
      console.log("Projection pending recorded usage and completed meetings for both stages.");
      return;
    }
    const project = (read: (stage: typeof stages[number]) => number) => stages.reduce((total, stage) => total + read(stage) * 1000 / stage.completed, 0);
    const requests = Math.ceil(project(({ attempts }) => attempts.length));
    const latencyMs = project(({ attempts }) => attempts.reduce((sum, call) => sum + call.latency_ms, 0));
    const pacingMinutes = requests / settings.rpm;
    const computeMinutes = latencyMs / (settings.concurrency * 60_000);
    console.log(`- ${number(project(({ input }) => input))} input tokens and ${number(project(({ output }) => output))} output tokens with observed usage coverage.`);
    console.log(`- ${number(requests)} live attempts using the observed retry and repair overhead.`);
    console.log(`- About ${number(Math.max(pacingMinutes, computeMinutes))} minutes of active wall-clock time at ${settings.rpm} RPM and concurrency ${settings.concurrency}. The estimate takes the larger of pacing (${number(pacingMinutes)} min) and observed latency divided by concurrency (${number(computeMinutes)} min). Quota resets and retry waits add time.`);
    if (values["live-quota"]) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("Set OPENROUTER_API_KEY to look up live quota.");
      const quota = await getFreeQuota(apiKey);
      const cap = Math.min(quota.limit, settings.dailyBudget ?? Infinity);
      const localUsed = db.prepare<[string], number>("SELECT COUNT(*) FROM llm_calls WHERE cached = 0 AND ts >= ?").pluck()
        .get(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) ?? 0;
      const remaining = Math.min(quota.remaining, Math.max(0, (settings.dailyBudget ?? Infinity) - localUsed));
      const days = cap ? 1 + Math.ceil(Math.max(0, requests - remaining) / cap) : Infinity;
      console.log(`- Live quota: ${remaining} requests remaining under the ${cap}/day effective cap. ${Number.isFinite(days) ? `${days} UTC quota day(s) including today.` : "Daily cap prevents live calls."}`);
    } else {
      console.log(`- At the plan's example quotas of 50 and 1,000 requests/day, this takes ${Math.ceil(requests / 50)} and ${Math.ceil(requests / 1000)} full quota days respectively. Use --live-quota for the account's current limit.`);
    }
    const unpriced = [...new Set(stages.flatMap(({ unpriced }) => [...unpriced]))];
    console.log(`- Paid equivalent: ${unpriced.length ? `pending prices for ${unpriced.join(", ")} in config/prices.json.` : `$${project(({ usd }) => usd).toFixed(2)} USD for observed usage.`}`);
    console.log("\nThe historical log covers retries and partial work. This extrapolation uses observed stage totals divided by completed meetings. Calls without provider token counts contribute to the attempt estimate, and their token costs are unknown.");
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
