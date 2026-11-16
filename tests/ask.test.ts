import { afterEach, expect, it, vi } from "vitest";
import { readAskPage, savedQuestions } from "../lib/ask-data";
import { createAskHandler } from "../lib/ask-server";
import { matchSavedQuestion, type AskAnswer, type AskEvent } from "../lib/ask";
import { DailyBudgetError } from "../lib/llm/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(question: string, team?: string, cookie?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  return new Request("http://localhost/api/ask", { method: "POST", headers, body: JSON.stringify({ question, team }) });
}

async function events(response: Response): Promise<AskEvent[]> {
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  return (await response.text()).trim().split("\n\n").map((frame) => JSON.parse(frame.slice("data: ".length)));
}

function withoutApiKeys() {
  for (const name of Object.keys(process.env)) {
    if (/^OPENROUTER_(API_KEY|CONTINUATION_KEY_\d+)$/.test(name)) vi.stubEnv(name, undefined);
  }
}

const first = savedQuestions[0];
const fakeAnswer: AskAnswer = first.answer;
const teams = () => [first.team, "TS3012"];

it("gives all 25 official questions stable order, saved answers, and context from the local corpus", () => {
  const { questions } = readAskPage();
  expect(questions.map(({ id }) => id)).toEqual(Array.from({ length: 25 }, (_, index) => `Q${String(index + 1).padStart(2, "0")}`));
  for (const { question, team, id, answer } of questions) {
    expect(answer.text).toBeTruthy();
    expect(matchSavedQuestion(questions, `  ${question.toUpperCase()}   `, team)?.id).toBe(id);
    expect(matchSavedQuestion(questions, question, "ZZ9999")).toBeUndefined();
    for (const { quote, context } of answer.citations) expect(context?.highlight).toBe(quote);
  }
});

it("serves every saved answer even without keys or a corpus connection", async () => {
  withoutApiKeys();
  const readTeams = vi.fn(() => { throw new Error("SQLite unavailable"); });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const ask = createAskHandler({ teams: readTeams, readSaved: (answer) => answer });
  for (const { question, answer } of savedQuestions) {
    await expect(events(await ask(request(question)))).resolves.toEqual([{ type: "answer", answer, source: "saved" }]);
  }
  expect(readTeams).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("validates team scope before live work and explains missing credentials", async () => {
  withoutApiKeys();
  const run = vi.fn();
  const ask = createAskHandler({ teams, run });
  const cases = [
    [request("What was decided?"), "team_required"],
    [request(`Compare ${first.team} and TS3012`), "team_required"],
    [request("What did TS3012 agree?", first.team), "team_conflict"],
    [request("What did ZZ9999 agree?"), "unknown_team"],
    [request(" "), "invalid_question"],
  ] as const;
  for (const [input, code] of cases) {
    const response = await ask(input);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ type: "error", code });
  }
  const offline = await ask(request("What did the team agree?", first.team));
  expect(offline.status).toBe(503);
  await expect(offline.json()).resolves.toMatchObject({ code: "live_unavailable" });
  expect(run).not.toHaveBeenCalled();
});

it("streams progress and a final answer, and serves cached and saved answers after the session limit", async () => {
  const run = vi.fn(async (_question: { question: string; team: string }, step: (event: Extract<AskEvent, { type: "step" }>) => void) => {
    step({ type: "step", step: 1, action: "search", turns: 2 });
    return fakeAnswer;
  });
  const ask = createAskHandler({ teams, run, available: () => true });
  const initial = await ask(request("What did TS3012 discuss in TS3012a?"));
  const cookie = initial.headers.get("set-cookie")!.split(";")[0];
  expect(cookie).toMatch(/^catalist_ask_session=/);
  await expect(events(initial)).resolves.toEqual([
    { type: "step", step: 1, action: "search", turns: 2 },
    { type: "answer", answer: fakeAnswer, source: "live" },
  ]);
  for (let i = 1; i <= 4; i++) {
    await events(await ask(request(`New question ${i}`, "TS3012", cookie)));
  }
  const limited = await ask(request("New question six", "TS3012", cookie));
  expect(limited.status).toBe(429);
  await expect(limited.json()).resolves.toMatchObject({ code: "session_limit" });

  await expect(events(await ask(request("  WHAT DID TS3012 DISCUSS IN TS3012A?  ", "TS3012", cookie))))
    .resolves.toEqual([{ type: "answer", answer: fakeAnswer, source: "cached" }]);
  await expect(events(await ask(request(first.question, first.team, cookie))))
    .resolves.toMatchObject([{ type: "answer", source: "saved" }]);
  expect(run).toHaveBeenCalledTimes(5);
});

it("limits new live requests by IP across sessions and resets the limit after an hour", async () => {
  let now = Date.UTC(2026, 0, 1);
  const run = vi.fn(async () => fakeAnswer);
  const ask = createAskHandler({ teams, run, available: () => true, now: () => now });
  for (let i = 0; i < 10; i++) await events(await ask(request(`Question ${i}`, "TS3012")));
  const limited = await ask(request("One more fresh question", "TS3012"));
  expect(limited.status).toBe(429);
  await expect(limited.json()).resolves.toMatchObject({ code: "ip_limit" });
  now += 60 * 60_000;
  await expect(events(await ask(request("One more fresh question", "TS3012"))))
    .resolves.toMatchObject([{ type: "answer", source: "live" }]);
  expect(run).toHaveBeenCalledTimes(11);
});

it("reports quota exhaustion as a terminal event and leaves saved answers available", async () => {
  const ask = createAskHandler({ teams, available: () => true, run: async () => { throw new DailyBudgetError(1); } });
  await expect(events(await ask(request("What else did they decide?", first.team))))
    .resolves.toMatchObject([{ type: "error", code: "quota_exhausted" }]);
  await expect(events(await ask(request(first.question))))
    .resolves.toMatchObject([{ type: "answer", source: "saved" }]);
});

it("runs the actual live agent against mock OpenRouter and switches from the exhausted primary key", async () => {
  withoutApiKeys();
  vi.stubEnv("OPENROUTER_API_KEY", "primary");
  vi.stubEnv("OPENROUTER_CONTINUATION_KEY_1", "backup");
  vi.stubEnv("MODEL_AGENT", "example/primary:free");
  vi.stubEnv("MODEL_FALLBACKS", "");
  vi.stubEnv("DAILY_REQUEST_BUDGET", "4");
  vi.stubEnv("LLM_RPM", "20");
  const citation = readAskPage().questions[0].answer.citations[0];
  const turnId = citation.context!.turnId;
  const index = Number(turnId.split(":")[1]);
  const usedKeys: (string | null)[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("authorization");
    if (String(input).endsWith("/key")) {
      return Response.json({ data: { free_model_daily_requests: { remaining: 50, used: 0, limit: 50 } } });
    }
    usedKeys.push(key);
    if (key === "Bearer primary") {
      return Response.json({ error: { message: "Daily cap", metadata: { limit_source: "openrouter_free_tier_daily" } } }, { status: 429 });
    }
    const action = usedKeys.length === 2
      ? { action: "read", meeting_id: citation.meeting_id, from_idx: index, to_idx: index }
      : { action: "final", answer: "Verified test answer.", evidence: [{ meeting_id: citation.meeting_id, turn_id: turnId }] };
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(action) } }] });
  });
  vi.stubGlobal("fetch", fetcher);
  const ask = createAskHandler();
  const response = await ask(request("What was discussed in this particular meeting?", first.team));
  await expect(events(response)).resolves.toMatchObject([
    { type: "step", action: "read", turns: 1 },
    { type: "step", action: "final" },
    { type: "answer", source: "live", answer: {
      text: "Verified test answer.", citations: [{ meeting_id: citation.meeting_id, context: { turnId } }],
    } },
  ]);
  expect(usedKeys).toEqual(["Bearer primary", "Bearer backup", "Bearer backup"]);
}, 16_000);
