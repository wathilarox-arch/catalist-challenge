# Meeting Memory Agent

Local Next.js foundation for searching the Catalist build-test transcripts. Use Node.js 20.19 or 22. On Windows, `better-sqlite3` needs a matching native binary or a compatible C++ build toolchain.

```sh
npm ci
npm test
npm run ingest:parse
npm run find -- TS3012 design --max-seq 3 --limit 3
npm run dev
```

Open `http://localhost:3000` for the corpus status page. `find` accepts a team ID and keywords plus optional `--meeting`, `--max-seq`, and `--limit` filters. Results show the turn ID, timestamp, speaker letter, and original text.

`ingest:parse` reads `data/transcripts/` and writes `data/memory.db`. Re-running skips unchanged meetings. If a transcript changes, ingest it into a fresh database so existing evidence references stay reliable. The web app and search CLI open SQLite in read-only mode. The questions in `data/questions.json` are reserved for the later agent run.

The search index uses SQLite FTS5. Queries constrain matches to one team before ranking, and the original speaker-turn text is stored apart from the normalized search text. The ledger schema and as-of query are ready for the later extraction and reconciliation milestones.

The transcripts are from the AMI Meeting Corpus and were reformatted by Catalist. See [corpus attribution](data/CREDITS.txt).
