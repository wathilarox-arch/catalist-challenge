import { z } from "zod";

export const citationSchema = z.object({
  meeting_id: z.string().min(1),
  quote: z.string().min(1),
});

export const evidenceSchema = z.object({
  meeting_id: z.string().min(1),
  turn_id: z.string().min(1),
  anchor: z.string().trim().min(1).optional(),
});

export type Citation = z.infer<typeof citationSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
type CitationTurn = { meeting_id: string; text: string };

export interface CitationStore {
  meetingExists(meetingId: string): boolean;
  getTurn(turnId: string): CitationTurn | undefined;
  getMeetingTurns(meetingId: string): readonly CitationTurn[];
}

export function normalizeQuote(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function validateCitation(citation: Citation, store: CitationStore): boolean {
  const quote = normalizeQuote(citation.quote);
  return (
    quote.split(" ").length >= 6 &&
    store.meetingExists(citation.meeting_id) &&
    store.getMeetingTurns(citation.meeting_id).some((turn) => normalizeQuote(turn.text).includes(quote))
  );
}

type CitationResult =
  | { ok: true; citation: Citation }
  | { ok: false; reason: "unknown_meeting" | "unknown_turn" | "wrong_meeting" | "turn_too_short" | "anchor_not_found"; evidence: Evidence };

export function resolveCitation(evidence: Evidence, store: CitationStore): CitationResult {
  const reject = (reason: Extract<CitationResult, { ok: false }>["reason"]): CitationResult =>
    ({ ok: false, reason, evidence });

  if (!store.meetingExists(evidence.meeting_id)) return reject("unknown_meeting");
  const turn = store.getTurn(evidence.turn_id);
  if (!turn) return reject("unknown_turn");
  if (turn.meeting_id !== evidence.meeting_id) return reject("wrong_meeting");

  const words = [...turn.text.matchAll(/\S+/g)];
  if (words.length < 6) return reject("turn_too_short");

  let anchorStart = 0;
  let anchorEnd = 1;
  if (evidence.anchor) {
    const phrase = evidence.anchor.trim().split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const match = new RegExp(`(?<![\\p{L}\\p{N}_])${phrase}(?![\\p{L}\\p{N}_])`, "iu").exec(turn.text);
    if (!match) return reject("anchor_not_found");
    anchorStart = words.findIndex((word) => word.index + word[0].length > match.index);
    const nextWord = words.findIndex((word) => word.index >= match.index + match[0].length);
    anchorEnd = nextWord < 0 ? words.length : nextWord;
    if (anchorEnd - anchorStart > 30) return reject("anchor_not_found");
  }
  const sentenceEnd = (index: number) => /[.!?]["')\]]*$/.test(words[index][0]);

  let start = anchorStart;
  while (start > 0 && anchorEnd - start < 30 && !sentenceEnd(start - 1)) start--;
  let end = anchorEnd;
  while (end < words.length && end - start < 30 && !sentenceEnd(end - 1)) end++;

  // Add surrounding words when the selected sentence is too short to cite.
  end = Math.min(words.length, Math.max(end, start + 6));
  start = Math.min(start, end - 6);
  const last = words[end - 1];
  return {
    ok: true,
    citation: {
      meeting_id: turn.meeting_id,
      quote: turn.text.slice(words[start].index, last.index + last[0].length),
    },
  };
}
