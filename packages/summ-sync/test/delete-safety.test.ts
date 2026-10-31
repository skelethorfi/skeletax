// A delete is permanent: it shows what it removes, checks it just before, and touches nothing the plan did not name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApplyOptions, type ApplyResult, type PlanFile, runApply } from "../src/apply.ts";
import { durability } from "../src/journal.ts";
import { parseDetail } from "../src/parse.ts";
import type { DeleteEntry, EditEntry, UploadEntry } from "../src/plan.ts";
import { renderPlan } from "../src/write-plan.ts";
import { Died, type FakeLeg, FakeSumm, named } from "./fake-summ.ts";

durability.sync = () => {};

const SNAP = "2024-01-02T00-00-00";
const TAKEN = "2024-01-02T00:00:00.000Z";
const ALL: ApplyOptions = { approveDeletes: true, approveFiled: false, dryRun: false };
const TXID = "ab".repeat(32);

const leg = (_id: string, over: Partial<FakeLeg> = {}): FakeLeg => ({
  _id,
  trade: "withdrawal",
  quantity: "1",
  side: "outgoing",
  timestamp: "2024-03-01T00:00:00.000Z",
  id: `row-${_id}`,
  importType: "manual-csv",
  source: "csv-source",
  currencyIdentifier: { symbol: "AAA" },
  ...over,
});
const partner = (over: Partial<FakeLeg> = {}) =>
  leg("partner", { trade: "deposit", side: "incoming", importType: "wallet", source: "w", ...over });

const del = (over: Partial<DeleteEntry> = {}): DeleteEntry => ({
  id: null,
  summId: "row-d",
  filed: false,
  legIds: ["d"],
  actionIds: [],
  reason: "no row in the run",
  otherLegs: 0,
  ...over,
});

function planOf(over: Partial<PlanFile> = {}): PlanFile {
  return {
    snapshot: SNAP,
    run: "/no-such-run",
    createdAt: TAKEN,
    managedChains: ["THOR"],
    managedSources: ["csv-source"],
    filedBefore: "2020-01-01",
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

function stateFor(summ: FakeSumm, plan: PlanFile): { dir: string; planDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-delete-"));
  const planDir = join(dir, "plans", "p");
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(dir, "snapshots"));
  writeFileSync(join(planDir, "plan.json"), JSON.stringify(plan));
  const ids = [...summ.actions.keys()];
  writeFileSync(
    join(dir, "snapshots", `${SNAP}.json`),
    JSON.stringify({
      version: 2,
      takenAt: TAKEN,
      total: ids.length,
      actions: ids.map((id) => ({ id, txHash: "", category: "", tags: [], detail: true })),
    }),
  );
  const details = ids.map((id) =>
    JSON.stringify({ a: id, at: TAKEN, ...parseDetail(summ.render(id, summ.actions.get(id) as FakeLeg[])) }),
  );
  writeFileSync(
    join(dir, "snapshots", `${SNAP}.details.jsonl`),
    [JSON.stringify({ startedAt: TAKEN }), ...details, ""].join("\n"),
  );
  return { dir, planDir };
}

/** One run, its result or what stopped it, and all it printed. */
async function apply(summ: FakeSumm, dir: string, planDir: string, opts: ApplyOptions = ALL) {
  const printed: string[] = [];
  const log = console.log;
  console.log = (t: unknown) => void printed.push(String(t));
  const client = Object.assign(summ, { connect: async () => {} });
  try {
    const result = await runApply(client, dir, planDir, opts, 0, { tick: summ.tick, isAlive: () => false });
    return { result, printed: printed.join("\n") };
  } catch (e) {
    return { stop: e as Error, printed: printed.join("\n") };
  } finally {
    console.log = log;
  }
}

const writesOf = (summ: FakeSumm) => summ.writes.map((w) => [w.kind, ...w.legs]);

/** A plan named from Summ as pulled; `change` then happens after the pull. It must stop with nothing written. */
async function stopsUnwritten(legs: FakeLeg[], change: (summ: FakeSumm) => void, pattern: RegExp) {
  const summ = new FakeSumm();
  summ.add("a", legs);
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del()] })));
  change(summ);
  const before = summ.state();
  const { stop } = await apply(summ, dir, planDir);
  assert.match(String(stop?.message), pattern);
  assert.deepEqual(writesOf(summ), []);
  assert.deepEqual(summ.state(), before);
}

for (const [field, over, shown] of [
  ["currency", { currencyIdentifier: { symbol: "BBB" } }, /currency of leg d is "BBB", the plan holds "AAA"/],
  ["quantity", { quantity: "2" }, /quantity of leg d is 2, the plan holds 1/],
  ["timestamp", { timestamp: "2024-03-02T00:00:00.000Z" }, /timestamp of leg d/],
  ["trade", { trade: "sell" }, /trade of leg d is "sell"/],
  ["source", { source: "other" }, /source of leg d/],
  ["importType", { importType: "wallet" }, /importType of leg d/],
  ["ID", { id: "row-other" }, /id of leg d/],
  ["price", { price: 9 }, /price of leg d/],
  ["description", { description: "by hand" }, /description of leg d/],
] as const) {
  test(`a delete's leg whose ${field} changed after the pull stops, with nothing written`, async () => {
    await stopsUnwritten([leg("d")], (summ) => Object.assign(summ.leg("d") as FakeLeg, over), shown);
  });
}

test("the same values delete, by the action just read and never by a filter", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del()] })));
  summ.recalculate();
  const { result } = await apply(summ, dir, planDir);
  assert.equal(result?.deleted, 1);
  assert.deepEqual(writesOf(summ), [["delete", "d"]]);
  const call = summ.calls.find((c) => c.name === "bulk_edit_transactions");
  assert.equal(call?.args.filter, undefined);
  assert.equal((call?.args.actionIds as string[]).length, 1);
});

test("a partner Summ paired after the pull stops the entry: not split, and not deleted with it", async () => {
  await stopsUnwritten(
    [leg("d")],
    (summ) => summ.add("a", [leg("d"), partner()]),
    /leg partner \(1 AAA, wallet\) is in the action, and the plan does not name it/,
  );
});

test("a made-up leg not listed in the plan stops the entry rather than being split or ignored", async () => {
  await stopsUnwritten(
    [leg("d")],
    (summ) =>
      summ.add("a", [leg("d"), leg("soft", { importType: "soft-transfer", side: "incoming", trade: "deposit" })]),
    /leg soft .*soft-transfer.* the plan does not name it/,
  );
});

test("a partner the plan edits elsewhere, paired in after the pull, still stops the delete", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  summ.add("b", [leg("e")]);
  const entry: EditEntry = {
    id: "row-e",
    filed: false,
    actionId: "b",
    changes: [{ leg: "base", legId: "e", field: "trade", summ: "withdrawal", desired: "sell" }],
  };
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del()], edit: [entry] })));
  summ.actions.delete("b");
  summ.add("a", [leg("d"), leg("e")]);
  const { stop } = await apply(summ, dir, planDir);
  assert.match(String(stop?.message), /leg e .* the plan does not name it/);
  assert.deepEqual(writesOf(summ), []);
});

test("a named partner that changed, or left, stops the entry", async () => {
  await stopsUnwritten(
    [leg("d"), partner()],
    (summ) => Object.assign(summ.leg("partner") as FakeLeg, { trade: "income" }),
    /trade of leg partner is "income"/,
  );
  await stopsUnwritten(
    [leg("d"), partner()],
    (summ) => {
      summ.add("a", [leg("d")]);
      summ.add("b", [partner()]);
    },
    /leg partner .* has left the action/,
  );
});

test("a named partner is split from, its own values untouched, and no other leg is written", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d"), partner()]);
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del({ otherLegs: 1 })] })));
  const was = JSON.stringify(summ.leg("partner"));
  await apply(summ, dir, planDir);
  assert.deepEqual(writesOf(summ), [
    ["edit", "d"],
    ["delete", "d"],
  ]);
  const { updatedAt: _, ...now } = summ.leg("partner") as FakeLeg;
  assert.equal(JSON.stringify(now), was);
  assert.equal(summ.leg("d"), undefined);
});

test("two entries of one action: the first's split does not stop the second, though Summ retypes what stays", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d"), leg("e"), partner()]);
  const plan = named(summ, planOf({ delete: [del(), del({ summId: "row-e", legIds: ["e"] })] }));
  const { dir, planDir } = stateFor(summ, plan);
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    if (name === "edit_transaction") (summ.leg("partner") as FakeLeg).trade = "income";
    return text;
  };
  const { result, stop } = await apply(summ, dir, planDir);
  assert.equal(stop, undefined);
  assert.equal(result?.deleted, 2);
});

test("a split's fee leg, moved to outgoing, goes on to its delete; other changes to it after the split stop", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("fee", { side: "fees", trade: "fee" }), partner()]);
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del({ legIds: ["fee"] })] })));
  const { result } = await apply(summ, dir, planDir);
  assert.equal(result?.deleted, 1);

  const changed = new FakeSumm();
  changed.add("a", [leg("fee", { side: "fees", trade: "fee" }), partner()]);
  const again = stateFor(changed, named(changed, planOf({ delete: [del({ legIds: ["fee"] })] })));
  const real = changed.callTool.bind(changed);
  changed.callTool = async (name, args) => {
    const text = await real(name, args);
    if (name === "edit_transaction") (changed.leg("fee") as FakeLeg).quantity = "5";
    return text;
  };
  const { stop } = await apply(changed, again.dir, again.planDir);
  assert.match(String(stop?.message), /quantity of leg fee is 5/);
  assert.deepEqual(writesOf(changed), [["edit", "fee"]]);
});

test("a change between the two agreeing reads stops: a leg joining just before the delete is never deleted", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del()] })));
  let reads = 0;
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    if (name === "inspect_transaction" && args.transactionId === "d" && ++reads === 2)
      summ.add("a", [leg("d"), partner()]);
    return real(name, args);
  };
  const { stop } = await apply(summ, dir, planDir);
  assert.match(String(stop?.message), /leg partner .* the plan does not name it/);
  assert.deepEqual(writesOf(summ), []);
});

test("a leg joining after the last read goes with the action, and the removed count stops the run", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  const { dir, planDir } = stateFor(summ, named(summ, planOf({ delete: [del()] })));
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    if (name === "bulk_edit_transactions") summ.add("a", [leg("d"), partner()]);
    return real(name, args);
  };
  const { stop } = await apply(summ, dir, planDir);
  assert.match(String(stop?.message), /the result reports 2, expected 1/);
});

test("a manual entry now in the action stops, even one the plan names", async () => {
  await stopsUnwritten(
    [leg("d")],
    (summ) => summ.add("a", [leg("d"), leg("hand", { importType: "manual", source: "manual", trade: "deposit" })]),
    /manual entry hand \(1 AAA\) is in the action/,
  );
});

test("a manual entry added after the pull, naming the row's txid, stops split and delete alike", async () => {
  for (const legs of [[leg("d")], [leg("d"), partner()]]) {
    const summ = new FakeSumm();
    summ.add("a", legs);
    const plan = named(summ, planOf({ delete: [del({ id: "row-d", txids: [TXID] })] }));
    const { dir, planDir } = stateFor(summ, plan);
    summ.add("m", [leg("hand", { importType: "manual", source: "manual", description: `stands in for ${TXID}` })]);
    const { stop } = await apply(summ, dir, planDir);
    assert.match(String(stop?.message), /manual entry hand \(1 AAA\) names the row's txid/);
    assert.deepEqual(writesOf(summ), []);
  }
});

test("a manual entry naming another txid, or in another action, stops nothing", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  summ.add("m", [leg("hand", { importType: "manual", source: "manual", description: "cd".repeat(32) })]);
  const plan = named(summ, planOf({ delete: [del({ id: "row-d", txids: [TXID] })] }));
  const { dir, planDir } = stateFor(summ, plan);
  assert.equal((await apply(summ, dir, planDir)).result?.deleted, 1);
});

test("a manual entry naming an edit's row stops that edit", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("e")]);
  const entry: EditEntry = {
    id: "row-e",
    filed: false,
    actionId: "a",
    txids: [TXID],
    changes: [{ leg: "base", legId: "e", field: "trade", summ: "withdrawal", desired: "sell" }],
  };
  const { dir, planDir } = stateFor(summ, planOf({ edit: [entry] }));
  summ.add("m", [leg("hand", { importType: "manual", description: TXID })]);
  const { stop } = await apply(summ, dir, planDir);
  assert.match(String(stop?.message), /names the row's txid/);
  assert.deepEqual(writesOf(summ), []);
});

test("a list of manual entries that cannot be read stops; so does one Summ did not filter", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  const plan = named(summ, planOf({ delete: [del({ txids: [TXID] })] }));
  const { dir, planDir } = stateFor(summ, plan);
  summ.manualListText = "Something else entirely";
  assert.match(String((await apply(summ, dir, planDir)).stop?.message), /list of manual entries reads/);
  summ.manualListText = "(Page 1 of 1, 1 returned, 1 total)\n## 1. Send\n- **Action ID**: `a`\n";
  assert.match(String((await apply(summ, dir, planDir)).stop?.message), /holds none/);
  assert.deepEqual(writesOf(summ), []);
});

test("an old plan's delete with no values is refused, dry run too, and says to plan again", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  const { dir, planDir } = stateFor(summ, planOf({ delete: [del()] }));
  for (const opts of [ALL, { ...ALL, dryRun: true }]) {
    const { stop } = await apply(summ, dir, planDir, opts);
    assert.match(String(stop?.message), /hold no values.*pull and plan again/);
  }
  assert.deepEqual(writesOf(summ), []);
});

// ---- Uploads while a delete is outstanding

const upload: UploadEntry = { file: "f.csv", filed: false, ids: ["row-d"] };
const remake = () => del({ id: "row-d", reason: "description changed" });
const LISTS = /Upload these files/;
const WAITS = /Do not upload yet: 1 rows of the upload files \(row-d\)/;

async function remade(legs: FakeLeg[] = [leg("d")]): Promise<{ summ: FakeSumm; dir: string; planDir: string }> {
  const summ = new FakeSumm();
  summ.add("a", legs);
  return { summ, ...stateFor(summ, named(summ, planOf({ delete: [remake()], upload: [upload] }))) };
}

test("run without --approve-deletes: no upload list while a remade row's delete waits, and it says what to do", async () => {
  const { summ, dir, planDir } = await remade();
  const flags = { ...ALL, approveDeletes: false };
  const { result, printed } = await apply(summ, dir, planDir, flags);
  assert.doesNotMatch(printed, LISTS);
  assert.match(printed, WAITS);
  assert.match(printed, /--approve-deletes/);
  assert.deepEqual((result as ApplyResult).uploads, []);
  // The same again, when it reports the plan complete under those flags
  const again = await apply(summ, dir, planDir, flags);
  assert.doesNotMatch(again.printed, LISTS);
  assert.match(again.printed, WAITS);
  // And with the flag, the delete made: now it lists them
  const done = await apply(summ, dir, planDir);
  assert.match(done.printed, LISTS);
  assert.equal(summ.leg("d"), undefined);
});

test("a stop before the remade row's delete: no upload list, and apply says not to upload", async () => {
  const { summ, dir, planDir } = await remade();
  Object.assign(summ.leg("d") as FakeLeg, { quantity: "2" });
  const { stop, printed } = await apply(summ, dir, planDir);
  assert.ok(stop);
  assert.doesNotMatch(printed, LISTS);
  assert.match(printed, WAITS);
});

test("a stop at the remade row's split, and a signal before its delete: no upload list", async () => {
  const shared = await remade([leg("d"), partner()]);
  shared.summ.splits = false;
  const stopped = await apply(shared.summ, shared.dir, shared.planDir);
  assert.ok(stopped.stop);
  assert.doesNotMatch(stopped.printed, LISTS);
  assert.match(stopped.printed, WAITS);

  const { summ, dir, planDir } = await remade();
  const printed: string[] = [];
  const log = console.log;
  console.log = (t: unknown) => void printed.push(String(t));
  try {
    await runApply(Object.assign(summ, { connect: async () => {} }), dir, planDir, ALL, 0, {
      isAlive: () => false,
      signal: { requested: true },
    });
  } finally {
    console.log = log;
  }
  assert.doesNotMatch(printed.join("\n"), LISTS);
  assert.match(printed.join("\n"), WAITS);
});

test("a dry run lists no upload when it would stop at the remade row's delete, and does when it would not", async () => {
  const { summ, dir, planDir } = await remade();
  const clean = await apply(summ, dir, planDir, { ...ALL, dryRun: true });
  assert.match(clean.printed, LISTS);
  Object.assign(summ.leg("d") as FakeLeg, { quantity: "2" });
  const stops = await apply(summ, dir, planDir, { ...ALL, dryRun: true });
  assert.doesNotMatch(stops.printed, LISTS);
  assert.match(stops.printed, WAITS);
});

test("a crash at every step of a remade row never lists the upload before the delete is made", async () => {
  for (let dieAt = 1; dieAt < 200; dieAt++) {
    const { summ, dir, planDir } = await remade([leg("d"), partner()]);
    summ.dieAt = dieAt;
    const first = await apply(summ, dir, planDir);
    if (!(first.stop instanceof Died)) {
      assert.match(first.printed, LISTS);
      return;
    }
    if (LISTS.test(first.printed)) assert.equal(summ.leg("d"), undefined);
    summ.restart();
    summ.dieAt = null;
    const resumed = await apply(summ, dir, planDir);
    assert.equal(resumed.stop, undefined);
    assert.match(resumed.printed, LISTS);
    assert.equal(summ.leg("d"), undefined);
  }
  assert.fail("never got through");
});

test("a delete with no row beside an upload holds nothing back", async () => {
  const summ = new FakeSumm();
  summ.add("a", [leg("d")]);
  const plan = named(summ, planOf({ delete: [del()], upload: [{ file: "f.csv", filed: false, ids: ["row-new"] }] }));
  const { dir, planDir } = stateFor(summ, plan);
  assert.match((await apply(summ, dir, planDir, { ...ALL, approveDeletes: false })).printed, LISTS);
});

// ---- What the plan shows

test("plan.md shows each leg's values, the other legs' too, and what a filed-year change moves", () => {
  const summ = new FakeSumm();
  summ.add("a", [
    leg("d"),
    partner({ currencyIdentifier: { symbol: "CCC" }, quantity: "3" }),
    leg("soft", { importType: "soft-transfer", side: "incoming", trade: "deposit" }),
  ]);
  const plan = named(summ, planOf({ delete: [del({ otherLegs: 2 }), del({ filed: true, legIds: ["d"] })] }));
  const md = renderPlan(plan, SNAP, "run");
  assert.match(
    md,
    /\| deleted \| `d` \| outgoing \| withdrawal \| AAA \| 1 \| 2024-03-01T00:00:00.000Z \| csv-source \| manual-csv \|/,
  );
  assert.match(md, /\| stays \| `partner` \| incoming \| deposit \| CCC \| 3 \| .* \| w \| wallet \|/);
  assert.match(md, /stays, ignored: Summ made it up \| `soft`/);
  assert.match(md, /moves the cost bases of later disposals/);
  assert.doesNotMatch(renderPlan(planOf({ delete: [] }), SNAP, "run"), /cost bases/);
});
