import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  affectedActions,
  applyPlan,
  checkFresh,
  runApply,
  type ApplyOptions,
  type LogLine,
  type PlanFile,
  type ToolCaller,
  undoHandle,
} from "../src/apply.ts";
import { type FakeLeg, FakeSumm } from "./fake-summ.ts";
import type { DeleteEntry, EditEntry } from "../src/plan.ts";
import { readApplyLog } from "../src/state.ts";

// Every value below is made up.
const OPTS: ApplyOptions = { approveDeletes: false, approveFiled: false, dryRun: false };

/** The pre-image a log line names (state dir relative; the fake's plan folder is plans/p). */
const preOf = (planDir: string, line?: { pre?: unknown }) => {
  assert.match(String(line?.pre), /^plans\/p\/pre\//);
  return JSON.parse(readFileSync(join(planDir, "pre", basename(String(line?.pre))), "utf8"));
};

const edit = (over: Partial<EditEntry> = {}): EditEntry => ({
  id: "row-1",
  filed: false,
  actionId: "stale-action",
  changes: [{ leg: "base", legId: "leg-1", field: "trade", summ: "withdrawal", desired: "bridgeTradeOut" }],
  ...over,
});

const del = (over: Partial<DeleteEntry> = {}): DeleteEntry => ({
  id: null,
  summId: "row-gone",
  filed: false,
  legIds: ["leg-9"],
  actionIds: ["stale-action-9"],
  reason: "no row in the run",
  otherLegs: 0,
  ...over,
});

function planFile(over: Partial<PlanFile> = {}): PlanFile {
  return {
    snapshot: "snap",
    run: "/run",
    createdAt: "2024-08-01T00:00:00.000Z",
    managedChains: ["THOR"],
    managedSources: ["csv-source"],
    filedBefore: "2024-07-01",
    timezone: "UTC",
    periods: [],
    counts: {},
    adopted: [],
    superseded: [],
    delete: [],
    edit: [],
    upload: [],
    categorise: [],
    report: [],
    held: [],
    overridden: [],
    notes: [],
    ...over,
  };
}

/** A run that must stop: what it said, and the log so far. */
async function stops(summ: FakeSumm, plan: PlanFile, pattern: RegExp, opts: Partial<ApplyOptions> = {}) {
  const log: Omit<LogLine, "time" | "plan">[] = [];
  const state = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  await assert.rejects(
    applyPlan(
      summ,
      plan,
      { ...OPTS, ...opts },
      (l) => log.push(l),
      () => {},
      0,
      { stateDir: state, planDir: join(state, "plans", "p") },
    ),
    pattern,
  );
  return { log };
}

async function run(summ: FakeSumm, plan: PlanFile, opts: Partial<ApplyOptions> = {}) {
  const log: Omit<LogLine, "time" | "plan">[] = [];
  const state = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  const planDir = join(state, "plans", "p");
  const result = await applyPlan(
    summ,
    plan,
    { ...OPTS, ...opts },
    (l) => log.push(l),
    () => {},
    0,
    { stateDir: state, planDir },
  );
  return { result, log, state, planDir };
}

test("an edit looks the leg up again, edits it in its current action and logs the change with its undo handle", async () => {
  const summ = new FakeSumm();
  summ.add("current-action", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  const { result, log } = await run(summ, planFile({ categorise: [edit()] }));
  assert.equal(result.edited, 1);
  const call = summ.calls.find((c) => c.name === "edit_transaction");
  assert.deepEqual(call?.args, {
    actionId: "current-action",
    edits: [{ transactionId: "leg-1", updates: { trade: "bridgeTradeOut" } }],
  });
  const change = log.find((l) => l.legId === "leg-1" && !l.intent);
  assert.deepEqual([change?.field, change?.value, change?.undo], ["trade", "bridgeTradeOut", "undo1abcdef"]);
});

const STALE = "2026-01-01T00:00:00.000Z";
const priceChange = (desired = 2.5): EditEntry["changes"] => [
  { leg: "base", legId: "leg-1", field: "price", summ: 3.9, desired },
];
const pricedLeg = () => ({ _id: "leg-1", trade: "income", quantity: "1", price: 3.9, updatedAt: STALE });

test("a price edit logs its line first, sends USD, and logs the price read straight from the rebuilt action", async () => {
  const summ = new FakeSumm();
  summ.add("a", [pricedLeg()]);
  const { result, log } = await run(summ, planFile({ edit: [edit({ changes: priceChange() })] }));
  assert.equal(result.edited, 1);
  const edits = summ.calls.filter((c) => c.name === "edit_transaction");
  assert.deepEqual(edits[0].args, {
    actionId: "a",
    edits: [{ transactionId: "leg-1", updates: { price: 2.5, priceValueCurrency: "USD" } }],
  });
  const lines = log.filter((l) => l.legId === "leg-1");
  assert.deepEqual(
    lines.map((l) => [l.intent, l.value, "after" in l]),
    [
      [true, 2.5, false],
      [undefined, 2.5, true],
    ],
  );
  // Read by the id the edit named, never through the search
  const last = summ.calls.at(-1);
  assert.deepEqual([last?.name, last?.args.actionId], ["inspect_transaction", "rebuilt1"]);
  assert.equal(lines[1].after, 2.5);
});

test("a price edit that moved nothing is confirmed by updatedAt, at the first read", async () => {
  const summ = new FakeSumm();
  summ.add("a", [pricedLeg()]);
  const moved = summ.callTool.bind(summ);
  // Summ converts the same USD at the same rate: the local price stays
  summ.callTool = async (name: string, args: Record<string, unknown>) => {
    const text = await moved(name, args);
    return name === "inspect_transaction" ? text.replace('"price":2.5', '"price":3.9') : text;
  };
  const { log } = await run(summ, planFile({ edit: [edit({ changes: priceChange() })] }));
  assert.equal(log.find((l) => l.legId === "leg-1" && !l.intent)?.after, 3.9);
  assert.equal(summ.calls.filter((c) => c.name === "inspect_transaction").length, 2);
});

test("a price edit that never shows as landed logs no price, and stops", async () => {
  const summ = new FakeSumm();
  summ.add("a", [pricedLeg()]);
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name: string, args: Record<string, unknown>) => {
    const text = await real(name, args);
    return name === "inspect_transaction" ? text.replace(/"updatedAt":"[^"]*"/, `"updatedAt":"${STALE}"`) : text;
  };
  const { log } = await stops(summ, planFile({ edit: [edit({ changes: priceChange() })] }), /do not show/);
  assert.equal(log.find((l) => l.legId === "leg-1" && !l.intent)?.after, null);
});

test("a price edit whose result names no action stops, and the log still holds it", async () => {
  const summ = new FakeSumm();
  summ.add("a", [pricedLeg()]);
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name: string, args: Record<string, unknown>) => {
    const text = await real(name, args);
    return name === "edit_transaction" ? text.replace(/Affected Action IDs.*\n/, "") : text;
  };
  const { log } = await stops(summ, planFile({ edit: [edit({ changes: priceChange() })] }), /names no affected action/);
  assert.equal(log.find((l) => l.legId === "leg-1" && !l.intent)?.after, null);
});

test("affectedActions reads one or several ids from Summ's wording", () => {
  assert.deepEqual(affectedActions("x\nAffected Action IDs (rebuilt — these replace the requested id): abc\nEditing"), [
    "abc",
  ]);
  assert.deepEqual(
    affectedActions(
      "Affected Action IDs (rebuilt — these replace the requested ids, and grouping can change the count): a, b\n",
    ),
    ["a", "b"],
  );
  assert.deepEqual(affectedActions("Patched"), []);
});

test("several changes of one leg go in one edit", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  const changes: EditEntry["changes"] = [
    { leg: "base", legId: "leg-1", field: "trade", summ: "withdrawal", desired: "fee" },
    { leg: "base", legId: "leg-1", field: "quantity", summ: 1, desired: 2 },
  ];
  await run(summ, planFile({ edit: [edit({ changes })] }));
  const call = summ.calls.find((c) => c.name === "edit_transaction");
  assert.deepEqual(call?.args.edits, [{ transactionId: "leg-1", updates: { trade: "fee", quantity: 2 } }]);
});

test("a leg that changed since the pull stops the run, and is not edited", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "deposit", quantity: "1" }]);
  summ.add("b", [{ _id: "leg-2", trade: "withdrawal", quantity: "1" }]);
  const next = edit({ id: "row-2", changes: [{ ...edit().changes[0], legId: "leg-2" }] });
  await stops(summ, planFile({ categorise: [edit(), next] }), /trade of leg leg-1 is "deposit"/);
  assert.equal(
    summ.calls.some((c) => c.name === "edit_transaction"),
    false,
  );
});

const MADE_UP: FakeLeg = { _id: "made-up", trade: "deposit", quantity: "1", importType: "soft-transfer" };

test("after categorising, the receive Summ made up is ignored by its own action id once it is alone", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }, { ...MADE_UP }]);
  const { result, log } = await run(summ, planFile({ categorise: [edit({ ignore: ["made-up"] })] }));
  assert.equal(result.edited, 1);
  const ignore = summ.calls.find((c) => c.name === "bulk_edit_transactions");
  const alone = (ignore?.args.actionIds as string[])[0];
  assert.match(alone, /^alone/);
  assert.equal(summ.leg("made-up")?.trade, "ignoreIn");
  const line = log.find((l) => l.operation === "ignore" && !l.intent);
  assert.deepEqual([line?.legIds, line?.undo, line?.field], [["made-up"], line?.undo, undefined]);
});

test("a made-up leg already on its own is ignored without an edit", async () => {
  const summ = new FakeSumm();
  summ.add("b", [{ ...MADE_UP }]);
  const { result } = await run(summ, planFile({ categorise: [edit({ changes: [], ignore: ["made-up"] })] }));
  assert.equal(result.edited, 0);
  assert.equal(summ.leg("made-up")?.trade, "ignoreIn");
});

test("a made-up leg still in an action with other legs stops the run, and is not ignored", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }, { ...MADE_UP }]);
  await stops(
    summ,
    planFile({ categorise: [edit({ ignore: ["made-up"] })] }),
    /still shares its action with 1 other legs/,
  );
  assert.equal(
    summ.calls.some((c) => c.name === "bulk_edit_transactions"),
    false,
  );
});

test("a made-up leg is not ignored when its send stopped the run", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "deposit", quantity: "1" }, { ...MADE_UP }]);
  await stops(summ, planFile({ categorise: [edit({ ignore: ["made-up"] })] }), /trade of leg leg-1/);
  assert.equal(
    summ.calls.some((c) => c.name === "bulk_edit_transactions"),
    false,
  );
});

test("a leg no longer in Summ stops the run", async () => {
  await stops(new FakeSumm(), planFile({ edit: [edit()] }), /no longer in Summ/);
});

test("filed-year entries are applied only with --approve-filed, and then only they", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  summ.add("b", [{ _id: "leg-2", trade: "withdrawal", quantity: "1" }]);
  const plan = planFile({
    categorise: [edit({ filed: true }), edit({ id: "row-2", changes: [{ ...edit().changes[0], legId: "leg-2" }] })],
  });
  const current = await run(summ, plan);
  assert.equal(current.result.edited, 1);
  assert.equal(summ.calls.find((c) => c.name === "edit_transaction")?.args.actionId, "b");
  const filed = await run(summ, plan, { approveFiled: true });
  assert.equal(filed.result.edited, 1);
  assert.equal(summ.calls.filter((c) => c.name === "edit_transaction")[1].args.actionId, "a");
});

test("a dry run looks up and checks but writes nothing and logs nothing", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  summ.add("d", [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }]);
  const { result, log } = await run(summ, planFile({ categorise: [edit()], delete: [del()] }), {
    dryRun: true,
    approveDeletes: true,
  });
  assert.deepEqual(
    summ.calls.map((c) => c.name).filter((n) => n !== "inspect_transaction"),
    [],
  );
  assert.equal(result.edited, 0);
  assert.deepEqual(log, []);
});

test("deletes need --approve-deletes", async () => {
  const summ = new FakeSumm();
  summ.add("d", [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }]);
  const { result } = await run(summ, planFile({ delete: [del()] }));
  assert.equal(result.deleted, 0);
  assert.equal(summ.calls.length, 0);
});

test("a delete looks its legs up by _id and deletes only the actions that hold nothing else, by action id", async () => {
  const summ = new FakeSumm();
  summ.add("unrelated", [{ _id: "their-leg", trade: "deposit", quantity: "1" }]);
  summ.add("d", [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }]);
  const { result, log } = await run(summ, planFile({ delete: [del()] }), { approveDeletes: true });
  assert.equal(result.deleted, 1);
  const call = summ.calls.find((c) => c.name === "bulk_edit_transactions");
  assert.deepEqual(call?.args, { actionIds: ["d"], operation: { type: "delete" } });
  assert.deepEqual([...summ.actions.keys()], ["unrelated"]);
  assert.equal(log[0].operation, "delete");
});

test("a dry run saves no pre-image", async () => {
  const summ = new FakeSumm();
  summ.add("d", [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }]);
  const dry = await run(summ, planFile({ delete: [del()] }), { approveDeletes: true, dryRun: true });
  assert.equal(existsSync(join(dry.planDir, "pre")), false);
});

test("a leg that shares its action is split off by an ignore edit, then its own action is deleted", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "fee", quantity: "0.02", side: "fees" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  const { result, log, planDir } = await run(summ, planFile({ delete: [del({ otherLegs: 1 })] }), {
    approveDeletes: true,
  });
  assert.deepEqual([result.split, result.deleted], [1, 1]);
  const editCall = summ.calls.find((c) => c.name === "edit_transaction");
  assert.deepEqual(editCall?.args, {
    actionId: "d",
    edits: [{ transactionId: "leg-9", updates: { trade: "ignoreOut" } }],
  });
  const deleteCall = summ.calls.find((c) => c.name === "bulk_edit_transactions");
  assert.match((deleteCall?.args.actionIds as string[])[0], /^ignored/);
  // the legs that stay are untouched, in their rebuilt action
  assert.deepEqual([...summ.actions.values()], [[{ _id: "their-leg", trade: "deposit", quantity: "1" }]]);
  // both actions saved: the shared one before the edit, the split-off one before the delete
  assert.deepEqual(
    preOf(
      planDir,
      log.find((l) => l.legId === "leg-9"),
    ).actions[0].action._id,
    "d",
  );
  assert.match(preOf(planDir, log.at(-1)).actions[0].action._id, /^ignored/);
  assert.deepEqual(
    log.filter((l) => l.field).map((l) => [l.call, l.kind, l.legId, l.field, l.from, l.value, l.intent, l.undo]),
    [
      ["edit_transaction", "split", "leg-9", "trade", "fee", "ignoreOut", true, undefined],
      ["edit_transaction", "split", "leg-9", "trade", "fee", "ignoreOut", undefined, log.find((l) => l.undo)?.undo],
    ],
  );
});

test("a leg the plan saw alone but that Summ has paired since is split off too", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "withdrawal", quantity: "1" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  const { result } = await run(summ, planFile({ delete: [del()] }), { approveDeletes: true });
  assert.deepEqual([result.split, result.deleted], [1, 1]);
});

test("several legs of one entry in one shared action are split off in one edit; a second entry on the same action is then deleted alone", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "withdrawal", quantity: "1", side: "outgoing" },
    { _id: "leg-9-fee", trade: "fee", quantity: "0.02", side: "fees" },
    { _id: "leg-8", trade: "deposit", quantity: "1" },
    { _id: "their-leg", trade: "deposit", quantity: "3" },
  ]);
  const first = del({ legIds: ["leg-9", "leg-9-fee"], otherLegs: 2 });
  const second = del({ summId: "row-gone-2", legIds: ["leg-8"], otherLegs: 3 });
  const { result } = await run(summ, planFile({ delete: [first, second] }), { approveDeletes: true });
  assert.deepEqual([result.split, result.deleted], [2, 2]);
  const edits = summ.calls
    .filter((c) => c.name === "edit_transaction")
    .map((c) => (c.args.edits as { transactionId: string }[]).map((e) => e.transactionId));
  assert.deepEqual(edits, [["leg-9", "leg-9-fee"], ["leg-8"]]);
  assert.deepEqual(
    [...summ.actions.values()].flat().map((l) => l._id),
    ["their-leg"],
  );
});

test("the receive Summ made up for a deleted send is ignored once it is alone", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "withdrawal", quantity: "1", side: "outgoing" },
    { _id: "made-up", trade: "deposit", quantity: "1", importType: "soft-transfer" },
  ]);
  const { result, log } = await run(summ, planFile({ delete: [del({ otherLegs: 1 })] }), { approveDeletes: true });
  assert.equal(result.deleted, 1);
  assert.deepEqual(
    [...summ.actions.values()].flat().map((l) => [l._id, l.trade]),
    [["made-up", "ignoreIn"]],
  );
  assert.equal(log.at(-1)?.operation, "ignore");
});

test("a leg ignored by no write of this plan that still shares its action stops the run, and is not edited", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "ignoreOut", quantity: "1", side: "outgoing" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  await stops(summ, planFile({ delete: [del({ otherLegs: 1 })] }), /already ignored/, { approveDeletes: true });
  assert.equal(
    summ.calls.some((c) => c.name !== "inspect_transaction"),
    false,
  );
});

test("when Summ does not split the leg off, apply waits, stops and reports the undo handle; nothing is deleted", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("d", [
    { _id: "leg-9", trade: "withdrawal", quantity: "1" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  await stops(summ, planFile({ delete: [del({ otherLegs: 1 })] }), /did not split.*undo undo\d+abcdef/, {
    approveDeletes: true,
  });
  assert.equal(
    summ.calls.some((c) => c.name === "bulk_edit_transactions"),
    false,
  );
});

test("a dry run of a shared delete edits nothing", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "withdrawal", quantity: "1" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  const { result, log } = await run(summ, planFile({ delete: [del({ otherLegs: 1 })] }), {
    approveDeletes: true,
    dryRun: true,
  });
  assert.deepEqual([result.split, result.deleted, log.length], [0, 0, 0]);
  assert.equal(
    summ.calls.every((c) => c.name === "inspect_transaction"),
    true,
  );
});

test("a failing call stops the apply", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  summ.add("b", [{ _id: "leg-2", trade: "withdrawal", quantity: "1" }]);
  let edits = 0;
  const failing: ToolCaller = {
    callTool: async (name, args) => {
      if (name === "edit_transaction" && ++edits === 1) throw new Error("edit_transaction: rejected");
      return summ.callTool(name, args);
    },
  };
  const plan = planFile({
    categorise: [edit(), edit({ id: "row-2", changes: [{ ...edit().changes[0], legId: "leg-2" }] })],
  });
  const state = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  await assert.rejects(
    applyPlan(
      failing,
      plan,
      OPTS,
      () => {},
      () => {},
      0,
      { stateDir: state, planDir: join(state, "plans", "p") },
    ),
    /rejected/,
  );
  assert.equal(summ.calls.filter((c) => c.name === "edit_transaction").length, 0);
});

test("categorisation waits while the plan has uploads; managed edits do not", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  summ.add("b", [{ _id: "leg-2", trade: "withdrawal", quantity: "1" }]);
  const managed = edit({ id: "row-2", changes: [{ ...edit().changes[0], legId: "leg-2" }] });
  const plan = planFile({
    edit: [managed],
    categorise: [edit()],
    upload: [{ file: "f.csv", filed: false, ids: ["x"] }],
  });
  const { result } = await run(summ, plan);
  assert.deepEqual([result.edited, result.heldBack], [1, 1]);
  assert.equal(summ.calls.find((c) => c.name === "edit_transaction")?.args.actionId, "b");
  // filed-year uploads do not hold back the current year's categorisation
  const current = await run(
    summ,
    planFile({ categorise: [edit()], upload: [{ file: "f.csv", filed: true, ids: ["x"] }] }),
  );
  assert.deepEqual([current.result.edited, current.result.heldBack], [1, 0]);
});

test("upload files are listed, filed ones under their _filed name", async () => {
  const plan = planFile({
    upload: [
      { file: "f.csv", filed: false, ids: ["a", "b"] },
      { file: "g.csv", filed: true, ids: ["c"] },
    ],
  });
  assert.deepEqual((await run(new FakeSumm(), plan)).result.uploads, [{ file: "f.csv", rows: 2 }]);
  assert.deepEqual((await run(new FakeSumm(), plan, { approveFiled: true })).result.uploads, [
    { file: "g_filed.csv", rows: 1 },
  ]);
});

test("undoHandle reads the bulk edit id of an edit result", () => {
  assert.equal(undoHandle("- **Bulk Edit ID**: `65f0c0ffee0000000000abcd`"), "65f0c0ffee0000000000abcd");
  assert.equal(undoHandle("Edited."), null);
});

function stateDir(snapshots: [string, string][], log: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-apply-"));
  for (const [name, takenAt] of snapshots) {
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "snapshots", `${name}.json`), JSON.stringify({ takenAt, total: 0, actions: [] }));
  }
  if (log.length) writeFileSync(join(dir, "apply-log.jsonl"), log.join("\n") + "\n");
  return dir;
}

test("a plan from an older snapshot is refused", () => {
  const dir = stateDir([
    ["2024-01-01T00-00-00", "2024-01-01T00:00:00.000Z"],
    ["2024-01-02T00-00-00", "2024-01-02T00:00:00.000Z"],
  ]);
  assert.throws(() => checkFresh(dir, planFile({ snapshot: "2024-01-01T00-00-00" })), /latest is 2024-01-02T00-00-00/);
  assert.doesNotThrow(() => checkFresh(dir, planFile({ snapshot: "2024-01-02T00-00-00" })));
});

test("a plan is refused once an apply wrote to Summ after its snapshot: pull again", () => {
  const snap: [string, string] = ["2024-01-02T00-00-00", "2024-01-02T00:00:00.000Z"];
  const skipOnly = stateDir([snap], [JSON.stringify({ time: "2024-01-03T00:00:00.000Z", plan: "p", call: "skip" })]);
  assert.doesNotThrow(() => checkFresh(skipOnly, planFile({ snapshot: snap[0] })));
  const wrote = stateDir(
    [snap],
    [JSON.stringify({ time: "2024-01-03T00:00:00.000Z", plan: "p", call: "edit_transaction" })],
  );
  assert.throws(() => checkFresh(wrote, planFile({ snapshot: snap[0] })), /1 writes since snapshot/);
});

test("a plan is refused after a hard kill that left only an intent line", () => {
  const snap: [string, string] = ["2024-01-02T00-00-00", "2024-01-02T00:00:00.000Z"];
  const killed = stateDir(
    [snap],
    [
      JSON.stringify({
        time: "2024-01-03T00:00:00.000Z",
        plan: "p",
        call: "edit_transaction",
        intent: true,
        legId: "leg-1",
        field: "trade",
        value: "fee",
      }),
    ],
  );
  assert.throws(() => checkFresh(killed, planFile({ snapshot: snap[0] })), /1 writes since snapshot/);
});

test("runApply adds the plan's adoptions to adopted.csv, but not on a dry run", async () => {
  const snap: [string, string] = ["2024-01-02T00-00-00", "2024-01-02T00:00:00.000Z"];
  const plan = planFile({ snapshot: snap[0], adopted: [{ legId: "leg-old", id: "row-1" }] });
  for (const dryRun of [true, false]) {
    const dir = stateDir([snap]);
    mkdirSync(join(dir, "plans", "p"), { recursive: true });
    writeFileSync(join(dir, "plans", "p", "plan.json"), JSON.stringify(plan));
    const summ = Object.assign(new FakeSumm(), { connect: async () => {} });
    await runApply(summ, dir, join(dir, "plans", "p"), { ...OPTS, dryRun });
    assert.equal(existsSync(join(dir, "adopted.csv")), !dryRun);
    if (!dryRun) assert.equal(readFileSync(join(dir, "adopted.csv"), "utf8"), "Leg,ID\nleg-old,row-1\n");
  }
});

// ---- The journal: each write preceded by a saved state and a line

const WRITES = ["edit_transaction", "bulk_edit_transactions"];
const logLines = (dir: string): LogLine[] =>
  readFileSync(join(dir, "apply-log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** Every kind of write, in a plan of their own: name, the Summ to apply it to, the plan, and its steps' pre-images. */
const WRITE_STEPS: { name: string; summ: () => FakeSumm; plan: () => Partial<PlanFile>; pre: string[] }[] = [
  {
    name: "edit",
    summ: () => withLegs({ a: [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }] }),
    plan: () => ({ edit: [edit()] }),
    pre: ["edit-0.edit.json"],
  },
  {
    name: "price edit",
    summ: () => withLegs({ a: [pricedLeg()] }),
    plan: () => ({ edit: [edit({ changes: priceChange() })] }),
    pre: ["edit-0.edit.json"],
  },
  {
    name: "categorisation, then its ignore",
    summ: () => withLegs({ a: [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }, { ...MADE_UP }] }),
    plan: () => ({ categorise: [edit({ ignore: ["made-up"] })] }),
    pre: ["categorise-0.edit.json", "categorise-0.ignore-0.json"],
  },
  {
    name: "delete",
    summ: () => withLegs({ d: [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }] }),
    plan: () => ({ delete: [del()] }),
    pre: ["delete-0.delete.json"],
  },
  {
    name: "split, delete, then the ignore of the made-up leg",
    summ: () =>
      withLegs({
        d: [
          { _id: "leg-9", trade: "withdrawal", quantity: "1", side: "outgoing" },
          { ...MADE_UP, _id: "made-up" },
        ],
      }),
    plan: () => ({
      delete: [del({ otherLegs: 1 })],
    }),
    pre: ["delete-0.split-0.json", "delete-0.delete.json", "delete-0.ignore-0.json"],
  },
];

function withLegs(actions: Record<string, FakeLeg[]>): FakeSumm {
  const summ = new FakeSumm();
  for (const [id, legs] of Object.entries(actions)) summ.add(id, legs);
  return summ;
}

function applyDir(plan: PlanFile): { dir: string; planDir: string } {
  const dir = stateDir([[plan.snapshot, "2024-01-02T00:00:00.000Z"]]);
  const planDir = join(dir, "plans", "p");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "plan.json"), JSON.stringify(plan));
  return { dir, planDir };
}

const SNAP = "2024-01-02T00-00-00";

for (const { name, summ: makeSumm, plan: planOf, pre } of WRITE_STEPS) {
  for (const landed of [false, true]) {
    for (const [n, file] of pre.entries()) {
      test(`${name}: a ${landed ? "lost answer" : "failure"} at write ${n + 1} leaves its pre-image and intent on disk`, async () => {
        const { dir, planDir } = applyDir(planFile({ snapshot: SNAP, ...planOf() }));
        const summ = makeSumm();
        const real = summ.callTool.bind(summ);
        let writes = 0;
        // The state the failing write was given, read when it is called: on disk by then, or the order is wrong
        let onDisk: LogLine[] = [];
        let preThere = false;
        const client = Object.assign(summ, {
          connect: async () => {},
          callTool: async (tool: string, args: Record<string, unknown>) => {
            if (WRITES.includes(tool) && writes++ === n) {
              onDisk = logLines(dir);
              preThere = existsSync(join(planDir, "pre", file));
              if (landed) await real(tool, args);
              throw new Error("server gone");
            }
            return real(tool, args);
          },
        });
        await assert.rejects(runApply(client, dir, planDir, { ...OPTS, approveDeletes: true }, 0), /server gone/);
        assert.ok(preThere, `${file} exists before the call`);
        const intent = onDisk.at(-1) as LogLine;
        assert.equal(intent.intent, true);
        assert.equal(intent.pre, join("plans", "p", "pre", file));
        // Then a result line, and the plan's refusal counts all of it as a write
        const lines = logLines(dir);
        const failed = lines.find((l) => l.error === "server gone" && l.pre === intent.pre);
        assert.equal(failed?.entry, intent.entry);
        assert.equal(failed?.legId, undefined, "a failure must not read back as an edit");
        assert.throws(() => checkFresh(dir, planFile({ snapshot: SNAP })), /since snapshot/);
        assert.deepEqual(readdirSync(join(planDir, "pre")).sort(), [...pre.slice(0, n + 1)].sort());
      });
    }
  }

  test(`${name}: every write line carries entry and pre, an intent comes before its call and a result after`, async () => {
    const { dir, planDir } = applyDir(planFile({ snapshot: SNAP, ...planOf() }));
    const summ = Object.assign(makeSumm(), { connect: async () => {} });
    await runApply(summ, dir, planDir, { ...OPTS, approveDeletes: true }, 0);
    const lines = logLines(dir);
    assert.equal(summ.calls.filter((c) => WRITES.includes(c.name)).length, pre.length);
    for (const [n, file] of pre.entries()) {
      const own = lines.filter((l) => l.pre === join("plans", "p", "pre", file));
      assert.ok(own.length >= 2, file);
      assert.equal(own[0].intent, true);
      assert.ok(own.at(-1)?.intent === undefined, file);
      assert.ok(own.every((l) => typeof l.entry === "string"));
      assert.ok(existsSync(join(planDir, "pre", file)), `step ${n}`);
    }
    assert.ok(lines.filter((l) => WRITES.includes(l.call)).every((l) => l.pre));
  });
}

test("a pre-image that cannot be written stops the write, and an intent line that cannot be written too", async () => {
  const summ = withLegs({ a: [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }] });
  const state = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  // A file where the plan's folder should be
  writeFileSync(join(state, "plans"), "");
  const dirs = { stateDir: state, planDir: join(state, "plans", "p") };
  const say = () => {};
  await assert.rejects(applyPlan(summ, planFile({ edit: [edit()] }), OPTS, () => {}, say, 0, dirs));
  assert.equal(summ.calls.filter((c) => WRITES.includes(c.name)).length, 0);
  const noLog = () => {
    throw new Error("disk full");
  };
  const state2 = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  const dirs2 = { stateDir: state2, planDir: join(state2, "plans", "p") };
  await assert.rejects(applyPlan(summ, planFile({ edit: [edit()] }), OPTS, noLog, say, 0, dirs2), /disk full/);
  assert.equal(summ.calls.filter((c) => WRITES.includes(c.name)).length, 0);
});

test("a pre-image holds the full action and its history, as read just before the write", async () => {
  const summ = withLegs({ a: [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }] });
  summ.history.set("a", ["2 Jan 2024 · user · Quantity: 2 → 1"]);
  const { log, planDir } = await run(summ, planFile({ edit: [edit()] }));
  const image = preOf(planDir, log[0]);
  assert.deepEqual([image.plan, image.entry, image.step, image.id], ["p", "edit-0", "edit", "row-1"]);
  assert.deepEqual(image.actions[0].action.incoming, [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }]);
  assert.deepEqual(image.actions[0].history, ["2 Jan 2024 · user · Quantity: 2 → 1"]);
  assert.deepEqual(log[0].entry, "edit-0");
});

test("two edits of an action whose id stays each save the state before them", async () => {
  const summ = withLegs({
    a: [
      { _id: "leg-1", trade: "withdrawal", quantity: "1" },
      { _id: "leg-2", trade: "withdrawal", quantity: "1" },
    ],
  });
  summ.paused = true;
  const plan = planFile({
    edit: [edit(), edit({ id: "row-2", changes: [{ ...edit().changes[0], legId: "leg-2" }] })],
  });
  const { log, planDir } = await run(summ, plan);
  const trades = (entry: string) =>
    preOf(
      planDir,
      log.find((l) => l.entry === entry),
    ).actions[0].action.incoming.map((l: FakeLeg) => l.trade);
  assert.deepEqual(trades("edit-0"), ["withdrawal", "withdrawal"]);
  assert.deepEqual(trades("edit-1"), ["bridgeTradeOut", "withdrawal"]);
});

test("a delete's pre-image is read now, whatever the action store holds under that id; the store is left alone", async () => {
  const summ = withLegs({ d: [{ _id: "leg-9", trade: "withdrawal", quantity: "1.5" }] });
  const { dir, planDir } = applyDir(planFile({ snapshot: SNAP, delete: [del()] }));
  const stale = join(dir, "actions", "d.json");
  mkdirSync(join(dir, "actions"));
  writeFileSync(stale, '{"action":{"_id":"d","incoming":[{"quantity":"9"}]},"history":[]}\n');
  const before = readFileSync(stale, "utf8");
  await runApply(Object.assign(summ, { connect: async () => {} }), dir, planDir, { ...OPTS, approveDeletes: true }, 0);
  const image = JSON.parse(readFileSync(join(planDir, "pre", "delete-0.delete.json"), "utf8"));
  assert.equal(image.actions[0].action.incoming[0].quantity, "1.5");
  assert.equal(readFileSync(stale, "utf8"), before);
});

test("the second action of a split is read again after the first was written to", async () => {
  const summ = withLegs({
    d: [
      { _id: "leg-9", trade: "withdrawal", quantity: "1" },
      { _id: "their-leg", trade: "deposit", quantity: "1" },
    ],
    e: [
      { _id: "leg-8", trade: "withdrawal", quantity: "1" },
      { _id: "their-leg-2", trade: "deposit", quantity: "1" },
    ],
  });
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    // Something moves the other action's leg while the first is written to
    if (name === "edit_transaction" && args.actionId === "d") (summ.actions.get("e") as FakeLeg[])[0].quantity = "7";
    return text;
  };
  const { log, planDir } = await run(summ, planFile({ delete: [del({ legIds: ["leg-9", "leg-8"], otherLegs: 2 })] }), {
    approveDeletes: true,
  });
  const second = log.find((l) => String(l.pre).endsWith("delete-0.split-1.json"));
  assert.equal(preOf(planDir, second).actions[0].action.incoming[0].quantity, "7");
});

test("a pre-image never replaces one already there: the new read goes beside it, and the line names it", async () => {
  const summ = withLegs({ a: [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }] });
  const { dir, planDir } = applyDir(planFile({ snapshot: SNAP, edit: [edit()] }));
  mkdirSync(join(planDir, "pre"));
  writeFileSync(join(planDir, "pre", "edit-0.edit.json"), "earlier\n");
  await runApply(Object.assign(summ, { connect: async () => {} }), dir, planDir, OPTS, 0);
  assert.equal(readFileSync(join(planDir, "pre", "edit-0.edit.json"), "utf8"), "earlier\n");
  assert.equal(logLines(dir).find((l) => l.pre)?.pre, join("plans", "p", "pre", "edit-0.edit.2.json"));
  assert.ok(existsSync(join(planDir, "pre", "edit-0.edit.2.json")));
});

const HEADER =
  "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional)";
const csvLine = (id: string) => `2024-01-01 00:00:00,send,AAA,1,,,,,x,y,THOR,${id},"made up, quoted"`;
const WALLET = "2024-01-01_2024-12-31_THOR_w_a.csv";

async function deleteLine(over: Partial<DeleteEntry>, files: { run?: string[]; upload?: string[] }) {
  const runDir = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  const { dir, planDir } = applyDir(planFile({ snapshot: SNAP, run: runDir, delete: [del(over)] }));
  if (files.run) {
    mkdirSync(join(runDir, "csv"));
    writeFileSync(join(runDir, "csv", WALLET), [HEADER, ...files.run].join("\n") + "\n");
    writeFileSync(join(runDir, "csv", "all.csv"), "not a wallet file\n");
  }
  if (files.upload) {
    mkdirSync(join(planDir, "upload"));
    writeFileSync(join(planDir, "upload", WALLET), [HEADER, ...files.upload].join("\n") + "\n");
  }
  const summ = withLegs({ d: [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }] });
  await runApply(Object.assign(summ, { connect: async () => {} }), dir, planDir, { ...OPTS, approveDeletes: true }, 0);
  return JSON.parse(readFileSync(join(planDir, "pre", "delete-0.delete.json"), "utf8"));
}

test("a delete's pre-image holds the row's exact CSV line and where it came from", async () => {
  const image = await deleteLine({ summId: "row-gone" }, { run: [csvLine("other"), csvLine("row-gone")] });
  assert.deepEqual([image.line, image.lineHeader, image.lineSource], [csvLine("row-gone"), HEADER, `run:${WALLET}`]);
});

test("a delete's line: under the row's ID when Summ's differs, else from the plan's upload files, else none", async () => {
  const byRow = await deleteLine({ id: "row-new", summId: "old.csv:7" }, { run: [csvLine("row-new")] });
  assert.equal(byRow.line, csvLine("row-new"));
  const upload = await deleteLine({ summId: "row-gone" }, { run: [csvLine("other")], upload: [csvLine("row-gone")] });
  assert.deepEqual([upload.line, upload.lineSource], [csvLine("row-gone"), `upload:${WALLET}`]);
  const none = await deleteLine({ summId: "row-gone" }, { run: [csvLine("other")] });
  assert.deepEqual([none.line, none.lineHeader, none.lineSource], [null, null, null]);
  // A run that has moved stops nothing
  const moved = await deleteLine({ summId: "row-gone" }, {});
  assert.equal(moved.lineSource, null);
  assert.equal(moved.actions[0].action._id, "d");
});

test("an edit's pre-image has no line fields", async () => {
  const summ = withLegs({ a: [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }] });
  const { log, planDir } = await run(summ, planFile({ edit: [edit()] }));
  assert.equal("lineSource" in preOf(planDir, log[0]), false);
});

test("old log lines, with no entry or pre, still count as writes and read as the sync's edits", () => {
  const snap: [string, string] = [SNAP, "2024-01-02T00:00:00.000Z"];
  const old = {
    time: "2024-01-03T00:00:00.000Z",
    plan: "old",
    call: "edit_transaction",
    legId: "leg-1",
    field: "trade",
    value: "withdrawal",
    saved: "/somewhere/actions/x.json",
  };
  const dir = stateDir([snap], [JSON.stringify(old)]);
  assert.throws(() => checkFresh(dir, planFile({ snapshot: SNAP })), /1 writes since snapshot/);
  assert.deepEqual(
    readApplyLog(dir).map((l) => l.value),
    ["withdrawal"],
  );
});

test("an edit logs one price intent however many other fields it changes, read back through readApplyLog", async () => {
  const { dir, planDir } = applyDir(
    planFile({
      snapshot: SNAP,
      edit: [
        edit({
          changes: [
            { leg: "base", legId: "leg-1", field: "trade", summ: "income", desired: "fee" },
            { leg: "base", legId: "leg-1", field: "quantity", summ: 1, desired: 2 },
            ...priceChange(),
          ],
        }),
      ],
    }),
  );
  const summ = Object.assign(withLegs({ a: [pricedLeg()] }), { connect: async () => {} });
  await runApply(summ, dir, planDir, OPTS, 0);
  const lines = readApplyLog(dir);
  assert.equal(lines.filter((l) => l.intent && l.field === "price").length, 1);
  assert.equal(lines.filter((l) => l.field === "price" && !l.intent).length, 1);
  assert.equal(lines.filter((l) => l.intent).length, 3);
  assert.deepEqual(
    lines.filter((l) => !l.intent).map((l) => l.field),
    ["trade", "quantity", "price"],
  );
});
