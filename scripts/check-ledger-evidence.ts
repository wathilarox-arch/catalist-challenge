import { openMemory } from "../lib/db";

const db = openMemory();
try {
  const invalid = db.prepare(`
    SELECT 'event' AS kind, e.event_id AS id, evidence.value AS turn_id
    FROM events e LEFT JOIN json_each(e.turn_ids) evidence ON true
    LEFT JOIN turns t ON t.turn_id = evidence.value AND t.meeting_id = e.meeting_id
    WHERE t.turn_id IS NULL
    UNION ALL
    SELECT 'ledger', l.item_id || '@' || l.version, evidence.value
    FROM ledger l JOIN meetings m ON m.team = l.team AND m.seq = l.meeting_seq
    LEFT JOIN json_each(l.evidence) evidence ON true
    LEFT JOIN turns t ON t.turn_id = evidence.value AND t.meeting_id = m.meeting_id
    WHERE t.turn_id IS NULL
  `).all();
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM ledger) AS ledger_versions`).get();
  console.log(totals);
  if (invalid.length) {
    console.table(invalid);
    throw new Error(`${invalid.length} evidence references could not be verified.`);
  }
  console.log("Every saved evidence reference points to a turn in its source meeting.");
} finally {
  db.close();
}
