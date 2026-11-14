import { describe, expect, it } from "vitest";
import { resolveCitation, validateCitation, type CitationStore } from "../lib/citations";

const meetingId = "TS3012a";
const turns = [
  { meeting_id: meetingId, text: "Okay. We should use an L_C_D_\nfor this version." },
  { meeting_id: meetingId, text: "That still sounds too expensive for the team." },
  { meeting_id: meetingId, text: "I agree with that." },
  { meeting_id: "TS3012b", text: "This turn belongs to the second meeting." },
  { meeting_id: meetingId, text: "Before. " + "word ".repeat(40) + "anchor phrase here. After." },
];
const store: CitationStore = {
  meetingExists: (id) => turns.some((turn) => turn.meeting_id === id),
  getTurn: (id) => turns[Number(id)],
  getMeetingTurns: (id) => turns.filter((turn) => turn.meeting_id === id),
};

describe("validateCitation", () => {
  it.each([
    ["exact quote", "We should use an L_C_D_\nfor this version.", true],
    ["five words", "We should use an L_C_D_", false],
    ["cross-turn quote", "for this version. That still sounds", false],
    ["case and spacing differences", "we SHOULD use\t an L_c_d_ FOR this version.", true],
    ["altered word", "We could use an L_C_D_ for this version.", false],
    ["altered punctuation", "We should use an L_C_D_ for this version!", false],
  ])("checks %s", (_, quote, valid) => {
    expect(validateCitation({ meeting_id: meetingId, quote }, store)).toBe(valid);
  });

  it("rejects a missing meeting", () => {
    expect(validateCitation({ meeting_id: "TS3012z", quote: turns[0].text }, store)).toBe(false);
  });
});

describe("resolveCitation", () => {
  const evidence = { meeting_id: meetingId, turn_id: "0", anchor: "SHOULD use an" };

  it("prefers a sentence and copies raw whitespace and punctuation", () => {
    expect(resolveCitation(evidence, store)).toEqual({
      ok: true, citation: { meeting_id: meetingId, quote: "We should use an L_C_D_\nfor this version." },
    });
  });

  it("keeps an anchor late in a long turn within the 30-word limit", () => {
    const result = resolveCitation({ ...evidence, turn_id: "4", anchor: "anchor phrase here." }, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.citation.quote).toContain("anchor phrase here.");
    expect(result.citation.quote.split(/\s+/)).toHaveLength(30);
    expect(validateCitation(result.citation, store)).toBe(true);
  });

  it.each([
    ["0", "never said here", "anchor_not_found"],
    ["2", undefined, "turn_too_short"],
    ["3", undefined, "wrong_meeting"],
    ["12", undefined, "unknown_turn"],
  ])("rejects invalid evidence (%s, %s)", (turn_id, anchor, reason) => {
    expect(resolveCitation({ ...evidence, turn_id, anchor }, store)).toMatchObject({ ok: false, reason });
  });

  it("resolves a turn without an anchor", () => {
    const result = resolveCitation({ meeting_id: meetingId, turn_id: "1" }, store);
    expect(result).toEqual({ ok: true, citation: { meeting_id: meetingId, quote: turns[1].text } });
  });
});
