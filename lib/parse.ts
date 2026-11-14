import { z } from "zod";
import { normalizeForSearch } from "./normalize";

export const teamIdSchema = z.string().regex(/^[A-Z]{2}\d{4}$/);
export const meetingIdSchema = z.string().regex(/^[A-Z]{2}\d{4}[a-d]$/);
export const speakerSchema = z.enum(["A", "B", "C", "D"]);
export const sequenceSchema = z.number().int().min(1).max(4);

export const turnSchema = z.object({
  turn_id: z.string(),
  meeting_id: meetingIdSchema,
  idx: z.number().int().positive(),
  speaker: speakerSchema,
  start_sec: z.number().int().nonnegative(),
  text: z.string().min(1),
  n_words: z.number().int().positive(),
  citable: z.boolean(),
});

export const meetingSchema = z.object({
  meeting_id: meetingIdSchema,
  team: teamIdSchema,
  seq: sequenceSchema,
  n_turns: z.number().int().positive(),
  n_words: z.number().int().positive(),
});

export type Turn = z.infer<typeof turnSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type ParsedMeeting = { meeting: Meeting; turns: (Turn & { text_clean: string })[] };

export function parseTranscript(raw: string, expectedMeetingId?: string): ParsedMeeting {
  // Horizontal whitespace only, so the turn header cannot swallow any of the speech.
  const headers = [...raw.matchAll(/^[\t ]*(\d{2}):([0-5]\d):([0-5]\d)[\t ]+Speaker[\t ]+(\S+?)[\t ]*\r?$/gm)];
  const header = raw.slice(0, headers[0]?.index);
  const meetingId = meetingIdSchema.parse(header.match(/^[\t \uFEFF]*Meeting[\t ]*:[\t ]*(\S+)/m)?.[1]);
  const team = teamIdSchema.parse(header.match(/^[\t ]*Team[\t ]*:[\t ]*(\S+)/m)?.[1]);
  const seq = meetingId.charCodeAt(meetingId.length - 1) - 96;
  const declaredNumber = header.match(/^[\t ]*Meeting number[\t ]*:[\t ]*(\d+)[\t ]*\(([a-d])\)/m);
  if (team !== meetingId.slice(0, -1) || (expectedMeetingId && meetingId !== expectedMeetingId) ||
    (declaredNumber && (Number(declaredNumber[1]) !== seq || !meetingId.endsWith(declaredNumber[2])))) {
    throw new Error(`Inconsistent meeting metadata for ${expectedMeetingId ?? meetingId}`);
  }
  if (!headers.length) throw new Error(`No speaker turns found in ${meetingId}`);

  const turns = headers.map((match, index) => {
    const idx = index + 1;
    const text = raw.slice(match.index + match[0].length, headers[index + 1]?.index).trim();
    const nWords = text ? text.split(/\s+/).length : 0;
    const turn = turnSchema.parse({
      turn_id: `${meetingId}:${String(idx).padStart(4, "0")}`,
      meeting_id: meetingId,
      idx,
      speaker: match[4],
      start_sec: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
      text,
      n_words: nWords,
      citable: nWords >= 6,
    });
    return { ...turn, text_clean: normalizeForSearch(text) };
  });

  const meeting = meetingSchema.parse({
    meeting_id: meetingId,
    team,
    seq,
    n_turns: turns.length,
    n_words: turns.reduce((total, turn) => total + turn.n_words, 0),
  });
  return { meeting, turns };
}
