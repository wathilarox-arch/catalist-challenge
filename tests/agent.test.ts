import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { answerQuestion, type AgentStep } from "../lib/agent";
import { citationStore, indexMeetings, initializeMemory, openMemory, type MemoryDatabase } from "../lib/db";
import { validateCitation } from "../lib/citations";
import type { LlmRequest } from "../lib/llm/client";
import { parseTranscript } from "../lib/parse";

const model = "test/model:free";
const question = { question_id: "pilot", question: "What did TS3012 agree about the budget?" };
const evidence = { meeting_id: "TS3012a", turn_id: "TS3012a:0002", anchor: "twelve and a half Euros" };
const final = { action: "final", answer: "Speaker B agreed to budget €12.50.", evidence: [evidence] };
const search = { action: "search", query: "budget", meeting_seq: 1 };

let db: MemoryDatabase;
beforeEach(() => {
  db = openMemory(":memory:", { readonly: false });
  initializeMemory(db);
  indexMeetings(db, ["TS3012a", "TS3012d", "ES2003a"].map((id) => parseTranscript(
    `Meeting: ${id}\nTeam: ${id.slice(0, -1)}\n\n00:00:01 Speaker A\nSure.\n\n00:00:02 Speaker B\nWe agreed to budget twelve and a half Euros for the case.`,
  )));
  db.prepare(`INSERT INTO ledger VALUES
    ('budget', 1, 'TS3012', 'number', 'budget', 'earlier-budget', 'proposed', 1, NULL, '["TS3012a:0002"]', NULL, NULL),
    ('budget', 2, 'TS3012', 'number', 'budget', 'final-budget', 'agreed', 4, NULL, '["TS3012d:0002"]', 'budget@1', NULL)
  `).run();
});
afterEach(() => db.close());

function scripted(...actions: unknown[]) {
  return vi.fn(async (_request: LlmRequest) => {
    if (!actions.length) throw new Error("Unexpected model call");
    return { text: JSON.stringify(actions.shift()), model, cached: false, usage: { prompt_tokens: 12, completion_tokens: 6 } };
  });
}

it("retrieves source turns, parses numbers in code, and retries a short citation", async () => {
  const complete = scripted(search, { action: "numbers", meeting_id: "TS3012a" },
    { ...final, evidence: [{ ...evidence, turn_id: "TS3012a:0001", anchor: undefined }] }, final);
  const steps: AgentStep[] = [];
  const answer = await answerQuestion(db, question, { model, complete, onStep: (step) => steps.push(step) });

  expect(steps.map(({ action }) => action.action)).toEqual(["search", "numbers", "final", "final"]);
  expect(steps[0].turnIds).toEqual(["TS3012a:0002", "TS3012a:0001"]);
  expect(complete.mock.calls[2][0].messages.map(({ content }) => content).join("\n")).toContain('"value":12.5');
  expect(steps[2].feedback).toContain("turn_too_short");
  expect(complete.mock.calls[3][0].messages.map(({ content }) => content).join("\n")).toContain("turn_too_short");
  expect(answer.citations).toEqual([{ meeting_id: "TS3012a", quote: "We agreed to budget twelve and a half Euros for the case." }]);
  expect(validateCitation(answer.citations[0], citationStore(db))).toBe(true);
});

it("keeps later meetings and other teams out of tool results and final citations", async () => {
  const complete = scripted(
    { action: "read", meeting_id: "TS3012d", from_idx: 1, to_idx: 2 },
    { action: "numbers", meeting_id: "ES2003a" },
    { action: "read", meeting_id: "TS3012a", from_idx: 1, to_idx: 41 },
    { action: "read", meeting_id: "TS3012a", from_idx: 1, to_idx: 40 },
    { ...final, evidence: [{ meeting_id: "TS3012d", turn_id: "TS3012d:0002" }] }, final,
  );
  const steps: AgentStep[] = [];
  const answer = await answerQuestion(db, question, { model, complete, maxSeq: 3, onStep: (step) => steps.push(step) });
  const context = complete.mock.calls[0][0].messages[1].content;

  expect(context).toContain('"current":true');
  expect(context).not.toContain("final-budget");
  expect(steps.slice(0, 3).map(({ turnIds }) => turnIds)).toEqual([[], [], []]);
  expect(steps[2].feedback).toContain("up to 40 turns");
  expect(steps[4].feedback).toContain("turn_outside_scope_or_unretrieved");
  expect(answer.citations.map(({ meeting_id }) => meeting_id)).toEqual(["TS3012a"]);
});

it("counts JSON repairs against the six-call limit", async () => {
  const complete = scripted({ unexpected: true }, search, search, search, search, { unexpected: true });
  await expect(answerQuestion(db, question, { model, complete })).rejects.toThrow(/no calls left for repair/);
  expect(complete).toHaveBeenCalledTimes(6);
});

it("stops after two citation retries without returning an unverified answer", async () => {
  const complete = scripted(final, final, final);
  await expect(answerQuestion(db, question, { model, complete })).rejects.toThrow(/Citations still failed after two retries/);
  expect(complete).toHaveBeenCalledTimes(3);
});
