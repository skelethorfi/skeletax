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
  assert.equal(changeCount({ before: "x", heldTwice: [], ...c }), 3);
});

test("summ-sync's own writes between the pulls explain their changes", () => {
  const edit = { time: "2024-06-01T01:00:00.000Z", plan: "p", call: "edit_transaction", run: "r" };
  const c = compare([leg("a"), leg("b")], [leg("a", { price: 3 })], [
    { ...edit, legId: "a", field: "price" },
    { ...edit, call: "bulk_edit_transactions", operation: "delete", legIds: ["b"] },
  ] as LogLine[]);
  assert.equal(changeCount({ before: "x", heldTwice: [], ...c }), 0);
  assert.equal(c.writes, 2);
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
  assert.match(changesMarkdown({ before: "x", heldTwice: [], ...c }, "y"), /## Pairing changed[^#]*leg a, ID row-a/);
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

test("compares with the latest earlier snapshot of the same range and managed sources and chains, any run", () => {
  const dir = stateDir({
    "2024-06-01T00-00-00": { takenAt: "2024-06-01T00:00:00.000Z" },
    "2024-06-02T00-00-00": { takenAt: "2024-06-02T00:00:00.000Z", range: { from: "2024-01-01", to: "2024-06-30" } },
    "2024-06-03T00-00-00": { takenAt: "2024-06-03T00:00:00.000Z", run: "/other-run" },
    "2024-06-04T00-00-00": { takenAt: "2024-06-04T00:00:00.000Z", finishedAt: "2024-06-04T00:10:00.000Z" },
  });
  assert.equal(previousSnapshot(dir, "2024-06-04T00-00-00"), "2024-06-03T00-00-00");
  assert.equal(previousSnapshot(dir, "2024-06-02T00-00-00"), null);
  const line = writeChanges(dir, join(dir, "snapshots", "2024-06-04T00-00-00.json"), []);
  assert.match(line, /^Changes since 2024-06-03T00-00-00: 0 \(nothing moved/);
  assert.match(readFileSync(join(dir, "snapshots", "2024-06-04T00-00-00.changes.md"), "utf8"), /^# Changes in Summ/);
});

test("a first pull lists the actions that share a tx hash across imports", () => {
  const dir = stateDir({ "2024-06-01T00-00-00": { takenAt: "2024-06-01T00:00:00.000Z" } });
  const snapshot = join(dir, "snapshots", "2024-06-01T00-00-00.json");
  assert.match(writeChanges(dir, snapshot, ["x1", "x2"]), /^First pull of this scope: 2 actions share a tx hash/);
  const text = readFileSync(join(dir, "snapshots", "2024-06-01T00-00-00.changes.md"), "utf8");
  assert.match(text, /- action x1\n- action x2/);
  assert.ok(existsSync(snapshot));
});
