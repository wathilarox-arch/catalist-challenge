import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateBrief } from "../lib/brief";
import { citationStore, indexMeetings, initializeMemory, openMemory, type MemoryDatabase } from "../lib/db";
import { validateCitation } from "../lib/citations";
import { markComplete } from "../lib/ingest";
import type { LlmRequest } from "../lib/llm/client";
import { parseTranscript } from "../lib/parse";

const model = "test/model:free";
const speech = {
  a: "We agreed to make the case out of plastic at this stage.",
  b: "Speaker B will test the rubber case fit before the next meeting.",
  c: "We agreed to switch to rubber because it is easier to grip.",
  d: "We agreed to switch all the cases to brushed steel today.",
};

let db: MemoryDatabase;
beforeEach(() => {
  db = openMemory(":memory:", { readonly: false });
  initializeMemory(db);
  for (const [seq, text] of Object.entries(speech)) {
    const id = `TS3012${seq}`;
    indexMeetings(db, [parseTranscript(`Meeting: ${id}\nTeam: TS3012\n\n00:00:01 Speaker B\n${text}`)]);
    markComplete(db, id, "reconcile");
  }
  db.exec(`INSERT INTO ledger VALUES
    ('material', 1, 'TS3012', 'decision', 'case', 'plastic', 'agreed', 1, NULL, '["TS3012a:0001"]', NULL, NULL),
    ('material', 2, 'TS3012', 'decision', 'case', 'rubber', 'agreed', 3, NULL, '["TS3012c:0001"]', 'material@1', 'easier to grip'),
    ('material', 3, 'TS3012', 'decision', 'case', 'brushed steel', 'agreed', 4, NULL, '["TS3012d:0001"]', 'material@2', NULL),
    ('fit', 1, 'TS3012', 'action', 'case_fit', 'test fit', 'open', 2, 'B', '["TS3012b:0001"]', NULL, NULL),
    ('fit', 2, 'TS3012', 'action', 'case_fit', 'test fit', 'done', 4, NULL, '["TS3012d:0001"]', 'fit@1', NULL)
  `);
});
afterEach(() => db.close());

const evidence = (seq: string) => ({ meeting_id: `TS3012${seq}`, turn_id: `TS3012${seq}:0001` });

it("phrases the pre-final state and a change using validated evidence from a–c", async () => {
  const complete = vi.fn(async (request: LlmRequest) => {
    const context = request.messages[1].content;
    expect(context).not.toMatch(/TS3012d|brushed steel/);
    const candidates = JSON.parse(context) as { id: number; section: string }[];
    const ids = new Map(candidates.map(({ id, section }) => [section, id]));
    expect([...ids.keys()]).toEqual(["What changed", "Decided", "Open actions"]);
    const bullets = [
      { id: ids.get("Decided"), text: "Use a rubber case.", evidence: [evidence("c")] },
      { id: ids.get("What changed"), text: "The team switched from plastic to rubber in TS3012c for greater grip.", evidence: [evidence("a"), evidence("c")] },
      { id: ids.get("Open actions"), text: "Speaker B will test the case fit, as assigned in TS3012b.", evidence: [evidence("b")] },
    ];
    return { text: JSON.stringify({ bullets }), model, cached: false, usage: null };
  });
  const { brief, citations } = await generateBrief(db, { complete, model });
  expect(brief).toContain(`Decided\n- Use a rubber case. [TS3012c: "${speech.c}"]`);
  expect(brief).toContain("Open disagreements\nNo supported entries");
  expect(citations.map(({ meeting_id }) => meeting_id)).toEqual(["TS3012c", "TS3012a", "TS3012c", "TS3012b"]);
  expect(citations.every((citation) => validateCitation(citation, citationStore(db)))).toBe(true);
});

it("rejects later-meeting model references and requires evidence for both versions of a change", async () => {
  const complete = vi.fn(async (request: LlmRequest) => {
    const bullets = [{ id: 1, text: "The material changed.", evidence: request.purpose === "brief" ? [evidence("d")] : [evidence("c")] }];
    return { text: JSON.stringify({ bullets }), model, cached: false, usage: null };
  });
  await expect(generateBrief(db, { complete, model })).rejects.toThrow(/Changes require evidence for both versions/);
  expect(complete).toHaveBeenCalledTimes(2);
});

it("fails before prompting if a pre-final ledger row points to final-meeting evidence", async () => {
  db.prepare("UPDATE ledger SET evidence = ? WHERE item_id = 'material' AND version = 2").run('["TS3012d:0001"]');
  const complete = vi.fn();
  await expect(generateBrief(db, { complete, model })).rejects.toThrow(/TS3012d:0001 is outside its source meeting/);
  expect(complete).not.toHaveBeenCalled();
});
