import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { answerQuestion, maxAgentCalls, questionSchema, type Answer } from "../lib/agent";
import { validateCitation } from "../lib/citations";
import { citationStore, openMemory } from "../lib/db";
import { completedMeetings } from "../lib/ingest";
import { createLlmClient, DailyBudgetError } from "../lib/llm/client";
import { loadLocalEnv, readModels, readOpenRouterKeys } from "../lib/llm/config";
import { callSummary, percent, readCalls } from "../lib/llm/report";
import { teamIdSchema } from "../lib/parse";

const goldQuestion = questionSchema.extend({
  team: teamIdSchema,
  gold_answer: z.string(),
  gold_evidence: z.array(z.string().regex(/^[A-Z]{2}\d{4}[a-d]:\d{4,}$/)),
  manual_grade: z.enum(["correct", "partial", "incorrect"]).nullable(),
  review_notes: z.string(),
});
type Gold = z.infer<typeof goldQuestion>;
type Result = {
  question: Gold;
  seen: Set<string>;
  reconciled: string;
  answer?: Answer;
  valid?: number;
  failure?: string;
  paused?: boolean;
};

const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");

function render(results: Result[], metrics: string[]) {
  const answered = results.filter(({ answer }) => answer);
  const attempted = results.filter(({ answer, failure, paused }) => answer || (failure && !paused));
  const recall = attempted.flatMap(({ question, seen }) => [...new Set(question.gold_evidence)].map((id) => seen.has(id)));
  const graded = answered.filter(({ question }) => question.manual_grade !== null);
  const citations = answered.reduce((sum, { answer }) => sum + answer!.citations.length, 0);
  const valid = answered.reduce((sum, result) => sum + result.valid!, 0);
  const rows = results.map(({ question, answer, seen, valid, failure, paused, reconciled }) => {
    const expected = [...new Set(question.gold_evidence)];
    return `| ${[question.question_id, question.team, question.question, reconciled,
      answer ? "Answered" : paused ? "Paused" : failure ? "Failed" : "Pending",
      answer ? `${valid}/${answer.citations.length}` : "—",
      answer || (failure && !paused) ? percent(expected.filter((id) => seen.has(id)).length, expected.length) : "Pending",
      answer ? question.manual_grade ?? "Pending" : "Pending"].map(cell).join(" | ")} |`;
  });
  const failures = results.flatMap(({ question, answer, seen, valid, failure, paused }) => {
    if (failure && !paused) return [{ rank: 5, id: question.question_id, detail: failure }];
    if (!answer) return [];
    const missing = [...new Set(question.gold_evidence)].filter((id) => !seen.has(id));
    const details: string[] = [];
    if (valid !== answer.citations.length) details.push(`${answer.citations.length - valid!} emitted citation(s) failed validation.`);
    if (missing.length) details.push(`Retrieval omitted verified gold turns ${missing.join(", ")}.`);
    if (question.manual_grade === "incorrect" || question.manual_grade === "partial") details.push(`Manual grade is ${question.manual_grade}. ${question.review_notes || "Root cause pending manual review."}`);
    const rank = valid !== answer.citations.length ? 4 : question.manual_grade === "incorrect" ? 3 : missing.length ? 2 : 1;
    return details.length ? [{ rank, id: question.question_id, detail: details.join(" ") }] : [];
  }).sort((a, b) => b.rank - a.rank).slice(0, 3);

  const records = results.flatMap(({ question, answer, seen, failure }) => {
    if (!answer && !failure) return [];
    return [`### ${question.question_id}`, "", answer?.answer ?? failure!, "",
      ...answer?.citations.map(({ meeting_id, quote }) => `- ${meeting_id} · ${quote.replace(/\s+/g, " ")}`) ?? [],
      "", `Retrieved turn IDs · ${[...seen].join(", ") || "none"}`, ""];
  });

  return ["# Meeting Memory evaluation", "",
    `- Answers produced: ${answered.length}/${results.length}.`,
    `- Citation-valid rate among emitted citations: ${percent(valid, citations)}.`,
    `- Retrieval recall across verified gold turn IDs for completed attempts: ${percent(recall.filter(Boolean).length, recall.length)}.`,
    `- Answer correctness among manually graded outputs: ${percent(graded.filter(({ question }) => question.manual_grade === "correct").length, graded.length)} (${graded.filter(({ question }) => question.manual_grade === "partial").length} partial).`,
    "", "| ID | Team | Question | Reconciled meetings | Run | Valid citations | Gold recall | Manual grade |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows,
    "", "## Worst observed failures", "",
    ...(failures.length ? failures.map(({ id, detail }) => `- **${id}** · ${detail}`) : ["No question failures have been measured."]),
    "", "## OpenRouter call log (all repository runs)", "", ...metrics,
    "", "## Answer records", "", ...records, ""].join("\n");
}

async function main() {
  loadLocalEnv();
  const { values } = parseArgs({ options: { "report-only": { type: "boolean" }, output: { type: "string" } } });
  const gold = z.object({ questions: z.array(goldQuestion).min(1) }).parse(JSON.parse(readFileSync("data/gold.json", "utf8"))).questions;
  if (new Set(gold.map(({ question_id }) => question_id)).size !== gold.length) throw new Error("Duplicate question IDs in data/gold.json.");
  const db = openMemory(undefined, { readonly: Boolean(values["report-only"]) });
  try {
    const store = citationStore(db);
    for (const question of gold) {
      for (const id of question.gold_evidence) {
        const turn = store.getTurn(id);
        if (!turn || turn.meeting_id.slice(0, -1) !== question.team) throw new Error(`${question.question_id}: invalid gold turn ${id}.`);
      }
    }
    const models = readModels();
    const reconciled = completedMeetings(db, "reconcile");
    const teamMeetings = db.prepare<[string], string>("SELECT meeting_id FROM meetings WHERE team = ? ORDER BY seq").pluck();
    const results: Result[] = gold.map((question) => {
      const meetings = teamMeetings.all(question.team);
      if (!meetings.length) throw new Error(`${question.question_id}: no indexed meetings for ${question.team}.`);
      return { question, seen: new Set(), reconciled: `${meetings.filter((id) => reconciled.has(id)).length}/${meetings.length}` };
    });
    const output = values.output ?? "EVAL.md";
    const save = () => writeFileSync(output, render(results, callSummary(readCalls(db), models)));
    if (values["report-only"]) {
      if (!values.output) throw new Error("Use --output with --report-only to name a baseline report and preserve EVAL.md.");
      save();
      console.log(`Wrote baseline to ${output}.`);
      return;
    }

    const apiKeys = readOpenRouterKeys();
    const model = models.agent;
    if (!apiKeys.length || !model) throw new Error("Set an OpenRouter API key and MODEL_AGENT in .env.local.");
    const client = createLlmClient({ apiKeys, db, fallbacks: models.fallbacks });
    console.log(`${await client.remainingBudget()} live requests remaining. Evaluating ${results.length} questions.`);
    for (const [index, result] of results.entries()) {
      const { question, seen } = result;
      try {
        result.answer = await answerQuestion(db, question, {
          model, complete: client.complete, purpose: "eval", pendingCalls: (results.length - index - 1) * maxAgentCalls,
          onStep: ({ action, turnIds }) => {
            if (action.action === "search" || action.action === "read" || action.action === "numbers") turnIds.forEach((id) => seen.add(id));
          },
        });
        result.valid = result.answer.citations.filter((citation) => validateCitation(citation, store)).length;
      } catch (error) {
        result.failure = error instanceof Error ? error.message : String(error);
        result.paused = error instanceof DailyBudgetError || /OpenRouter|configured free model/.test(result.failure);
        if (result.paused) {
          save();
          throw new Error(`${question.question_id}: ${result.failure} Partial report saved to ${output}. Rerun to reuse cached steps.`);
        }
      }
      save();
      console.log(`${question.question_id}: ${result.failure ?? "answered"}`);
    }
    console.log(`Wrote ${output}. ${await client.remainingBudget()} live requests remaining.`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
