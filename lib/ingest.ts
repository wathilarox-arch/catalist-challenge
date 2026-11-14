import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MemoryDatabase } from "./db";
import { meetingSchema, teamIdSchema, turnSchema } from "./parse";

export type Stage = "extract" | "reconcile";

export function selectMeetings(db: MemoryDatabase, teams?: string[], limit?: number) {
  const questions = z.object({ questions: z.array(z.object({ team: teamIdSchema })) })
    .parse(JSON.parse(readFileSync("data/questions.json", "utf8")));
  const priority = new Set(["TS3012", ...questions.questions.map(({ team }) => team)]);
  const meetings = z.array(meetingSchema).parse(db.prepare("SELECT * FROM meetings ORDER BY team, seq").all());
  const unknown = teams?.filter((team) => !meetings.some((meeting) => meeting.team === team));
  if (unknown?.length) throw new Error(`No indexed meetings for ${unknown.join(", ")}.`);
  return meetings.filter(({ team }) => !teams || teams.includes(team))
    .sort((a, b) => Number(priority.has(b.team)) - Number(priority.has(a.team))).slice(0, limit);
}

export function loadMeetingTurns(db: MemoryDatabase, meetingId: string, fromIdx = 1, toIdx = Number.MAX_SAFE_INTEGER) {
  const rowSchema = turnSchema.extend({ citable: z.literal([0, 1]).transform(Boolean) });
  return z.array(rowSchema).parse(db.prepare(`
    SELECT * FROM turns WHERE meeting_id = ? AND idx BETWEEN ? AND ? ORDER BY idx
  `).all(meetingId, fromIdx, toIdx));
}

export function isComplete(db: MemoryDatabase, meetingId: string, stage: Stage) {
  return Boolean(db.prepare("SELECT 1 FROM ingestion WHERE meeting_id = ? AND stage = ?").get(meetingId, stage));
}

export function completedMeetings(db: MemoryDatabase, stage: Stage) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingestion'").get();
  if (!exists) return new Set<string>();
  return new Set(db.prepare<[Stage], string>("SELECT meeting_id FROM ingestion WHERE stage = ?").pluck().all(stage));
}

export function markComplete(db: MemoryDatabase, meetingId: string, stage: Stage) {
  db.prepare("INSERT INTO ingestion VALUES (?, ?, ?)").run(meetingId, stage, new Date().toISOString());
}
