import { z } from "zod";

export const openRouterUrl = "https://openrouter.ai/api/v1";

const modelSchema = z.object({
  id: z.string(),
  context_length: z.number().int().nonnegative().nullable(),
  supported_parameters: z.array(z.string()),
});

const quotaSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});

export type FreeQuota = z.infer<typeof quotaSchema>;

async function readEndpoint(path: string, fetcher: typeof fetch, apiKey?: string): Promise<unknown> {
  const response = await fetcher(`${openRouterUrl}/${path}`, {
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error(`Could not reach OpenRouter /${path}. Check network connectivity and retry.`); });
  if (!response.ok) throw new Error(`OpenRouter /${path} returned HTTP ${response.status}.`);
  return response.json();
}

export async function getFreeModels(fetcher = fetch) {
  const response = await readEndpoint("models", fetcher);
  return z.object({ data: z.array(modelSchema) }).parse(response).data
    .filter(({ id }) => id.endsWith(":free"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getFreeQuota(apiKey: string, fetcher = fetch): Promise<FreeQuota> {
  const response = await readEndpoint("key", fetcher, apiKey);
  const result = z.object({ data: z.object({ free_model_daily_requests: quotaSchema }) }).safeParse(response);
  if (!result.success) throw new Error("OpenRouter /key did not report the remaining free-model quota.");
  return result.data.data.free_model_daily_requests;
}

export async function getAvailableFreeQuota(apiKeys: readonly string[]) {
  let firstQuota: FreeQuota | undefined;
  let firstError: unknown;
  for (const apiKey of apiKeys) {
    try {
      const quota = await getFreeQuota(apiKey);
      if (quota.remaining > 0) return quota;
      firstQuota ??= quota;
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  if (!firstQuota) throw new Error("Set an OpenRouter API key in .env.local.");
  return firstQuota;
}
