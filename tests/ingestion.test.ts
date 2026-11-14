import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLedgerAsOf, indexMeetings, initializeMemory, openMemory, type MemoryDatabase } from "../lib/db";
import { extractMeeting, prepareEvents, windowTurns, type ExtractedEvent } from "../lib/extract";
import { isComplete } from "../lib/ingest";
import type { Complete } from "../lib/llm/client";
import { parseTranscript } from "../lib/parse";
import { applyOps, reconcileMeeting, type LedgerOp } from "../lib/reconcile";

const sample = (id: string) => parseTranscript(`Meeting: ${id}\nTeam: ${id.slice(0, -1)}

00:00:01 Speaker C
Yeah.

00:00:02 Speaker B
Let's use the flexible shell for this design.

00:00:03 Speaker B
Actually, we agreed to replace that with a rigid shell.`);

const event: ExtractedEvent = {
  type: "decision", slot_hint: "shell material", summary: "The team chose a shell material.", speaker: "B",
  turn_idxs: [2], value: "flexible", refers_back: false, refers_note: null,
};
const firstOp: LedgerOp = {
  op: "new", target: null, kind: "decision", slot: "shell material", status: "agreed", value: "flexible",
  evidence_turn_idxs: [2], rationale: null,
};
const options = { model: "example/model:free", context: 262_144 };
const reply = (value: unknown) => ({ text: JSON.stringify(value), model: options.model, usage: null, cached: false });

let db: MemoryDatabase;
beforeEach(() => {
  db = openMemory(":memory:", { readonly: false });
  initializeMemory(db);
});
afterEach(() => db.close());

describe("event extraction", () => {
  it("keeps indices stable across overlapping windows and filters only backchannels", () => {
    const input = Array.from({ length: 30 }, (_, i) => ({ ...sample("TS3012a").turns[1], idx: i + 2,
      n_words: 40, text: "word ".repeat(40) }));
    const windows = windowTurns([sample("TS3012a").turns[0], ...input], 14_000);
    expect(windows.length).toBeGreaterThan(1);
    expect([...new Set(windows.flat().map(({ idx }) => idx))]).toEqual(input.map(({ idx }) => idx));
    expect(windows[1][0].idx).toBeLessThanOrEqual(windows[0].at(-1)!.idx);
    expect(windowTurns([{ ...input[0], text: "Fifteen Euros.", n_words: 2 }], options.context)[0]).toHaveLength(1);
  });

  it("deduplicates overlapping events and rejects nonexistent or wrong-speaker indices", () => {
    const turns = sample("TS3012a").turns;
    const result = prepareEvents([
      { turns: turns.slice(0, 2), events: [event, { ...event, turn_idxs: [3] }] },
      { turns: turns.slice(1), events: [{ ...event, turn_idxs: [3, 2] }, { ...event, speaker: "A" }] },
    ]);
    expect(result).toEqual({ events: [{ ...event, turn_idxs: [2, 3] }], rejected: 2 });
  });

  it("records completion once and keeps older databases compatible", async () => {
    db.exec("ALTER TABLE events DROP COLUMN owner_speaker");
    initializeMemory(db);
    const a = sample("TS3012a");
    indexMeetings(db, [a]);
    const complete = vi.fn<Complete>(async () => reply({ events: [event, { ...event, turn_idxs: [] }] }));
    await expect(extractMeeting(db, a.meeting, { ...options, complete })).resolves.toMatchObject({ count: 1, rejected: 1 });
    await expect(extractMeeting(db, a.meeting, { ...options, complete })).resolves.toBeNull();
    expect(complete).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT turn_ids FROM events").pluck().all()).toEqual(['["TS3012a:0002"]']);
  });

  it("leaves a failed extraction pending", async () => {
    const a = sample("TS3012a");
    indexMeetings(db, [a]);
    const complete: Complete = async () => reply({ events: [{ ...event, turn_idxs: [91] }] });
    await expect(extractMeeting(db, a.meeting, { ...options, complete })).rejects.toThrow(/invalid evidence/);
    expect(isComplete(db, a.meeting.meeting_id, "extract")).toBe(false);
  });
});

describe("ledger reconciliation", () => {
  it("rejects wrong-meeting evidence and unknown targets while appending versions", () => {
    const a = sample("TS3012a");
    const c = sample("TS3012c");
    const initial = applyOps(a.meeting, [], [firstOp], new Map([[2, "TS3012a:0002"]])).versions;
    const edit: LedgerOp = { ...firstOp, op: "supersede", target: initial[0].item_id, slot: "case_material", value: "rigid" };
    const result = applyOps(c.meeting, initial, [edit, { ...edit, target: "unknown" }, { ...edit, evidence_turn_idxs: [3] }],
      new Map([[2, "TS3012c:0002"], [3, "TS3012d:0003"]]));
    expect(result.versions).toMatchObject([{ item_id: initial[0].item_id, version: 2, value: "rigid", supersedes: `${initial[0].item_id}@1` }]);
    expect(result.rejected).toHaveLength(2);
    expect(initial[0].value).toBe("flexible");
  });

  it("reconciles an incomplete team in actual meeting order and advances the as-of state", async () => {
    const b = sample("IS1002b");
    const c = sample("IS1002c");
    indexMeetings(db, [b, c]);
    await extractMeeting(db, b.meeting, { ...options, complete: async () => reply({ events: [event] }) });
    await extractMeeting(db, c.meeting, { ...options, complete: async () => reply({ events: [{ ...event, turn_idxs: [3], value: "rigid" }] }) });
    const complete = vi.fn<Complete>(async () => reply({ ops: [firstOp] }));
    await expect(reconcileMeeting(db, c.meeting, { model: options.model, complete })).rejects.toThrow(/reconcile IS1002b first/);
    expect(complete).not.toHaveBeenCalled();
    await reconcileMeeting(db, b.meeting, { model: options.model, complete });
    const previous = getLedgerAsOf(db, "IS1002", 2)[0];
    complete.mockResolvedValueOnce(reply({ ops: [{ ...firstOp, op: "supersede", target: previous.item_id, value: "rigid", evidence_turn_idxs: [3] }] }));
    await reconcileMeeting(db, c.meeting, { model: options.model, complete });
    expect(getLedgerAsOf(db, "IS1002", 2)).toMatchObject([{ value: "flexible" }]);
    expect(getLedgerAsOf(db, "IS1002", 3)).toMatchObject([{ value: "rigid", evidence: ["IS1002c:0003"] }]);
    await expect(reconcileMeeting(db, c.meeting, { model: options.model, complete })).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
