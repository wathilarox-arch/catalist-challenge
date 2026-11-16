import { z } from "zod";
import submission from "../answers.json";
import catalog from "../data/questions.json";
import { answerSchema, questionSchema } from "./agent";
import type { AskAnswer, SavedQuestion } from "./ask";
import type { Citation } from "./citations";
import { openMemory, type MemoryDatabase } from "./db";
import { loadMeetingTurns } from "./ingest";
import { teamIdSchema, type Turn } from "./parse";

const officialQuestions = questionSchema.extend({ team: teamIdSchema }).array().parse(catalog.questions);
const answers = new Map(answerSchema.array().parse(submission.answers).map((answer) => [answer.question_id, answer]));

export const savedQuestions: SavedQuestion[] = officialQuestions.map(({ question_id: id, team, question }) => {
  const answer = answers.get(id);
  if (!answer) throw new Error(`Saved answer missing for ${id}.`);
  return { id, team, question, answer: { text: answer.answer, citations: answer.citations } };
});

export function readAskTeams(db: MemoryDatabase) {
  return teamIdSchema.array().parse(db.prepare("SELECT DISTINCT team FROM meetings ORDER BY team").pluck().all());
}

export function transcriptContext(db: MemoryDatabase) {
  const meetings = new Map<string, Turn[]>();
  return ({ meeting_id, quote }: Citation) => {
    let turns = meetings.get(meeting_id);
    if (!turns) {
      turns = loadMeetingTurns(db, meeting_id);
      meetings.set(meeting_id, turns);
    }
    const pattern = quote.trim().split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const matchPattern = new RegExp(pattern, "iu");
    for (const [index, turn] of turns.entries()) {
      const match = matchPattern.exec(turn.text);
      if (!match) continue;
      return {
        turnId: turn.turn_id,
        speaker: turn.speaker,
        startSeconds: turn.start_sec,
        before: turns[index - 1]?.text,
        prefix: turn.text.slice(0, match.index),
        highlight: match[0],
        suffix: turn.text.slice(match.index + match[0].length),
        after: turns[index + 1]?.text,
      };
    }
  };
}

export function addCitationContext(answer: AskAnswer, context: ReturnType<typeof transcriptContext>): AskAnswer {
  return { ...answer, citations: answer.citations.map((citation) => ({ ...citation, context: context(citation) })) };
}

export function readAskPage() {
  let db: MemoryDatabase | undefined;
  try {
    db = openMemory();
    const teams = readAskTeams(db);
    const context = transcriptContext(db);
    const questions = savedQuestions.map((entry) => ({ ...entry, answer: addCitationContext(entry.answer, context) }));
    return { questions, teams };
  } catch {
    return { questions: savedQuestions, teams: [] };
  } finally {
    db?.close();
  }
}
