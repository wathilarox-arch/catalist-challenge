import { z } from "zod";
import type { MemoryDatabase } from "./db";
import { normalizeForSearch } from "./normalize";
import { meetingIdSchema, sequenceSchema, teamIdSchema, turnSchema, type Turn } from "./parse";

const optionsSchema = z.object({
  maxSeq: sequenceSchema.optional(),
  meetingId: meetingIdSchema.optional(),
  k: z.number().int().min(1).max(100),
});

const turnRowSchema = turnSchema.extend({ citable: z.literal([0, 1]).transform(Boolean) });
const hitRowSchema = turnRowSchema.extend({ score: z.number() });

export type TurnHit = Turn & { score: number; neighbours: Turn[] };

export interface Retriever {
  search(team: string, query: string, options: z.input<typeof optionsSchema>): TurnHit[];
}

export class FtsRetriever implements Retriever {
  constructor(private readonly db: MemoryDatabase) {}

  search(team: string, query: string, options: z.input<typeof optionsSchema>): TurnHit[] {
    teamIdSchema.parse(team);
    const { k, maxSeq, meetingId } = optionsSchema.parse(options);
    const words = [...new Set(normalizeForSearch(query).match(/[\p{L}\p{N}_]+/gu) ?? [])]
      .filter((word) => /[\p{L}\p{N}]/u.test(word))
      .slice(0, 32);
    if (words.length === 0) return [];

    // Constrain the candidate set in FTS itself; ignore the team column in scoring.
    const keywords = words.map((word) => `"${word}"*`).join(" OR ");
    const rows = this.db.prepare(`
      SELECT t.*, bm25(turns_fts, 1.0, 0.0) AS score
      FROM turns_fts JOIN turns t ON t.rowid = turns_fts.rowid
      JOIN meetings m ON m.meeting_id = t.meeting_id
      WHERE turns_fts MATCH @match AND m.team = @team AND m.seq <= @maxSeq
        AND (@meetingId IS NULL OR m.meeting_id = @meetingId)
      ORDER BY score, t.citable DESC, m.seq, t.idx LIMIT @k
    `).all({ match: `team : "${team}" AND text_clean : (${keywords})`, team, maxSeq: maxSeq ?? 4, meetingId: meetingId ?? null, k });

    const neighbourQuery = this.db.prepare(`
      SELECT * FROM turns WHERE meeting_id = @meetingId AND idx BETWEEN @idx - 1 AND @idx + 1
        AND idx <> @idx ORDER BY idx
    `);
    return z.array(hitRowSchema).parse(rows).map((hit) => ({
      ...hit,
      neighbours: z.array(turnRowSchema).parse(neighbourQuery.all({ meetingId: hit.meeting_id, idx: hit.idx })),
    }));
  }
}
