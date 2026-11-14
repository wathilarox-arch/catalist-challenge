import { z } from "zod";
import { openMemory } from "../lib/db";
import { createLlmClient, type LlmRequest } from "../lib/llm/client";
import { loadLocalEnv, readModels } from "../lib/llm/config";
import { completeJson } from "../lib/llm/json";

async function main() {
  loadLocalEnv();
  const { extract, fallbacks } = readModels();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!extract || !apiKey) throw new Error("Set MODEL_EXTRACT and OPENROUTER_API_KEY in .env.local.");
  const db = openMemory(undefined, { readonly: false });
  try {
    const request: LlmRequest = {
      model: extract, purpose: "smoke", temperature: 0, maxTokens: 128,
      messages: [{ role: "user", content: 'Return exactly this JSON object: {"pong":true}' }],
    };
    const schema = z.object({ pong: z.literal(true) });
    const client = createLlmClient({ apiKey, db, fallbacks });
    const first = await completeJson(client.complete, request, schema);
    const second = await completeJson(createLlmClient({ apiKey, db, fallbacks }).complete, request, schema);
    if (!second.response.cached) throw new Error("Expected a persistent cache hit on the second request.");
    console.log(`${first.response.model}: ${JSON.stringify(first.data)} (${first.response.cached ? "cache" : "live"}), followed by a SQLite cache hit.`);
    console.log(`${await client.remainingBudget()} free completion requests remaining today under the configured budget.`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "OpenRouter smoke test failed.");
  process.exitCode = 1;
});
