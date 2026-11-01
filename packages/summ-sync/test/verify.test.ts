import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLine, PlanFile } from "../src/apply.ts";
import type { DeleteEntry, EditEntry } from "../src/plan.ts";
import type { Leg, Snapshot, SnapshotEntry, SnapshotFile } from "../src/snapshot.ts";
import { runVerify, type VerifyInput, verifyMarkdown, verifyPlan } from "../src/verify.ts";

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
  source: "thorchain",
  importType: "manual-csv",
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
const file = (legs: Leg[], extra: SnapshotEntry[] = [], takenAt = "2024-06-01T00:00:00.000Z"): SnapshotFile => ({
  version: 2,
  takenAt,
  total: legs.length,
  actions: [
    ...[...new Set(legs.map((l) => l.actionId))].map((id) => ({
      id,
      txHash: "h",
      category: "trade",
      tags: [],
      detail: true as const,
    })),
    ...extra,
  ],
});
const plan = (over: Partial<PlanFile> = {}): PlanFile =>
  ({
    snapshot: "before",
    run: "/run",
    delete: [],
    edit: [],
    upload: [],
    categorise: [],
    ...over,
  }) as PlanFile;
const FLAGS = { approveDeletes: true, approveFiled: false };
const log = (over: Partial<LogLine>): LogLine => ({
  time: "2024-06-01T01:00:00.000Z",
  plan: "p",
  call: "edit_transaction",
  run: "r",
  ...over,
});
const start = log({ call: "apply-start", flags: FLAGS });
const done = log({ call: "apply-stop", reason: "complete" });

function run(
  before: Leg[],
  after: Leg[],
  p: PlanFile,
  lines: LogLine[] = [start, done],
  lists: { b?: SnapshotEntry[]; a?: SnapshotEntry[] } = {},
) {
  const input: VerifyInput = {
    plan: p,
    planName: "p",
    before: snap(before),
    beforeFile: file(before, lists.b),
    after: snap(after),
    afterFile: file(after, lists.a),
    lines,
  };
  return verifyPlan(input);
}
const edit = (
  legId: string,
  field: string,
  summ: string | number,
  desired: string | number,
  over: Partial<EditEntry> = {},
): EditEntry => ({
  id: "row",
  filed: false,
  actionId: `action-${legId}`,
  changes: [{ leg: "base", legId, field, summ, desired }],
  ...over,
});
const del = (legIds: string[], over: Partial<DeleteEntry> = {}): DeleteEntry => ({
  id: null,
  summId: "x",
  filed: false,
  legIds,
  actionIds: [],
  reason: "r",
  otherLegs: 0,
  ...over,
});
const stateOf = (v: ReturnType<typeof run>, key: string) => v.entries.find((e) => e.key === key)?.state;

test("nothing moved: every section is empty", () => {
  const v = run([leg("a")], [leg("a")], plan());
  for (const list of [
    v.changed,
    v.gone,
    v.added,
    v.pairing,
    v.summFeesGone,
    v.summFeesAdded,
    v.notRead,
    v.newlyRead,
    v.listBefore,
    v.listAfter,
  ]) {
    assert.deepEqual(list, []);
  }
});

test("action ids and updatedAt move on every recalculation, and are no change", () => {
  const v = run([leg("a", { updatedAt: "1" })], [leg("a", { actionId: "action-a", updatedAt: "2" })], plan());
  assert.deepEqual(v.changed, []);
});

test("a planned edit that holds has landed, and one that does not is said", () => {
  const p = plan({ edit: [edit("a", "trade", "sell", "buy")] });
  assert.equal(stateOf(run([leg("a")], [leg("a", { trade: "buy" })], p), "edit-0"), "landed");
  const failed = run([leg("a")], [leg("a")], p, [start, log({ entry: "edit-0", legId: "a", field: "trade" }), done]);
  assert.equal(stateOf(failed, "edit-0"), "NOT LANDED");
  assert.match(verifyMarkdown(failed, "p", "x", "y"), /edit-0 NOT LANDED[\s\S]*trade: sell, the plan said buy/);
});

test("a change on a leg named for something else is still outside the plan", () => {
  const p = plan({ edit: [edit("a", "trade", "sell", "buy")] });
  const v = run([leg("a")], [leg("a", { trade: "buy", quantity: 3 })], p);
  assert.deepEqual(
    v.changed.map((c) => c.field),
    ["quantity"],
  );
  assert.equal(v.changed[0].history, "last line");
  assert.match(verifyMarkdown(v, "p", "x", "y"), /quantity: 1 to 3.*Last in Summ: last line/);
});

test("each field of a leg outside the plan is compared", () => {
  for (const over of [
    { trade: "x" },
    { currency: "BTC" },
    { quantity: 2 },
    { from: "x" },
    { to: "x" },
    { price: 3 },
    { description: "x" },
    { id: "x" },
    { source: "x" },
    { importType: "x" },
    { comments: ["x"] },
    { blockchain: "x" },
    { feeQuantity: 1 },
  ]) {
    assert.equal(run([leg("a")], [leg("a", over)], plan()).changed.length, 1, JSON.stringify(over));
  }
});

test("a price holds what apply read back, under the USD mark, with its rate", () => {
  const p = plan({ edit: [edit("a", "price", 2, 10)] });
  const write = log({ entry: "edit-0", legId: "a", field: "price", value: 10, after: 15 });
  const v = run([leg("a")], [leg("a", { price: 15, priceValueCurrency: "USD" })], p, [start, write, done]);
  assert.equal(stateOf(v, "edit-0"), "landed");
  assert.deepEqual(v.entries[0].rates, ["RUNE 1.5000"]);
  assert.deepEqual(v.changed, []);
  const noMark = run([leg("a")], [leg("a", { price: 15 })], p, [start, write, done]);
  assert.match(noMark.entries[0].problems[0], /no USD mark/);
  const moved = run([leg("a")], [leg("a", { price: 16, priceValueCurrency: "USD" })], p, [start, write, done]);
  assert.match(moved.entries[0].problems[0], /read back 15/);
  const unread = run([leg("a")], [leg("a", { price: 15, priceValueCurrency: "USD" })], p, [
    start,
    log({ ...write, after: null }),
    done,
  ]);
  assert.match(unread.entries[0].problems[0], /unconfirmed/);
});

test("an intent line alone proves no price", () => {
  const p = plan({ edit: [edit("a", "price", 2, 10)] });
  const intent = log({ entry: "edit-0", legId: "a", field: "price", value: 10, intent: true });
  const v = run([leg("a")], [leg("a", { price: 10, priceValueCurrency: "USD" })], p, [start, intent, done]);
  assert.match(v.entries[0].problems[0], /no write was logged/);
});

test("a value match compares what was sold with what was bought", () => {
  const entry = edit("base", "trade", "sell", "sell", {
    actionId: "t",
    match: { legId: "quote", baseLegId: "base", summ: 0, desired: null },
  });
  const legs = (price: number) => [
    leg("base", { actionId: "t", trade: "sell", price: 2, quantity: 10 }),
    leg("quote", { actionId: "t", side: "incoming", trade: "buy", price, quantity: 4 }),
  ];
  assert.equal(stateOf(run(legs(5), legs(5), plan({ edit: [entry] })), "edit-0"), "landed");
  assert.equal(
    stateOf(run(legs(9), legs(9), plan({ edit: [entry] }), [start, log({ entry: "edit-0" }), done]), "edit-0"),
    "NOT LANDED",
  );
});

test("entries never meant to land are said to be so, not failures", () => {
  const p = plan({
    delete: [del(["a"]), del(["f"], { filed: true })],
    edit: [edit("e", "trade", "sell", "buy", { filed: true })],
    categorise: [edit("c", "trade", "deposit", "bridgeTradeIn")],
    upload: [{ file: "f.csv", filed: false, ids: ["row-new"] }],
  });
  const legs = [leg("a"), leg("f"), leg("e"), leg("c")];
  const v = run(legs, legs, p, [
    log({ call: "apply-start", flags: { approveDeletes: false, approveFiled: false } }),
    done,
  ]);
  assert.equal(stateOf(v, "delete-0"), "not selected");
  assert.equal(stateOf(v, "delete-1"), "not selected");
  assert.equal(stateOf(v, "edit-0"), "not selected");
  assert.equal(stateOf(v, "categorise-0"), "held back");
  assert.deepEqual(v.notUploaded, ["row-new"]);
});

test("the flags are those of the run that wrote, not the first start", () => {
  const p = plan({ delete: [del(["a"])] });
  const lines = [
    log({ call: "apply-start", run: "1", flags: { approveDeletes: false, approveFiled: false } }),
    log({ call: "apply-start", run: "2", flags: FLAGS }),
    log({ run: "2", call: "bulk_edit_transactions", entry: "delete-0", operation: "delete", legIds: ["a"] }),
    log({ run: "2", call: "apply-stop", reason: "complete" }),
  ];
  assert.deepEqual(run([leg("a")], [leg("a")], p, lines).flags, FLAGS);
  assert.equal(stateOf(run([leg("a")], [leg("a")], p, lines), "delete-0"), "NOT LANDED");
});

test("after a stop, an entry with no lines was not reached; one with lines did not land", () => {
  const p = plan({ edit: [edit("a", "trade", "sell", "buy"), edit("b", "trade", "sell", "buy")] });
  const lines = [
    start,
    log({ entry: "edit-0", legId: "a", field: "trade" }),
    log({ call: "apply-stop", reason: "conflict" }),
  ];
  const v = run([leg("a"), leg("b")], [leg("a"), leg("b")], p, lines);
  assert.equal(stateOf(v, "edit-0"), "NOT LANDED");
  assert.equal(stateOf(v, "edit-1"), "not reached");
  assert.equal(v.stop, "conflict");
  assert.match(verifyMarkdown(v, "p", "x", "y"), /Last apply stop: conflict/);
});

test("deleted legs gone have landed; ones still there have not", () => {
  const p = plan({ delete: [del(["a"])] });
  const v = run([leg("a"), leg("b")], [leg("b")], p);
  assert.equal(stateOf(v, "delete-0"), "landed");
  assert.deepEqual(v.gone, []);
});

test("a leg gone that the plan did not name is reported", () => {
  const v = run([leg("a"), leg("b")], [leg("b")], plan());
  assert.deepEqual(
    v.gone.map((l) => l.legId),
    ["a"],
  );
});

test("a leg gone whose tx sits on a listed action with no detail was not read, not gone", () => {
  const unread = { id: "other", txHash: "row-a", category: "trade", tags: [] };
  const v = run([leg("a")], [], plan(), [start, done], { a: [unread] });
  assert.deepEqual(v.gone, []);
  assert.deepEqual(
    v.notRead.map((l) => l.legId),
    ["a"],
  );
});

test("uploaded rows are expected, a made-up leg beside them is not", () => {
  const p = plan({ upload: [{ file: "f.csv", filed: false, ids: ["row-new"] }] });
  const fresh = "ffffffffffffffffffffffff";
  const fresh2 = "fffffffffffffffffffffffe";
  const after = [
    leg("up", { id: "row-new" }),
    leg("fee", { id: "row-new", side: "fees", trade: "fee" }),
    leg(fresh, { id: "0xtx", trade: "withdrawal", source: "manual", importType: "soft-transfer" }),
    leg(fresh2, { id: "row-new2" }),
  ];
  const v = run([], after, p);
  assert.deepEqual(v.uploaded, ["row-new"]);
  assert.deepEqual(
    v.added.map((l) => l.legId),
    [fresh, fresh2],
  );
});

test("a new leg older than the first pull entered the details; it is not new", () => {
  const old = "5ffffffffffffffffffffff0";
  const v = run([], [leg(old)], plan());
  assert.deepEqual(v.added, []);
  assert.deepEqual(
    v.newlyRead.map((l) => l.legId),
    [old],
  );
  const unread = run([], [leg("zz", { id: "seen" })], plan(), [start, done], {
    b: [{ id: "x", txHash: "seen", category: "c", tags: [] }],
  });
  assert.deepEqual(
    unread.newlyRead.map((l) => l.legId),
    ["zz"],
  );
});

test("an upload beside its old copy is flagged", () => {
  const p = plan({ upload: [{ file: "f.csv", filed: false, ids: ["same"] }] });
  const v = run([leg("old", { id: "same" })], [leg("old", { id: "same" }), leg("new", { id: "same" })], p);
  assert.deepEqual(
    v.besideOldCopy.map((l) => l.legId),
    ["old"],
  );
  assert.match(verifyMarkdown(v, "p", "x", "y"), /counted twice/);
  const remade = run([leg("old", { id: "same" })], [leg("new", { id: "same" })], { ...p, delete: [del(["old"])] });
  assert.deepEqual(remade.besideOldCopy, []);
});

test("Summ's fee legs issued again under new ids are the same legs; others are listed apart", () => {
  const fee = { importType: "assumed-fee", side: "fees" as const, id: "tx", trade: "fee" };
  const v = run([leg("a", fee)], [leg("b", fee)], plan());
  assert.equal(v.summFeesReissued, 1);
  assert.deepEqual([v.gone, v.added, v.summFeesGone, v.summFeesAdded], [[], [], [], []]);
  const other = run([leg("a", fee)], [leg("b", { ...fee, quantity: 2 })], plan());
  assert.equal(other.summFeesReissued, 0);
  assert.equal(other.summFeesGone.length, 1);
  assert.equal(other.summFeesAdded.length, 1);
});

test("a pairing outside the plan shows, though no field of a leg moved", () => {
  const before = [leg("a"), leg("b")];
  const after = [leg("a", { actionId: "both" }), leg("b", { actionId: "both" })];
  const v = run(before, after, plan());
  assert.deepEqual(v.changed, []);
  assert.deepEqual(
    v.pairing.map((p) => [p.leg.legId, p.matesBefore, p.matesAfter]),
    [
      ["a", 0, 1],
      ["b", 0, 1],
    ],
  );
});

test("a pairing with a leg of the plan, or an uploaded row, is explained", () => {
  const before = [leg("a"), leg("b")];
  const after = [leg("a", { trade: "buy", actionId: "both" }), leg("b", { actionId: "both" })];
  assert.deepEqual(run(before, after, plan({ edit: [edit("a", "trade", "sell", "buy")] })).pairing, []);
  const upload = plan({ upload: [{ file: "f", filed: false, ids: ["n"] }] });
  assert.deepEqual(
    run([leg("a")], [leg("a", { actionId: "both" }), leg("up", { id: "n", actionId: "both" })], upload).pairing,
    [],
  );
});

test("a categorise that landed names its action, for one that failed to pair", () => {
  const p = plan({ categorise: [edit("a", "trade", "deposit", "bridgeTradeIn")] });
  const v = run([leg("a", { trade: "deposit" })], [leg("a", { trade: "bridgeTradeIn" })], p);
  assert.equal(v.entries[0].action, "trade, with 0 other legs");
});

test("to be ignored: a leg left in place is said, and one not ignored is a problem", () => {
  const p = plan({ categorise: [edit("a", "trade", "deposit", "bridgeTradeIn", { ignore: ["m"] })] });
  const after = [leg("a", { trade: "bridgeTradeIn" }), leg("m")];
  assert.match(run([leg("a"), leg("m")], after, p).entries[0].problems[0], /to be ignored/);
  const left = log({ entry: "categorise-0", call: "skip", leftLeg: "m" });
  const v = run([leg("a"), leg("m")], after, p, [start, left, done]);
  assert.equal(stateOf(v, "categorise-0"), "landed");
  assert.deepEqual(v.left, ["m"]);
  assert.equal(
    stateOf(run([leg("a"), leg("m")], [after[0], leg("m", { trade: "ignoreOut" })], p), "categorise-0"),
    "landed",
  );
});

test("listed actions with no detail compare as multisets, without the review tag", () => {
  const entry = (over: Partial<SnapshotEntry>): SnapshotEntry => ({
    id: "x",
    txHash: "h1",
    category: "c",
    tags: [],
    ...over,
  });
  const same = run([], [], plan(), [start, done], { b: [entry({})], a: [entry({ id: "y", tags: ["REVIEWED"] })] });
  assert.deepEqual([same.listBefore, same.listAfter], [[], []]);
  const twice = run([], [], plan(), [start, done], { b: [entry({})], a: [entry({}), entry({})] });
  assert.deepEqual(twice.listAfter, ["h1 c"]);
  const recat = run([], [], plan(), [start, done], { b: [entry({})], a: [entry({ category: "d" })] });
  assert.deepEqual([recat.listBefore, recat.listAfter], [["h1 c"], ["h1 d"]]);
  const hidden = run([], [], plan(), [start, done], { b: [entry({})], a: [entry({ tags: ["SPAM"] })] });
  assert.deepEqual(hidden.listAfter, ["h1 c SPAM"]);
});

// ---- runVerify: its refusals, from files

function state(lines: LogLine[], over: Partial<PlanFile> = {}, snapshots: Record<string, object> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "summ-verify-"));
  mkdirSync(join(dir, "snapshots"));
  const planDir = join(dir, "plans", "p");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "plan.json"), JSON.stringify(plan(over)));
  const header = (run: string) => JSON.stringify({ run }) + "\n";
  const write = (name: string, content: object) => {
    writeFileSync(join(dir, "snapshots", `${name}.json`), JSON.stringify(content));
    writeFileSync(join(dir, "snapshots", `${name}.details.jsonl`), header("/run"));
  };
  const base = { version: 2, run: "/run", range: null, managedSources: [], managedChains: [], total: 0, actions: [] };
  write("2024-06-01T00-00-00", {
    ...base,
    takenAt: "2024-06-01T00:00:00.000Z",
    finishedAt: "2024-06-01T00:30:00.000Z",
  });
  write("2024-06-02T00-00-00", {
    ...base,
    takenAt: "2024-06-01T12:00:00.000Z",
    finishedAt: "2024-06-02T00:00:00.000Z",
    ...snapshots.after,
  });
  writeFileSync(join(dir, "apply-log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, planDir };
}
const onSnapshot = { snapshot: "2024-06-01T00-00-00" };

test("verify writes its report in the plan's folder and changes nothing else", () => {
  const { dir, planDir } = state([start, done], onSnapshot);
  const before = readFileSync(join(dir, "apply-log.jsonl"), "utf8");
  const written = runVerify(dir, planDir);
  assert.equal(written, join(planDir, "verify-2024-06-02T00-00-00.md"));
  assert.match(readFileSync(written, "utf8"), /# Verify p/);
  assert.equal(readFileSync(join(dir, "apply-log.jsonl"), "utf8"), before);
});

for (const [name, setup, pattern] of [
  ["a plan not applied", () => state([], onSnapshot), /has not been applied/],
  [
    "a pull begun before the plan's last write",
    () => state([start, log({ time: "2024-06-01T13:00:00.000Z", call: "apply-stop" })], onSnapshot),
    /pull again/,
  ],
  [
    "another plan's write between the snapshots",
    () => state([start, done, log({ plan: "other", time: "2024-06-01T20:00:00.000Z" })], onSnapshot),
    /other also wrote/,
  ],
  [
    "a snapshot from before details",
    () => state([start, done], onSnapshot, { after: { version: 1 } }),
    /before pulls kept/,
  ],
  ["another run", () => state([start, done], onSnapshot, { after: { run: "/other" } }), /differ in run/],
  [
    "another range",
    () => state([start, done], onSnapshot, { after: { range: { from: "a", to: "b" } } }),
    /differ in range/,
  ],
  ["a snapshot pruned", () => state([start, done], { snapshot: "gone" }), /is gone/],
  ["a plan on the latest snapshot", () => state([start, done], { snapshot: "2024-06-02T00-00-00" }), /pull first/],
] as [string, () => { dir: string; planDir: string }, RegExp][]) {
  test(`verify refuses ${name}, and writes nothing`, () => {
    const { dir, planDir } = setup();
    assert.throws(() => runVerify(dir, planDir), pattern);
    assert.equal(existsSync(join(planDir, "verify-2024-06-02T00-00-00.md")), false);
  });
}

test("verify refuses while an apply holds the lock, and a folder with no plan", () => {
  const { dir, planDir } = state([start, done], onSnapshot);
  assert.throws(() => runVerify(dir, join(dir, "plans")), /no plan\.json/);
  writeFileSync(join(dir, ".lock"), "1");
  assert.throws(() => runVerify(dir, planDir), /lock/);
});

test("verify counts a write after the second pull finished as no one's", () => {
  const late = log({ plan: "other", time: "2024-06-03T00:00:00.000Z" });
  const { dir, planDir } = state([start, done, late], onSnapshot);
  assert.ok(runVerify(dir, planDir));
});

test("a plan of uploads alone, with none in Summ, has not been applied", () => {
  const { dir, planDir } = state([], { ...onSnapshot, upload: [{ file: "f", filed: false, ids: ["row"] }] });
  assert.throws(() => runVerify(dir, planDir), /has not been applied/);
});
