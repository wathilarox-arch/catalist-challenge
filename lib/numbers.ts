import { z } from "zod";

export const spokenNumberSchema = z.object({
  value: z.number(),
  raw: z.string(),
  unit: z.enum(["EUR", "GBP", "USD", "%", "cents", "mm", "cm", "g", "kg", "years", "hours", "minutes", "seconds"]).optional(),
  confidence: z.enum(["high", "low"]),
});

type SpokenNumber = z.infer<typeof spokenNumberSchema>;
type Unit = NonNullable<SpokenNumber["unit"]>;
type Token = { word: string; start: number; end: number };

const small = new Map("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ").map((word, index) => [word, index]));
const tens = new Map("twenty thirty forty fifty sixty seventy eighty ninety".split(" ").map((word, index) => [word, (index + 2) * 10]));
const fraction = new Map([["half", 0.5], ["quarter", 0.25]]);
const units: ReadonlyMap<string, Unit> = new Map([
  ["euro", "EUR"], ["euros", "EUR"], ["eur", "EUR"], ["€", "EUR"],
  ["dollar", "USD"], ["dollars", "USD"], ["usd", "USD"], ["$", "USD"],
  ["pound", "GBP"], ["pounds", "GBP"], ["gbp", "GBP"], ["£", "GBP"],
  ["cent", "cents"], ["cents", "cents"], ["percent", "%"], ["%", "%"],
  ["mm", "mm"], ["millimetres", "mm"], ["millimeters", "mm"],
  ["cm", "cm"], ["centimetres", "cm"], ["centimeters", "cm"],
  ["g", "g"], ["grams", "g"], ["kg", "kg"], ["kilograms", "kg"],
  ["year", "years"], ["years", "years"], ["hour", "hours"], ["hours", "hours"],
  ["minute", "minutes"], ["minutes", "minutes"], ["second", "seconds"], ["seconds", "seconds"],
]);

const isCurrency = (unit: Unit | undefined) => unit === "EUR" || unit === "USD" || unit === "GBP";

function readPair(tokens: Token[], start: number): { value: number; end: number } | undefined {
  const head = tokens[start]?.word;
  const tensValue = tens.get(head);
  if (tensValue !== undefined) {
    const ones = small.get(tokens[start + 1]?.word);
    return ones && ones < 10 ? { value: tensValue + ones, end: start + 2 } : { value: tensValue, end: start + 1 };
  }
  const value = small.get(head);
  return value === undefined ? undefined : { value, end: start + 1 };
}

export function parseSpokenNumbers(text: string): SpokenNumber[] {
  const tokens = [...text.matchAll(/(?:(?<!\d)[-+])?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[a-z]+|[€$£%]|[^\s-]/gi)]
    .map((match) => ({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length }));
  const numbers: SpokenNumber[] = [];
  const word = (index: number) => tokens[index]?.word;
  // An unlabelled monetary shorthand can only be inferred from context, so mark it low confidence.
  const moneyContext = /\b(?:costs?|price|budget|retail|euros?|cents?|dollars?|pounds?)\b|[€$£]/i.test(text);

  for (let start = 0; start < tokens.length;) {
    let head = start;
    const prefixUnit = /^[€$£]$/.test(word(head)) ? units.get(word(head++)) : undefined;
    const sign = word(head) === "minus" || word(head) === "negative" ? -1 : 1;
    if (sign < 0) head++;
    const first = word(head);
    const digits = /^[-+]?\d/.test(first ?? "") ? Number(first.replaceAll(",", "")) : undefined;
    const pair = readPair(tokens, head);
    const scale = word(head + 1) === "hundred" ? 100 : word(head + 1) === "thousand" ? 1000 : undefined;
    let value = digits ?? pair?.value;
    let end = digits === undefined ? (pair?.end ?? head) : head + 1;
    let confidence: SpokenNumber["confidence"] = "high";

    if (scale && (first === "a" || first === "one" || (pair?.end === head + 1 && pair.value > 0))) {
      const group = head + 2 + Number(word(head + 2) === "and");
      const remainder = readPair(tokens, group);
      value = (pair?.value ?? 1) * scale + (remainder?.value ?? 0);
      end = remainder?.end ?? head + 2;
    } else if (first === "a" && fraction.has(word(head + 1))) {
      value = fraction.get(word(head + 1));
      end = head + 2;
    }

    if (value === undefined || !Number.isFinite(value)) {
      start++;
      continue;
    }

    if (word(end) === "and" && word(end + 1) === "a" && fraction.has(word(end + 2))) {
      value += fraction.get(word(end + 2))!;
      end += 3;
    } else if (word(end) === "point") {
      let cursor = end + 1;
      let decimal = "";
      while (cursor < tokens.length) {
        const digit = small.get(word(cursor));
        if (digit !== undefined && digit < 10) decimal += digit;
        else if (/^\d+$/.test(word(cursor))) decimal += word(cursor);
        else break;
        cursor++;
      }
      if (decimal) {
        value += Number(`0.${decimal}`);
        end = cursor;
      }
    } else if (pair?.end === end && value >= 10) {
      const cents = readPair(tokens, end);
      if (cents && cents.value >= 10) {
        const shorthandUnit = units.get(word(cents.end));
        const explicitCurrency = isCurrency(prefixUnit) || isCurrency(shorthandUnit);
        if (explicitCurrency || (moneyContext && !shorthandUnit)) {
          value += cents.value / 100;
          end = cents.end;
          if (!explicitCurrency) confidence = "low";
        } else {
          confidence = "low";
        }
      }
    }

    const suffixUnit = units.get(word(end));
    let unit = prefixUnit ?? suffixUnit;
    if (suffixUnit && (!prefixUnit || suffixUnit === prefixUnit)) end++;
    if (word(end) === "per" && word(end + 1) === "cent" && !unit) {
      end += 2;
      unit = "%";
    }
    numbers.push({ value: sign * value, ...(unit ? { unit } : {}), raw: text.slice(tokens[start].start, tokens[end - 1].end), confidence });
    start = end;
  }
  return numbers;
}
