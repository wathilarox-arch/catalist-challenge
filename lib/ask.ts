import type { Citation } from "./citations";

export type CitationContext = {
  turnId: string;
  speaker: string;
  startSeconds: number;
  before?: string;
  prefix: string;
  highlight: string;
  suffix: string;
  after?: string;
};

export type AskAnswer = {
  text: string;
  citations: (Citation & { context?: CitationContext })[];
};

export type SavedQuestion = {
  id: string;
  team: string;
  question: string;
  answer: AskAnswer;
};

export type AskEvent =
  | { type: "step"; step: number; action: "search" | "read" | "numbers" | "final"; turns: number }
  | { type: "answer"; answer: AskAnswer; source: "saved" | "cached" | "live" }
  | { type: "error"; code: string; message: string };

export const maxQuestionLength = 2000;

export function normalizeQuestion(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function matchSavedQuestion(questions: readonly SavedQuestion[], question: string, team?: string) {
  const normalized = normalizeQuestion(question);
  return questions.find((entry) => (!team || entry.team === team) && normalizeQuestion(entry.question) === normalized);
}
