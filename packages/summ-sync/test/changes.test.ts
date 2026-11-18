import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLine } from "../src/apply.ts";
import type { Leg, Snapshot, SnapshotFile } from "../src/snapshot.ts";
import { changeCount, changesMarkdown, compareSnapshots, previousSnapshot, writeChanges } from "../src/changes.ts";

const leg = (legId: string, over: Partial<Leg> = {}): Leg => ({
  legId,
  actionId: `action-${legId}`,
  side: "outgoing",
  id: `row-${legId}`,
  trade: "sell",
  currency: "RUNE",
  quantity: 1,
  timestamp: "2024-01-01T00:00:00.000Z",
  from: "a",
  to: "b",
  blockchain: "thorchain",
  description: "d",
  source: "wallet",
  importType: "wallet-import",
  comments: [],
  price: 2,
  ...over,
});
const snap = (legs: Leg[]): Snapshot => ({
  name: "s",
  legs,
  history: new Map(legs.map((l) => [l.actionId, ["first", "last line"]])),
  txHashes: new Set(),
});
const file = (legs: Leg[], takenAt = "2024-06-01T00:00:00.000Z"): SnapshotFile => ({
  version: 2,
  takenAt,
  total: legs.length,
  actions: [...new Set(legs.map((l) => l.actionId))].map((id) => ({
    id,
    txHash: "h",
    category: "trade",
    tags: [],
    detail: true as const,
  })),
});
const compare = (before: Leg[], after: Leg[], lines: LogLine[] = []) =>
  compareSnapshots(snap(before), file(before), snap(after), file(after, "2024-06-02T00:00:00.000Z"), lines);
// A leg id created after the first pull began (its first 8 hex digits are the creation time)
const NEW_LEG = "6700000000000000000000aa";

test("reports what Summ changed: a field, a leg gone, a leg it added; our uploads apart", () => {
  const c = compare(
    [leg("a"), leg("b")],
    [
      leg("a", { quantity: 2 }),
      leg(NEW_LEG, { importType: "soft-transfer", trade: "receive" }),
      leg("6700000000000000000000bb", { importType: "manual-csv" }),
    ],
  );
  const v = c.verification!;
  assert.deepEqual(
    v.changed.map((x) => [x.leg.legId, x.field, x.before, x.after]),
    [["a", "quantity", 1, 2]],
  );
  assert.deepEqual(
    v.gone.map((l) => l.legId),
    ["b"],
  );
  assert.deepEqual(
    v.added.map((l) => l.legId),
    [NEW_LEG],
  );
  assert.deepEqual(
    c.uploaded.map((l) => l.legId),
    ["6700000000000000000000bb"],
  );
  assert.equal(changeCount({ before: "x", sharedTx: [], ...c }), 3);
});

test("summ-sync's own writes between the pulls explain their changes, counted once per call", () => {
  const edit = { time: "2024-06-01T01:00:00.000Z", plan: "p", call: "edit_transaction", run: "r", entry: "edit-0" };
  const change = (field: string, intent: boolean) => ({ ...edit, legId: "a", field, ...(intent ? { intent } : {}) });
  // As apply logs them: an intent line per change, a line per change after the call, then the call's result
  const c = compare([leg("a"), leg("b")], [leg("a", { price: 3, description: "e" })], [
    change("price", true),
    change("description", true),
    change("description", false),
    change("price", false),
    { ...edit, result: "ok" },
    { ...edit, call: "bulk_edit_transactions", operation: "delete", legIds: ["b"], result: "ok" },
  ] as LogLine[]);
  assert.equal(changeCount({ before: "x", sharedTx: [], ...c }), 0);
  assert.equal(c.writes, 2);
});

test("a pairing with a new leg of our uploads is marked: an upload, not in the log, paired it", () => {
  const c = compare(
    [leg("a")],
    [leg("a"), leg("6700000000000000000000bb", { importType: "manual-csv", actionId: "action-a" })],
  );
  assert.match(
    changesMarkdown({ before: "x", sharedTx: [], ...c }, "y"),
    /leg a, ID row-a\): .*\(beside a new leg of our uploads\)/,
  );
});

test("what Summ did in answer to a delete still shows, marked", () => {
  const del = { time: "2024-06-01T01:00:00.000Z", plan: "p", run: "r" };
  const c = compare([leg("a"), leg("b", { actionId: "action-a" })], [leg("b", { actionId: "action-a" })], [
    { ...del, call: "bulk_edit_transactions", operation: "delete", legIds: ["a"] },
  ] as LogLine[]);
  assert.deepEqual(c.verification!.gone, []);
  assert.match(
    changesMarkdown({ before: "x", sharedTx: [], ...c }, "y"),
    /leg b, ID row-b\): .*\(a leg summ-sync wrote left it\)/,
  );
});

test("a pairing change shows: a leg's other legs or its action's category", () => {
  const c = compare([leg("a"), leg("b")], [leg("a"), leg("b", { actionId: "action-a" })]);
  assert.deepEqual(
    c.verification!.pairing.map((p) => [p.leg.legId, p.matesBefore, p.matesAfter]),
    [
      ["a", 0, 1],
      ["b", 0, 1],
    ],
  );
  assert.match(changesMarkdown({ before: "x", sharedTx: [], ...c }, "y"), /## Pairing changed[^#]*leg a, ID row-a/);
});

// ---- On files: which earlier snapshot, and a first pull

function stateDir(snapshots: Record<string, object>) {
  const dir = mkdtempSync(join(tmpdir(), "summ-changes-"));
  mkdirSync(join(dir, "snapshots"));
  const base = { version: 2, run: "/run", range: null, managedSources: ["s"], managedChains: ["THOR"], total: 0 };
  for (const [name, over] of Object.entries(snapshots)) {
    writeFileSync(join(dir, "snapshots", `${name}.json`), JSON.stringify({ ...base, actions: [], ...over }));
    writeFileSync(join(dir, "snapshots", `${name}.details.jsonl`), JSON.stringify({ run: "/run" }) + "\n");
  }
  return dir;
}

test("compares with the latest earlier snapshot of the same run, range and managed sources and chains", () => {
  const dir = stateDir({
    "2024-06-01T00-00-00": { takenAt: "2024-06-01T00:00:00.000Z", managedChains: ["MAYA", "THOR"] },
    "2024-06-02T00-00-00": { takenAt: "2024-06-02T00:00:00.000Z", range: { from: "2024-01-01", to: "2024-06-30" } },
    // Another run reads other actions' details: not compared
    "2024-06-03T00-00-00": { takenAt: "2024-06-03T00:00:00.000Z", run: "/other-run" },
    "2024-06-04T00-00-00": {
      takenAt: "2024-06-04T00:00:00.000Z",
      finishedAt: "2024-06-04T00:10:00.000Z",
      managedChains: ["THOR", "MAYA"],
    },
  });
  assert.equal(previousSnapshot(dir, "2024-06-04T00-00-00"), "2024-06-01T00-00-00");
  assert.equal(previousSnapshot(dir, "2024-06-03T00-00-00"), null);
  const line = writeChanges(dir, join(dir, "snapshots", "2024-06-04T00-00-00.json"), []);
  assert.match(
    line,
    /^Changes in Summ since 2024-06-01T00-00-00: 0; new legs of our uploads: 0; legs not read by one of the pulls: 0; /,
  );
  assert.match(readFileSync(join(dir, "snapshots", "2024-06-04T00-00-00.changes.md"), "utf8"), /^# Changes in Summ/);
});

test("pulls with no run dir are compared with each other", () => {
  const dir = stateDir({
    "2024-06-01T00-00-00": { takenAt: "2024-06-01T00:00:00.000Z", run: null },
    "2024-06-02T00-00-00": { takenAt: "2024-06-02T00:00:00.000Z" },
    "2024-06-03T00-00-00": { takenAt: "2024-06-03T00:00:00.000Z", run: null },
  });
  assert.equal(previousSnapshot(dir, "2024-06-03T00-00-00"), "2024-06-01T00-00-00");
});

test("a pull that began before the other finished is not compared with it (a resumed pull)", () => {
  const dir = stateDir({
    "2024-06-02T00-00-00": { takenAt: "2024-06-01T12:00:00.000Z" },
    "2024-06-03T00-00-00": { takenAt: "2024-06-01T00:00:00.000Z" },
  });
  assert.equal(previousSnapshot(dir, "2024-06-03T00-00-00"), null);
});

test("a first pull lists the actions that share a tx hash across imports", () => {
  const dir = stateDir({ "2024-06-01T00-00-00": { takenAt: "2024-06-01T00:00:00.000Z" } });
  const snapshot = join(dir, "snapshots", "2024-06-01T00-00-00.json");
  assert.match(
    writeChanges(dir, snapshot, ["x1", "x2"]),
    /^First pull of this scope: 2 actions share a tx hash with legs created over a day apart/,
  );
  const text = readFileSync(join(dir, "snapshots", "2024-06-01T00-00-00.changes.md"), "utf8");
  assert.match(text, /- action x1\n- action x2/);
  assert.ok(existsSync(snapshot));
});
