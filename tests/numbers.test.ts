import { describe, expect, it } from "vitest";
import { parseSpokenNumbers } from "../lib/numbers";

describe("parseSpokenNumbers", () => {
  it.each([
    ["twelve and a half Euros", 12.5, "EUR"], ["twelve fifty euros", 12.50, "EUR"],
    ["fifteen Euros", 15, "EUR"], ["two point five", 2.5, undefined],
    ["a hundred and fifty", 150, undefined], ["1,250.25", 1250.25, undefined],
    ["€12.50", 12.5, "EUR"], ["twenty-five per cent", 25, "%"],
    ["ninety-nine percent", 99, "%"], ["minus two point zero five", -2.05, undefined],
    ["a quarter", 0.25, undefined], ["fifty-five mm", 55, "mm"],
  ])("parses %s", (raw, value, unit) => {
    expect(parseSpokenNumbers(raw)).toEqual([{ raw, value, ...(unit ? { unit } : {}), confidence: "high" }]);
  });

  it("marks inferred monetary shorthand as ambiguous", () => {
    expect(parseSpokenNumbers("The price was twelve fifty.")).toEqual([
      { raw: "twelve fifty", value: 12.5, confidence: "low" },
    ]);
  });

  it("keeps shorthand apart without a monetary cue", () => {
    expect(parseSpokenNumbers("It was twelve fifty.")).toEqual([
      { raw: "twelve", value: 12, confidence: "low" }, { raw: "fifty", value: 50, confidence: "high" },
    ]);
  });

  it("reads multiple numbers without crossing punctuation", () => {
    expect(parseSpokenNumbers("Twelve, fifty, or 8-10.").map(({ value }) => value)).toEqual([12, 50, 8, 10]);
    expect(parseSpokenNumbers("the current decision")).toEqual([]);
  });
});
