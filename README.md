# Meeting Memory Agent

Local Next.js foundation for searching the Catalist build-test transcripts. Use Node.js 24.x to match the Vercel build and runtime. After switching Node versions, run `npm ci` to install `better-sqlite3` for the new Node ABI.

```sh
npm ci
npm test
npm run ingest:parse
npm run find -- TS3012 design --max-seq 3 --limit 3
npm run dev
```

Open `http://localhost:3000` for the corpus status page. `find` accepts a team ID and keywords plus optional `--meeting`, `--max-seq`, and `--limit` filters. Results show the turn ID, timestamp, speaker letter, and original text.

`ingest:parse` reads `data/transcripts/` and writes `data/memory.db`. Re-running skips unchanged meetings. If a transcript changes, ingest it into a fresh database so existing evidence references stay reliable. The web app and search CLI open SQLite in read-only mode. The questions in `data/questions.json` are reserved for the later agent run.

For Vercel, deploy with the checked-in `data/memory.db`. The `package.json` engine pins Node.js 24.x for compatibility with `better-sqlite3`, and Next.js includes the database and native addon in the homepage function. Ingestion runs locally.

The search index uses SQLite FTS5. Queries constrain matches to one team before ranking, and the original speaker-turn text is stored apart from the normalized search text. The ledger schema and as-of query are ready for the later extraction and reconciliation milestones.

The transcripts are from the AMI Meeting Corpus and were reformatted by Catalist. See [corpus attribution](data/CREDITS.txt).

## OpenRouter

Run `npm run models` to find available free chat models and their context limits. Put `OPENROUTER_API_KEY`, `MODEL_EXTRACT`, and `MODEL_AGENT` in `.env.local`. Set `MODEL_FALLBACKS` to a comma-separated list of other listed `:free` model IDs if you want fallback routing. `.env.example` lists the rate and budget settings.

```sh
npm run plan:calls
npm run plan:calls -- --teams TS3012,ES2008 --limit 6
npm run llm:smoke
```

The planner estimates ingestion calls and context windows against the remaining free quota. The smoke script sends a small test prompt and repeats it to verify the SQLite cache. The default rate is 15 requests per minute with one concurrent request. Each live attempt consumes one budget slot. Account-wide daily exhaustion stops the run. Transient provider errors can retry or use another configured model. `llm_calls` records attempts and cache hits with usage and status. JSON repairs are logged with the `:repair` purpose suffix.

## Extract and reconcile meetings

```sh
npm run ingest:extract -- --teams TS3012,ES2003,TS3006
npm run ingest:reconcile -- --teams TS3012,ES2003,TS3006
npm run ledger:show -- ES2003 --slot case_material
```

Run extraction before reconciliation. Both stages skip completed meetings on rerun, including meetings that yielded zero changes. `--limit` selects a prefix of meetings before completed meetings are skipped. Within a team, reconciliation follows the recorded order and requires each earlier existing meeting to be reconciled. `ledger:show` prints source turns and accepts `--max-seq 3` to review a team's history before its final meeting.

`npm run ledger:check` audits saved event and ledger evidence against the indexed turns. For a reasoning model that supports the switch, `LLM_DISABLE_REASONING=true` leaves more of the completion budget for JSON. `LLM_EXTRACT_INPUT_TOKENS` optionally caps each transcript window when long requests produce truncated output. The planner accounts for the extra overlapping windows.
