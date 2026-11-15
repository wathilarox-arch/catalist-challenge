import { existsSync } from "node:fs";
import { z } from "zod";

export const freeModelSchema = z.string().trim().regex(/^[\w.-]+\/[\w.-]+:free$/, "Expected an OpenRouter :free model ID");

const optionalSetting = (value: string | undefined) => value?.trim() || undefined;
const settingsSchema = z.object({
  rpm: z.coerce.number().int().min(1).max(20).default(15),
  concurrency: z.coerce.number().int().min(1).max(20).default(1),
  dailyBudget: z.coerce.number().int().nonnegative().optional(),
  disableReasoning: z.stringbool().optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  extractInputTokens: z.coerce.number().int().min(1024).optional(),
  extractOutputTokens: z.coerce.number().int().min(1024).max(32768).optional(),
  reconcileOutputTokens: z.coerce.number().int().min(1024).max(32768).optional(),
  agentOutputTokens: z.coerce.number().int().min(1024).max(32768).optional(),
  briefOutputTokens: z.coerce.number().int().min(1024).max(32768).optional(),
});

export function loadLocalEnv() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
}

export function readLlmSettings(env = process.env) {
  return settingsSchema.parse({
    rpm: optionalSetting(env.LLM_RPM),
    concurrency: optionalSetting(env.LLM_CONCURRENCY),
    dailyBudget: optionalSetting(env.DAILY_REQUEST_BUDGET),
    disableReasoning: optionalSetting(env.LLM_DISABLE_REASONING),
    reasoningEffort: optionalSetting(env.LLM_REASONING_EFFORT),
    extractInputTokens: optionalSetting(env.LLM_EXTRACT_INPUT_TOKENS),
    extractOutputTokens: optionalSetting(env.LLM_EXTRACT_OUTPUT_TOKENS),
    reconcileOutputTokens: optionalSetting(env.LLM_RECONCILE_OUTPUT_TOKENS),
    agentOutputTokens: optionalSetting(env.LLM_AGENT_OUTPUT_TOKENS),
    briefOutputTokens: optionalSetting(env.LLM_BRIEF_OUTPUT_TOKENS),
  });
}

export function readModels(env = process.env) {
  const primary = optionalSetting(env.OPENROUTER_MODEL);
  const fallback = optionalSetting(env.MODEL_FALLBACKS ?? env.OPENROUTER_FALLBACK_MODELS);
  return {
    extract: freeModelSchema.optional().parse(optionalSetting(env.MODEL_EXTRACT) ?? primary),
    agent: freeModelSchema.optional().parse(optionalSetting(env.MODEL_AGENT) ?? primary),
    fallbacks: z.array(freeModelSchema).parse(fallback?.split(",") ?? []),
  };
}
