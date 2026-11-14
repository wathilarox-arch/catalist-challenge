import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCitation, validateCitation } from "../lib/citations";
import { citationStore, getCorpusStats, getLedgerAsOf, indexMeetings, initializeMemory, openMemory, type MemoryDatabase } from "../lib/db";
import { parseTranscript } from "../lib/parse";
import { FtsRetriever } from "../lib/retrieve";

const transcript = (id: string, speech = "We agreed to use the L_C_D_ here.") => parseTranscript(
  `Meeting: ${id}\nTeam: ${id.slice(0, -1)}\n\n00:00:01 Speaker A\nBrief opener.\n\n00:00:02 Speaker B\n${speech}\n\n00:00:03 Speaker C\nNext turn.`,
);

let db: MemoryDatabase;
beforeEach(() => {
  db = openMemory(":memory:", { readonly: false });
  initializeMemory(db);
});
afterEach(() => db.close());

describe("SQLite memory", () => {
  it("ingests once, searches acronym forms, and enforces team and sequence limits", () => {
    const corpus = [transcript("TS3012a"), transcript("TS3012d"), transcript("ES2002b")];
    expect(indexMeetings(db, corpus)).toBe(3);
    expect(indexMeetings(db, corpus)).toBe(0);
    expect(getCorpusStats(db)).toMatchObject({ meetings: 3, teams: 2, turns: 9 });
    const retriever = new FtsRetriever(db);

    for (const query of ["lcd", '"L_C_D_"', "agre"]) {
      const hits = retriever.search("TS3012", query, { k: 5, maxSeq: 3 });
      expect(hits.map((hit) => hit.turn_id)).toEqual(["TS3012a:0002"]);
      expect(hits[0].neighbours.map((turn) => turn.turn_id)).toEqual(["TS3012a:0001", "TS3012a:0003"]);
      const store = citationStore(db);
      const evidence = { meeting_id: hits[0].meeting_id, turn_id: hits[0].turn_id, anchor: "L_C_D_ here" };
      const resolved = resolveCitation(evidence, store);
      expect(resolved.ok && validateCitation(resolved.citation, store)).toBe(true);
    }
    expect(retriever.search("TS3012", "lcd", { k: 5, meetingId: "TS3012d" })).toHaveLength(1);
    expect(retriever.search("TS3012", "lcd", { k: 5, maxSeq: 3, meetingId: "TS3012d" })).toEqual([]);
    expect(retriever.search("TS3012", "lcd", { k: 5, meetingId: "ES2002b" })).toEqual([]);
  });

  it("rolls back new inserts when a changed transcript would invalidate evidence IDs", () => {
    indexMeetings(db, [transcript("TS3012a")]);
    expect(() => indexMeetings(db, [transcript("TS3012d"), transcript("TS3012a", "Edited words.")])).toThrow(/changed/);
    expect(getCorpusStats(db)).toMatchObject({ meetings: 1, turns: 3 });
    expect(new FtsRetriever(db).search("TS3012", "lcd", { k: 5 })).toHaveLength(1);
  });

  it("returns the newest version as of the cutoff and keeps earlier versions in history", () => {
    indexMeetings(db, [transcript("TS3012a"), transcript("TS3012c"), transcript("TS3012d"), transcript("ES2002a")]);
    const insert = db.prepare(`
      INSERT INTO ledger (item_id, version, team, kind, slot, value, status, meeting_seq, evidence, supersedes)
      VALUES ('material', @version, @team, 'decision', 'case_material', @value, 'agreed', @seq, @evidence, @supersedes)
    `);
    insert.run({ version: 1, team: "TS3012", value: "rubber", seq: 1, evidence: '["TS3012a:0002"]', supersedes: null });
    insert.run({ version: 2, team: "TS3012", value: "plastic", seq: 3, evidence: '["TS3012c:0002"]', supersedes: "material@1" });
    insert.run({ version: 3, team: "TS3012", value: "metal", seq: 4, evidence: '["TS3012d:0002"]', supersedes: "material@2" });
    insert.run({ version: 4, team: "ES2002", value: "wood", seq: 1, evidence: '["ES2002a:0002"]', supersedes: null });
    expect(getLedgerAsOf(db, "TS3012", 2).map((item) => item.value)).toEqual(["rubber"]);
    expect(getLedgerAsOf(db, "TS3012", 3).map((item) => item.evidence)).toEqual([["TS3012c:0002"]]);
    expect(getLedgerAsOf(db, "TS3012", 3, { history: true }).map((item) => item.value)).toEqual(["rubber", "plastic"]);
    expect(getLedgerAsOf(db, "TS3012", 4).map((item) => item.value)).toEqual(["metal"]);
  });
});
