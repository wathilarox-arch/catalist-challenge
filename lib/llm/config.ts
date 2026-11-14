import { existsSync } from "node:fs";
import { z } from "zod";

export const freeModelSchema = z.string().trim().regex(/^[\w.-]+\/[\w.-]+:free$/, "Expected an OpenRouter :free model ID");

const optionalSetting = (value: string | undefined) => value?.trim() || undefined;
const settingsSchema = z.object({
  rpm: z.coerce.number().int().min(1).max(20).default(15),
  concurrency: z.coerce.number().int().min(1).max(20).default(1),
  dailyBudget: z.coerce.number().int().nonnegative().optional(),
  disableReasoning: z.stringbool().optional(),
  extractInputTokens: z.coerce.number().int().min(1024).optional(),
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
    extractInputTokens: optionalSetting(env.LLM_EXTRACT_INPUT_TOKENS),
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
