import { parseArgs } from "node:util";
import { z } from "zod";
import { openMemory } from "../lib/db";
import { sequenceSchema } from "../lib/parse";
import { FtsRetriever } from "../lib/retrieve";

const { positionals: [team, ...words], values } = parseArgs({
  allowPositionals: true,
  options: { meeting: { type: "string" }, "max-seq": { type: "string" }, limit: { type: "string", default: "8" } },
});

if (!team || !words.length) {
  console.error("Usage: npm run find -- TEAM keyword [keyword ...] [--meeting ID] [--max-seq N] [--limit N]");
  process.exit(1);
}

const maxSeq = values["max-seq"] === undefined ? undefined : z.coerce.number().pipe(sequenceSchema).parse(values["max-seq"]);
const db = openMemory();
try {
  const hits = new FtsRetriever(db).search(team.toUpperCase(), words.join(" "), {
    meetingId: values.meeting, maxSeq, k: Number(values.limit),
  });
  if (hits.length === 0) console.log("No matching turns.");
  for (const hit of hits) {
    const time = new Date(hit.start_sec * 1000).toISOString().slice(11, 19);
    console.log(`[${hit.turn_id}] ${time} Speaker ${hit.speaker}${hit.citable ? "" : " (under six words)"}\n${hit.text}\n`);
  }
} finally {
  db.close();
}
