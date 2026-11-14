import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { CitationStore } from "./citations";
import { type Meeting, type ParsedMeeting, type Turn, speakerSchema, sequenceSchema } from "./parse";

export const memoryPath = join(process.cwd(), "data", "memory.db");
export type MemoryDatabase = Database.Database;

const schema = `
CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 4),
  n_turns INTEGER NOT NULL,
  n_words INTEGER NOT NULL,
  UNIQUE (team, seq)
);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
  idx INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  start_sec INTEGER NOT NULL,
  text TEXT NOT NULL,
  n_words INTEGER NOT NULL,
  citable INTEGER NOT NULL CHECK(citable IN (0, 1)),
  UNIQUE (meeting_id, idx)
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text_clean, team, content='', tokenize="porter unicode61 tokenchars '_'"
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
  team TEXT NOT NULL,
  type TEXT NOT NULL,
  slot_hint TEXT NOT NULL,
  summary TEXT NOT NULL,
  speaker TEXT,
  turn_ids TEXT NOT NULL,
  value_raw TEXT,
  refers_back INTEGER NOT NULL CHECK(refers_back IN (0, 1)),
  refers_note TEXT
);
CREATE INDEX IF NOT EXISTS events_by_meeting ON events(meeting_id);
CREATE TABLE IF NOT EXISTS ledger (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  team TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot TEXT NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL,
  meeting_seq INTEGER NOT NULL,
  owner_speaker TEXT,
  evidence TEXT NOT NULL,
  supersedes TEXT,
  rationale TEXT,
  PRIMARY KEY (item_id, version),
  FOREIGN KEY (team, meeting_seq) REFERENCES meetings(team, seq)
);
CREATE INDEX IF NOT EXISTS ledger_by_team ON ledger(team, meeting_seq, item_id, version);
CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  prompt_tokens INT,
  completion_tokens INT,
  latency_ms INT NOT NULL,
  cached INT NOT NULL,
  status TEXT NOT NULL
);`;

export function openMemory(path = memoryPath, { readonly = true } = {}): MemoryDatabase {
  const db = new Database(path, { readonly, fileMustExist: readonly });
  db.pragma("foreign_keys = ON");
  return db;
}

export function initializeMemory(db: MemoryDatabase) {
  db.exec(schema);
}

export function indexMeetings(db: MemoryDatabase, transcripts: Iterable<ParsedMeeting>): number {
  const findMeeting = db.prepare<[string], Meeting>("SELECT * FROM meetings WHERE meeting_id = ?");
  const findTurns = db.prepare<[string], Omit<Turn, "citable"> & { citable: number }>(`
    SELECT * FROM turns WHERE meeting_id = ? ORDER BY idx
  `);
  const insertMeeting = db.prepare<Meeting>(`
    INSERT INTO meetings VALUES (@meeting_id, @team, @seq, @n_turns, @n_words)
  `);
  const insertTurn = db.prepare(`
    INSERT INTO turns (turn_id, meeting_id, idx, speaker, start_sec, text, n_words, citable)
    VALUES (@turn_id, @meeting_id, @idx, @speaker, @start_sec, @text, @n_words, @citable)
  `);
  const indexTurn = db.prepare("INSERT INTO turns_fts(rowid, text_clean, team) VALUES (?, ?, ?)");

  return db.transaction(() => {
    let indexed = 0;
    for (const { meeting, turns } of transcripts) {
      const existing = findMeeting.get(meeting.meeting_id);
      if (existing) {
        const persisted = findTurns.all(meeting.meeting_id);
        const unchanged = persisted.length === turns.length && persisted.every((turn, index) => {
          const incoming = turns[index];
          return turn.turn_id === incoming.turn_id && turn.text === incoming.text &&
            turn.start_sec === incoming.start_sec && turn.speaker === incoming.speaker;
        });
        if (!unchanged) throw new Error(`Transcript ${meeting.meeting_id} changed. Ingest into a fresh database to preserve existing evidence references.`);
        continue;
      }
      insertMeeting.run(meeting);
      for (const turn of turns) {
        const { lastInsertRowid } = insertTurn.run({ ...turn, citable: Number(turn.citable) });
        indexTurn.run(lastInsertRowid, turn.text_clean, meeting.team);
      }
      indexed++;
    }
    return indexed;
  }).immediate();
}

export function getCorpusStats(db: MemoryDatabase) {
  const row = db.prepare(`
    SELECT COUNT(*) AS meetings, COUNT(DISTINCT team) AS teams,
      COALESCE(SUM(n_turns), 0) AS turns, COALESCE(SUM(n_words), 0) AS words
    FROM meetings
  `).get();
  return z.object({ meetings: z.number(), teams: z.number(), turns: z.number(), words: z.number() }).parse(row);
}

export function citationStore(db: MemoryDatabase): CitationStore {
  const meeting = db.prepare<[string]>("SELECT 1 FROM meetings WHERE meeting_id = ?");
  const turn = db.prepare<[string], Pick<Turn, "meeting_id" | "text">>("SELECT meeting_id, text FROM turns WHERE turn_id = ?");
  const turns = db.prepare<[string], Pick<Turn, "meeting_id" | "text">>("SELECT meeting_id, text FROM turns WHERE meeting_id = ? ORDER BY idx");
  return {
    meetingExists: (id) => Boolean(meeting.get(id)),
    getTurn: (id) => turn.get(id),
    getMeetingTurns: (id) => turns.all(id),
  };
}

const ledgerEntrySchema = z.object({
  item_id: z.string().min(1),
  version: z.number().int().positive(),
  team: z.string(),
  kind: z.enum(["decision", "action", "disagreement", "number", "question"]),
  slot: z.string(),
  value: z.string(),
  status: z.enum(["proposed", "agreed", "rejected", "superseded", "open", "done", "dropped", "resolved"]),
  meeting_seq: sequenceSchema,
  owner_speaker: speakerSchema.nullable(),
  evidence: z.string().transform((text, ctx) => {
    try {
      return z.array(z.string().min(1)).min(1).parse(JSON.parse(text));
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid ledger evidence" });
      return z.NEVER;
    }
  }),
  supersedes: z.string().nullable(),
  rationale: z.string().nullable(),
});

export function getLedgerAsOf(db: MemoryDatabase, team: string, maxSeq: number, { history = false } = {}) {
  const rows = db.prepare(`
    WITH versions AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY version DESC) AS version_rank
      FROM ledger WHERE team = @team AND meeting_seq <= @maxSeq
    )
    SELECT * FROM versions WHERE @history OR version_rank = 1
    ORDER BY meeting_seq, slot, item_id, version
  `).all({ team, maxSeq, history: Number(history) });
  return z.array(ledgerEntrySchema).parse(rows);
}
