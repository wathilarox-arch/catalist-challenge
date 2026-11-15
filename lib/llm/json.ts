import { z } from "zod";
import { type Complete, type LlmRequest, stripThinking } from "./client";

export function firstJsonObject(text: string): string {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (depth === 0) {
      if (char === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("No complete JSON object found.");
}

export async function completeJson<T>(complete: Complete, request: LlmRequest, schema: z.ZodType<T>, { canRepair = true } = {}) {
  const parse = (text: string): T => {
    let value: unknown;
    try {
      value = JSON.parse(firstJsonObject(stripThinking(text)));
    } catch {
      throw new Error("Expected one complete, valid JSON object.");
    }
    const checked = schema.safeParse(value);
    if (!checked.success) {
      throw new Error(checked.error.issues.slice(0, 6).map((issue) =>
        `${issue.path.join(".") || "root"}: ${issue.message}`,
      ).join("\n"));
    }
    return checked.data;
  };

  const first = await complete(request);
  try {
    return { data: parse(first.text), response: first, repaired: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid object.";
    if (!canRepair) {
      first.discard?.();
      throw new Error(`JSON validation failed with no calls left for repair (${request.purpose}): ${detail}`);
    }
    const second = await complete({
      ...request, model: first.model, purpose: `${request.purpose}:repair`,
      messages: [...request.messages, { role: "assistant", content: first.text }, {
        role: "user", content: `Your previous response did not validate. Return one corrected JSON object only.\n${detail}`,
      }],
    });
    try {
      return { data: parse(second.text), response: second, repaired: true };
    } catch (repairError) {
      first.discard?.();
      second.discard?.();
      const detail = repairError instanceof Error ? repairError.message : "Invalid object.";
      throw new Error(`JSON validation still failed after one repair (${request.purpose}): ${detail}`);
    }
  }
}
