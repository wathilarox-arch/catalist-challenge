# Meeting Memory Agent

Catalist AI is a Next.js workspace for asking questions about the AMI design meetings. Use Node.js 24.x to match the Vercel build and runtime. After switching Node versions, run `npm ci` to install `better-sqlite3` for the new Node ABI.

```sh
npm ci
npm test
npm run ingest:parse
npm run find -- TS3012 design --max-seq 3 --limit 3
npm run dev
```

Open `http://localhost:3000` and pick a question from **Saved answers**. The app pairs all 25 official questions with the existing submission file `answers.json`. Selecting a saved question or typing its exact text uses the local answer and citations without an OpenRouter request. Expand a citation to see the source turn and its neighbours when the corpus database is available.

For a new question, configure an OpenRouter key and `MODEL_AGENT` in `.env.local`, then select a team in the composer or include its ID in the question. The page streams the agent’s search steps and shows citations with the answer. The browser displays one exchange at a time. Saved answers remain available when live questions are disabled or the request budget is exhausted.

The web app opens `data/memory.db` read-only and keeps its answer cache and call accounting in memory. Each running instance allows five new live questions per browser session per UTC day and ten per network per hour. Saved and cached answers bypass these limits. The web process also applies `DAILY_REQUEST_BUDGET` when configured, and OpenRouter checks its own quotas. Include `answers.json` and `data/memory.db` in the deployment source. Next.js traces the database and native addon for the homepage and Ask API.

`ingest:parse` reads `data/transcripts/` and writes `data/memory.db`. Re-running skips unchanged meetings. If a transcript changes, ingest it into a fresh database so existing evidence references stay reliable. `find` accepts a team ID and keywords plus optional `--meeting`, `--max-seq`, and `--limit` filters. SQLite FTS5 restricts matches to one team and returns the original speaker turns.

The transcripts are from the AMI Meeting Corpus and were reformatted by Catalist. See [corpus attribution](data/CREDITS.txt).

## OpenRouter

Run `npm run models` to find available free chat models and their context limits. Put `OPENROUTER_API_KEY`, `MODEL_EXTRACT`, and `MODEL_AGENT` in `.env.local`. Add optional `OPENROUTER_CONTINUATION_KEY_1`, `OPENROUTER_CONTINUATION_KEY_2`, and other numbered keys for quota failover. The client tries the primary key first, then tries the numbered keys in numeric order. OpenRouter's free-model quota is shared by keys on the same account. Set `MODEL_FALLBACKS` to a comma-separated list of other listed `:free` model IDs for model fallback routing. `.env.example` lists the rate and budget settings.

```sh
npm run plan:calls
npm run plan:calls -- --teams TS3012,ES2008 --limit 6
npm run llm:smoke
```

The planner estimates ingestion calls and context windows using the quota of the first available key. The smoke script sends a small test prompt and repeats it to verify the SQLite cache. The default rate is 15 requests per minute with one concurrent request. Each live attempt consumes one budget slot, and `DAILY_REQUEST_BUDGET` applies across all keys. The run pauses when the local cap is reached or all keys are exhausted. Transient provider errors can retry or use another configured model. `llm_calls` records attempts and cache hits with usage and status. JSON repairs are logged with the `:repair` purpose suffix.

## Extract and reconcile meetings

```sh
npm run ingest:extract -- --teams TS3012,ES2003,TS3006
npm run ingest:reconcile -- --teams TS3012,ES2003,TS3006
npm run ledger:show -- ES2003 --slot case_material
```

Run extraction before reconciliation. Both stages skip completed meetings on rerun, including meetings that yielded zero changes. `--limit` selects a prefix of meetings before completed meetings are skipped. Within a team, reconciliation follows the recorded order and requires each earlier existing meeting to be reconciled. `ledger:show` prints source turns and accepts `--max-seq 3` to review a team's history before its final meeting.

`npm run ledger:check` audits saved event and ledger evidence against the indexed turns. For a reasoning model that supports the switch, `LLM_DISABLE_REASONING=true` leaves more of the completion budget for JSON. `LLM_EXTRACT_INPUT_TOKENS` optionally caps each transcript window when long requests produce truncated output. The planner accounts for the extra overlapping windows.

For models that support reasoning effort, set `LLM_REASONING_EFFORT=minimal` to reserve more completion tokens for output. `LLM_DISABLE_REASONING=true` takes precedence when both are set.

If a reasoning model exhausts its completion budget before returning JSON, `LLM_EXTRACT_OUTPUT_TOKENS` and `LLM_RECONCILE_OUTPUT_TOKENS` override the 8,192-token defaults. Keep these settings stable when resuming so completed requests can be replayed from cache.

## Scale up and generate the submission

```sh
npm run plan:calls
npm run ingest:all
npm run ledger:check
npm run answer:all
```

`ingest:all` extracts and reconciles each selected meeting in sequence, starting with teams used by the official questions and brief. It accepts `--teams` and `--limit`. After a quota stop, rerun the same command. Completed stages are skipped and cached calls are reused.

`answer:all` checks that the meetings needed by the submission are reconciled, answers the 25 official questions, and writes `answers.json` after validating the answer and brief citations. The TS3012 brief uses the ledger as of meeting c and checks that each evidence turn belongs to meetings a–c. Re-running the batch reuses cached model steps. For the Milestone 4 pilot, use `npm run answer:all -- --teams ES2003,TS3006`, which writes `answers.pilot.json`.

## Evaluate and estimate costs

```sh
npm run eval
npm run cost:report
npm run cost:report -- --live-quota
```

`eval` runs the 12 independent questions in `data/gold.json` and writes `EVAL.md` with answer records, citation validity, retrieval recall, manual grades, and the worst measured failures. Run after ingestion for a ledger-backed evaluation. Use `npm run find` to verify the gold answers and enter their supporting turn IDs under `gold_evidence`. After reviewing the generated answers, enter `correct`, `partial`, or `incorrect` in `manual_grade` and record the reason in `review_notes`. Rerun with the same database and model to reuse cached steps. A quota stop saves a partial report. To preview the report structure offline, use `npm run eval -- --report-only --output EVAL.baseline.md`.

`cost:report` reads local call logs and estimates the requests, tokens and runtime for 1,000 meetings. Add each logged model ID under `models` in `config/prices.json`, with `input_usd_per_million` and `output_usd_per_million`, to enable the paid-equivalent estimate. The optional quota check queries OpenRouter without using a completion request.
