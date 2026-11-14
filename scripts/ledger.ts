import { parseArgs } from "node:util";
import { z } from "zod";
import { getLedgerAsOf, openMemory } from "../lib/db";
import { meetingIdSchema, sequenceSchema, teamIdSchema } from "../lib/parse";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  "max-seq": { type: "string", default: "4" }, slot: { type: "string" },
} });
const team = teamIdSchema.parse(positionals[0]?.toUpperCase());
const maxSeq = z.coerce.number().pipe(sequenceSchema).parse(values["max-seq"]);
const db = openMemory();
try {
  const completed = z.array(meetingIdSchema).parse(db.prepare(`
    SELECT m.meeting_id FROM meetings m JOIN ingestion i USING (meeting_id)
    WHERE m.team = ? AND m.seq <= ? AND i.stage = 'reconcile' ORDER BY m.seq
  `).pluck().all(team, maxSeq));
  console.log(`Reconciled through sequence ${maxSeq}: ${completed.join(", ") || "none"}`);
  const current = new Map(getLedgerAsOf(db, team, maxSeq).map(({ item_id, version }) => [item_id, version]));
  const items = getLedgerAsOf(db, team, maxSeq, { history: true }).filter(({ slot }) => !values.slot || slot === values.slot);
  const turn = db.prepare<[string], { speaker: string; meeting_id: string; text: string }>(
    "SELECT speaker, meeting_id, text FROM turns WHERE turn_id = ?",
  );
  for (const item of items.sort((a, b) => a.slot.localeCompare(b.slot) || a.meeting_seq - b.meeting_seq || a.version - b.version)) {
    const history = current.get(item.item_id) === item.version ? "current" : "previous";
    const meetingId = `${team}${String.fromCharCode(96 + item.meeting_seq)}`;
    console.log(`\n${meetingId} | ${item.slot} | ${item.kind}/${item.status} | ${history} | ${item.value}`);
    if (item.rationale) console.log(item.rationale);
    if (item.owner_speaker) console.log(`Owner: Speaker ${item.owner_speaker}`);
    for (const id of item.evidence) {
      const evidence = turn.get(id);
      if (!evidence || evidence.meeting_id !== meetingId) throw new Error(`Invalid evidence for ${item.item_id}@${item.version}: ${id}`);
      console.log(`[${id}] Speaker ${evidence.speaker}: ${evidence.text}`);
    }
  }
  if (items.length === 0) console.log("No matching ledger entries.");
} finally {
  db.close();
}
