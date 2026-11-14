import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../lib/parse";

describe("parseTranscript", () => {
  it("keeps timestamps, repeated timestamps, words and internal line endings intact", () => {
    const parsed = parseTranscript([
      "\uFEFFMeeting : ES2002b", "Team: ES2002", "Meeting number: 2 (b)", "",
      "  00:01:09  Speaker\tA  ", "Um, this is for the L_C_D_.", "  On the next line.", "",
      "00:01:09 Speaker D", "Okay.", "",
    ].join("\r\n"), "ES2002b");
    expect(parsed.meeting).toMatchObject({ team: "ES2002", seq: 2, n_turns: 2, n_words: 11 });
    expect(parsed.turns[0]).toMatchObject({
      turn_id: "ES2002b:0001", start_sec: 69, speaker: "A", citable: true,
      text: "Um, this is for the L_C_D_.\r\n  On the next line.",
      text_clean: ", this is for the l_c_d_ lcd. on the next line.",
    });
    expect(parsed.turns[1]).toMatchObject({ turn_id: "ES2002b:0002", start_sec: 69, speaker: "D", citable: false });
  });

  it("parses all 48,148 original turns and preserves incomplete team sequences", () => {
    const directory = join(process.cwd(), "data", "transcripts");
    const files = readdirSync(directory).filter((file) => file.endsWith(".txt")).sort();
    let total = 0;
    const teams = new Map<string, number[]>();
    for (const file of files) {
      const raw = readFileSync(join(directory, file), "utf8");
      const { meeting, turns } = parseTranscript(raw, file.slice(0, -4));
      const sourceHeaders = raw.split(/\r?\n/).filter((line) => /\d\d:\d\d:\d\d\s+Speaker [A-D]\s*$/.test(line));
      expect(turns).toHaveLength(sourceHeaders.length);
      total += turns.length;
      teams.set(meeting.team, [...(teams.get(meeting.team) ?? []), meeting.seq]);
    }
    expect(files).toHaveLength(138);
    expect(teams.size).toBe(35);
    expect(total).toBe(48148);
    expect(teams.get("IS1002")).toEqual([2, 3, 4]);
    expect(teams.get("IS1005")).toEqual([1, 2, 3]);
  }, 60_000);
});
