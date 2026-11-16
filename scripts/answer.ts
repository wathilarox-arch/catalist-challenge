import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { answerQuestion, maxAgentCalls, questionSchema, type Answer, type AgentStep } from "../lib/agent";
import { generateBrief } from "../lib/brief";
import { validateCitation } from "../lib/citations";
import { citationStore, initializeMemory, openMemory } from "../lib/db";
import { completedMeetings, selectMeetings } from "../lib/ingest";
import { createLlmClient, DailyBudgetError } from "../lib/llm/client";
import { loadLocalEnv, readLlmSettings, readModels, readOpenRouterKeys } from "../lib/llm/config";
import { teamIdSchema } from "../lib/parse";

const batchSchema = z.object({ questions: z.array(questionSchema.extend({ team: teamIdSchema })) });

function writeAnswers(output: string, submission: { answers: Answer[]; brief?: string }) {
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(submission, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function printStep(questionId: string, { step, action, turnIds, calls, feedback }: AgentStep) {
  const usage = calls.map(({ model, cached, usage }) =>
    `${model}${cached ? " cached" : ""} ${usage ? `${usage.prompt_tokens} in / ${usage.completion_tokens} out` : "tokens unavailable"}`);
  console.log(`${questionId} step ${step}: ${action.action}, ${turnIds.length} turns, ${usage.join("; ")}${feedback ? `; ${feedback}` : ""}`);
}

async function main() {
  loadLocalEnv();
  const { values } = parseArgs({ options: { teams: { type: "string" }, output: { type: "string" } } });
  const teams = values.teams && new Set(values.teams.split(",").map((team) => teamIdSchema.parse(team.trim().toUpperCase())));
  const output = values.output ?? (teams ? "answers.pilot.json" : "answers.json");
  const { questions } = batchSchema.parse(JSON.parse(readFileSync("data/questions.json", "utf8")));
  const selected = questions.filter(({ team }) => !teams || teams.has(team));
  if (!selected.length) throw new Error("No official questions match the selected teams.");
  const { agent: model, fallbacks } = readModels();
  const apiKeys = readOpenRouterKeys();
  if (!apiKeys.length || !model) throw new Error("Set an OpenRouter API key and MODEL_AGENT in .env.local.");

  const db = openMemory(undefined, { readonly: false });
  try {
    initializeMemory(db);
    if (!teams) {
      const requiredTeams = [...new Set(["TS3012", ...selected.map(({ team }) => team)])];
      const reconciled = completedMeetings(db, "reconcile");
      const required = selectMeetings(db, requiredTeams).filter(({ team, seq }) => team !== "TS3012" || seq <= 3);
      const missing = required.filter(({ meeting_id }) => !reconciled.has(meeting_id));
      if (missing.length) throw new Error(`${missing.length} meetings needed by the submission are pending reconciliation, starting with ${missing[0].meeting_id}. Run npm run ingest:all to resume.`);
    }
    const settings = readLlmSettings();
    const client = createLlmClient({ apiKeys, db, fallbacks, settings });
    const store = citationStore(db);
    const answers: Answer[] = [];
    const uncovered = teams ? [...teams].filter((team) => !selected.some((question) => question.team === team)) : [];
    if (uncovered.length) console.log(`Teams without official questions in this run: ${uncovered.join(", ")}.`);
    console.log(`${selected.length} selected questions, up to ${selected.length * maxAgentCalls} agent calls before provider retries.`);
    for (const [index, question] of selected.entries()) {
      try {
        console.log(`${question.question_id} (${question.team}): ${await client.remainingBudget()} live requests remaining.`);
        answers.push(await answerQuestion(db, question, {
          model, complete: client.complete, pendingCalls: (selected.length - index - 1) * maxAgentCalls + (teams ? 0 : 1),
          maxOutputTokens: settings.agentOutputTokens,
          onStep: (step) => printStep(question.question_id, step),
        }));
      } catch (error) {
        if (error instanceof DailyBudgetError) {
          throw new Error(`${question.question_id}: ${error.message} Re-run the same command to reuse cached steps.`, { cause: error });
        }
        throw new Error(`${question.question_id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    const brief = teams ? undefined : await generateBrief(db, { model, complete: client.complete, maxOutputTokens: settings.briefOutputTokens });
    const citations = [...answers.flatMap((answer) => answer.citations), ...(brief?.citations ?? [])];
    for (const citation of citations) {
      if (!validateCitation(citation, store)) throw new Error(`Invalid final citation in ${citation.meeting_id}.`);
    }
    writeAnswers(output, { answers, brief: brief?.brief });
    console.log(`Wrote ${answers.length} answers${brief ? " and the TS3012 brief" : ""} to ${output}. ${citations.length}/${citations.length} citations validated. ${await client.remainingBudget()} live requests remaining.`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Answer generation failed.");
  process.exitCode = 1;
});
