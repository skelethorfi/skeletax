// An apply stopped anywhere goes on to the state a clean run reaches; anything it did not do itself stops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApplyHooks,
  type ApplyOptions,
  type ApplyResult,
  checkFresh,
  type LogLine,
  type PlanFile,
  runApply,
} from "../src/apply.ts";
import { durability, isWriteLine, readLogLines, repairLog, takeLock } from "../src/journal.ts";
import { parseDetail } from "../src/parse.ts";
import { DEFAULTS } from "../src/config.ts";
import { type DeleteEntry, type EditEntry, makePlan } from "../src/plan.ts";
import { legsOf as legsOfDetail } from "../src/snapshot.ts";
import { prune } from "../src/prune.ts";
import { readApplyLog, readLeftLegs } from "../src/state.ts";
import { Died, type FakeLeg, FakeSumm } from "./fake-summ.ts";

// Thousands of applies: the disk is not what these tests are about. journal's own tests run with it
durability.sync = () => {};

const SNAP = "2024-01-02T00-00-00";
const TAKEN = "2024-01-02T00:00:00.000Z";
const ALL: ApplyOptions = { approveDeletes: true, approveFiled: false, dryRun: false };

const del = (legIds: string[], summId = legIds[0]): DeleteEntry => ({
  id: null,
  summId,
  filed: false,
  legIds,
  actionIds: [],
  reason: "no row in the run",
  otherLegs: 0,
});

const set = (legId: string, field: string, summ: string | number, desired: string | number) => ({
  leg: "base" as const,
  legId,
  field,
  summ,
  desired,
});

const ed = (id: string, changes: EditEntry["changes"], ignore?: string[]): EditEntry => ({
  id,
  filed: false,
  actionId: "stale",
  changes,
  ...(ignore ? { ignore } : {}),
});

function planOf(over: Partial<PlanFile> = {}): PlanFile {
  return {
    snapshot: SNAP,
    run: "/no-such-run",
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

const T0 = "2026-01-01T00:00:00.000Z";
const leg = (_id: string, over: Partial<FakeLeg> = {}): FakeLeg => ({
  _id,
  trade: "withdrawal",
  quantity: "1",
  updatedAt: T0,
  ...over,
});
const soft = (_id: string) => leg(_id, { trade: "deposit", importType: "soft-transfer" });

/** One of every entry type. */
function everyType(): { summ: FakeSumm; plan: PlanFile } {
  const summ = new FakeSumm();
  summ.usdRate = 1.5;
  summ.add("d0", [leg("d0")]);
  summ.add("d1", [leg("d1", { side: "outgoing" }), soft("d1-made-up")]);
  summ.add("d2a", [leg("d2a"), leg("d2a-keeps", { trade: "deposit" })]);
  summ.add("d2b", [leg("d2b")]);
  summ.add("d3", [
    leg("d3"),
    leg("d3-fee", { trade: "fee", side: "fees" }),
    leg("d4"),
    leg("d3-keeps", { trade: "deposit" }),
  ]);
  summ.add("e0", [leg("e0")]);
  summ.add("e1", [leg("e1", { trade: "income", price: 3.9 })]);
  summ.add("e2", [leg("e2", { trade: "income", price: 4.2 })]);
  summ.add("e3", [leg("e3"), leg("e3-b"), leg("e3-mate", { trade: "deposit" })]);
  summ.add("c0", [leg("c0"), soft("c0-made-up")]);
  summ.add("c1", [soft("c1-made-up")]);
  const plan = planOf({
    adopted: [{ legId: "old-leg", id: "row-old" }],
    delete: [del(["d0"]), del(["d1"]), del(["d2a", "d2b"]), del(["d3", "d3-fee"]), del(["d4"])],
    edit: [
      ed("row-e0", [set("e0", "trade", "withdrawal", "fee")]),
      ed("row-e1", [set("e1", "price", 3.9, 2.5)]),
      ed("row-e2", [
        set("e2", "trade", "income", "staking"),
        set("e2", "price", 4.2, 2.8),
        set("e2", "quantity", 1, 2),
      ]),
      ed("row-e3", [set("e3", "trade", "withdrawal", "fee"), set("e3-b", "quantity", 1, 3)]),
    ],
    categorise: [
      ed("row-c0", [set("c0", "trade", "withdrawal", "bridgeTradeOut")], ["c0-made-up"]),
      ed("row-c1", [], ["c1-made-up"]),
    ],
  });
  return { summ, plan };
}

/** A state dir holding the plan and a snapshot of Summ as it is now, with its details. */
function stateFor(summ: FakeSumm, plan: PlanFile): { dir: string; planDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-resume-"));
  const planDir = join(dir, "plans", "p");
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(dir, "snapshots"));
  writeFileSync(join(planDir, "plan.json"), JSON.stringify(plan));
  const ids = [...summ.actions.keys()];
  writeFileSync(
    join(dir, "snapshots", `${plan.snapshot}.json`),
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
    join(dir, "snapshots", `${plan.snapshot}.details.jsonl`),
    [JSON.stringify({ startedAt: TAKEN }), ...details, ""].join("\n"),
  );
  return { dir, planDir };
}

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await f();
  } finally {
    console.log = log;
  }
};

/** One run, as a process: the fake's steps tick its file operations, and a dead process's lock is cleared. */
function once(
  summ: FakeSumm,
  dir: string,
  planDir: string,
  opts: ApplyOptions = ALL,
  hooks: ApplyHooks = {},
): Promise<ApplyResult> {
  const client = Object.assign(summ, { connect: async () => {} });
  return quiet(() => runApply(client, dir, planDir, opts, 0, { tick: summ.tick, isAlive: () => false, ...hooks }));
}

/** Runs until the plan completes, as a user would after each stop. */
async function drive(summ: FakeSumm, dir: string, planDir: string, opts: ApplyOptions = ALL): Promise<number> {
  for (let runs = 1; runs <= 200; runs++) {
    try {
      await once(summ, dir, planDir, opts);
      return runs;
    } catch (e) {
      if (e instanceof Died) summ.restart();
      else if (!/server gone/.test((e as Error).message)) throw e;
    }
  }
  throw new Error("never completed");
}

const logOf = (dir: string) => readLogLines<LogLine>(dir);

/** How many writes touched each leg, split by kind. */
const writesByLeg = (summ: FakeSumm, kind?: string) => {
  const counts = new Map<string, number>();
  for (const w of summ.writes)
    if (!kind || w.kind === kind) for (const l of w.legs) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts;
};

const MODES: { name: string; set: (s: FakeSumm) => void }[] = [
  { name: "rebuilt ids", set: () => {} },
  { name: "kept ids", set: (s) => (s.paused = true) },
  { name: "every write failing after it lands", set: (s) => (s.failAfterWrite = "all") },
  { name: "Summ's own batches moving updatedAt", set: (s) => (s.batchEveryStep = true) },
];

for (const mode of MODES) {
  test(`every entry type, ${mode.name}: a crash at any step, then a resume, ends as a clean run does`, async () => {
    const clean = everyType();
    mode.set(clean.summ);
    const cleanDirs = stateFor(clean.summ, clean.plan);
    await drive(clean.summ, cleanDirs.dir, cleanDirs.planDir);
    const steps = clean.summ.steps;
    const want = JSON.stringify(clean.summ.state());
    const wantWrites = writesByLeg(clean.summ);
    assert.ok(steps > 50, `${steps} steps`);
    assert.deepEqual(
      [...writesByLeg(clean.summ, "delete").values()].every((n) => n === 1),
      true,
    );

    for (let n = 1; n <= steps; n++) {
      const { summ, plan } = everyType();
      mode.set(summ);
      const { dir, planDir } = stateFor(summ, plan);
      summ.dieAt = n;
      // Some crashes also cut the last line
      const tear = n % 3 === 0;
      const real = summ.restart.bind(summ);
      summ.restart = () => {
        real();
        if (tear && existsSync(join(dir, "apply-log.jsonl")))
          appendFileSync(join(dir, "apply-log.jsonl"), '{"time":"20');
      };
      await drive(summ, dir, planDir);
      assert.equal(JSON.stringify(summ.state()), want, `state after a crash at step ${n}`);
      for (const [legId, count] of writesByLeg(summ, "delete"))
        assert.equal(count, 1, `${legId} deleted once, step ${n}`);
      for (const [legId, count] of writesByLeg(summ))
        assert.ok(count <= (wantWrites.get(legId) ?? 0) + 1, `${legId}: ${count} writes, crash at step ${n}`);
      // What plan reads back: the price the sync's edit left
      const edits = readApplyLog(dir);
      for (const legId of ["e1", "e2"]) {
        const own = edits.filter((e) => e.legId === legId && e.field === "price").at(-1);
        assert.equal(own?.after, summ.leg(legId)?.price, `recorded price of ${legId}, step ${n}`);
      }
      assert.equal(readFileSync(join(dir, "adopted.csv"), "utf8"), "Leg,ID\nold-leg,row-old\n");
      assert.equal(existsSync(join(dir, ".lock")), false);
      assert.equal(
        logOf(dir)
          .filter((l) => l.call !== "torn-line")
          .at(-1)?.reason,
        "complete",
        `step ${n}`,
      );
      assert.equal(logOf(dir).filter((l) => l.reason === "complete").length, 1);
      // Finished: reports it, does nothing
      const before = summ.calls.length;
      const again = await once(summ, dir, planDir);
      assert.equal(again.alreadyComplete, true);
      assert.equal(summ.calls.length, before);
    }
  });
}

test("a small plan survives a crash at any step and another at any step of its resume", async () => {
  const small = () => {
    const summ = new FakeSumm();
    summ.usdRate = 1.5;
    summ.add("d", [leg("d9", { side: "outgoing" }), soft("made")]);
    summ.add("e", [leg("e1", { trade: "income", price: 3.9 })]);
    return { summ, plan: planOf({ delete: [del(["d9"])], edit: [ed("row", [set("e1", "price", 3.9, 2.5)])] }) };
  };
  const clean = small();
  const dirs = stateFor(clean.summ, clean.plan);
  await drive(clean.summ, dirs.dir, dirs.planDir);
  const want = JSON.stringify(clean.summ.state());
  for (let first = 1; first <= clean.summ.steps; first++) {
    for (let second = 1; second <= clean.summ.steps + 6; second += 1) {
      const { summ, plan } = small();
      const { dir, planDir } = stateFor(summ, plan);
      summ.dieAt = first;
      await assert.rejects(once(summ, dir, planDir), Died);
      summ.restart();
      summ.dieAt = summ.steps + second;
      await drive(summ, dir, planDir);
      assert.equal(JSON.stringify(summ.state()), want, `crashes at ${first}, then ${second} on`);
      assert.equal(writesByLeg(summ, "delete").get("d9"), 1);
    }
  }
});

test("a recalculation between a crash and the resume changes nothing: legs are found by their own ids", async () => {
  const clean = everyType();
  const cleanDirs = stateFor(clean.summ, clean.plan);
  await drive(clean.summ, cleanDirs.dir, cleanDirs.planDir);
  const { summ, plan } = everyType();
  const { dir, planDir } = stateFor(summ, plan);
  summ.dieAt = Math.floor(clean.summ.steps / 2);
  await assert.rejects(once(summ, dir, planDir), Died);
  summ.restart();
  summ.recalculate();
  await drive(summ, dir, planDir);
  assert.equal(JSON.stringify(summ.state()), JSON.stringify(clean.summ.state()));
});

// ---- A user's edit, at every step

const USER_EDITS: {
  name: string;
  target: string;
  edit: (s: FakeSumm) => void;
  holds: (s: FakeSumm) => boolean;
  says: RegExp;
}[] = [
  {
    name: "another type on an edited leg",
    target: "e0",
    edit: (s) => ((s.leg("e0") as FakeLeg).trade = "userSet"),
    holds: (s) => s.leg("e0")?.trade === "userSet",
    says: /trade of leg e0 is "userSet"/,
  },
  {
    name: "another price on a priced leg",
    target: "e1",
    edit: (s) => ((s.leg("e1") as FakeLeg).price = 99),
    holds: (s) => s.leg("e1")?.price === 99,
    says: /price of leg e1 is 99/,
  },
  {
    name: "another quantity on a categorised leg",
    target: "c0",
    edit: (s) => ((s.leg("c0") as FakeLeg).quantity = "77"),
    // Not a field the entry sets: it goes by the action-mate check only when the leg itself is unchanged
    holds: (s) => s.leg("c0")?.quantity === "77",
    says: /./,
  },
  {
    name: "another quantity on an action-mate",
    target: "e3",
    edit: (s) => ((s.leg("e3-mate") as FakeLeg).quantity = "7"),
    holds: (s) => s.leg("e3-mate")?.quantity === "7",
    says: /quantity of leg e3-mate is 7/,
  },
];

for (const { name, target, edit, holds, says } of USER_EDITS) {
  test(`${name}, at any step: stops and reports, or the user's value stands; the only exception is the instant between read and write`, async () => {
    const clean = everyType();
    const cleanDirs = stateFor(clean.summ, clean.plan);
    await drive(clean.summ, cleanDirs.dir, cleanDirs.planDir);
    const written = clean.summ.trace.find((t) => t.name === "edit_transaction" && t.legs.includes(target)) as {
      step: number;
    };
    const lastRead = clean.summ.trace
      .filter((t) => t.step < written.step && t.name === "inspect_transaction" && t.legs.includes(target))
      .at(-1) as { step: number };
    const checksIt = target !== "c0";

    for (let n = 1; n <= clean.summ.steps; n++) {
      const { summ, plan } = everyType();
      const { dir, planDir } = stateFor(summ, plan);
      summ.userEdits.set(n, edit);
      let stopped: Error | null = null;
      await once(summ, dir, planDir).catch((e: Error) => (stopped = e));
      const inWindow = n > lastRead.step && n <= written.step;
      if (n <= lastRead.step && checksIt) {
        assert.match(String(stopped), says, `edit at step ${n}`);
        assert.equal(writesByLeg(summ).get(target), undefined, `no write to ${target}, step ${n}`);
        assert.equal(logOf(dir).at(-1)?.call, "apply-stop");
        // And again on every later run
        await assert.rejects(once(summ, dir, planDir), says);
      }
      // Between the read and the write nothing can tell: the known limit of a read then a write (spec: Apply)
      if (!inWindow) assert.ok(holds(summ), `the user's value stands, step ${n}`);
    }
  });
}

test("a price changed by hand after the sync's confirmed price stops the resume", async () => {
  const summ = new FakeSumm();
  summ.add("e", [leg("e1", { trade: "income", price: 3.9 })]);
  summ.add("f", [leg("f1")]);
  const plan = planOf({
    edit: [ed("r1", [set("e1", "price", 3.9, 2.5)]), ed("r2", [set("f1", "trade", "withdrawal", "fee")])],
  });
  const { dir, planDir } = stateFor(summ, plan);
  // Dies at the look-up of the second entry
  const real = summ.callTool.bind(summ);
  let died = false;
  summ.callTool = async (name, args) => {
    if (!died && name === "inspect_transaction" && args.transactionId === "f1") {
      died = true;
      summ.dieAt = summ.steps + 1;
    }
    return real(name, args);
  };
  await assert.rejects(once(summ, dir, planDir), Died);
  summ.restart();
  // By hand, USD-marked as the sync left it, and later than anything
  Object.assign(summ.leg("e1") as FakeLeg, { price: 7, updatedAt: "2027-01-01T00:00:00.000Z" });
  await assert.rejects(once(summ, dir, planDir), /price of leg e1 is 7/);
  assert.equal(summ.leg("e1")?.price, 7);
});

test("a price that differs with no intent logged stops; one at the before-value is sent", async () => {
  const summ = new FakeSumm();
  summ.add("e", [leg("e1", { trade: "income", price: 5, priceValueCurrency: "USD" })]);
  const plan = planOf({ edit: [ed("r", [set("e1", "price", 3.9, 2.5)])] });
  const { dir, planDir } = stateFor(summ, plan);
  await assert.rejects(once(summ, dir, planDir), /price of leg e1 is 5/);
  (summ.leg("e1") as FakeLeg).price = 3.9;
  await once(summ, dir, planDir);
  assert.equal(summ.leg("e1")?.price, 2.5);
});

test("a price edit that landed, marked and moved, but unanswered, is done with the local price logged", async () => {
  const summ = new FakeSumm();
  summ.usdRate = 1.5;
  summ.failAfterWrite = 1;
  summ.add("e", [leg("e1", { trade: "income", price: 3.9 })]);
  const { dir, planDir } = stateFor(summ, planOf({ edit: [ed("r", [set("e1", "price", 3.9, 2.5)])] }));
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  const result = await once(summ, dir, planDir);
  assert.deepEqual([result.edited, result.found], [0, 1]);
  const line = logOf(dir).find((l) => l.via === "found" && l.field === "price");
  assert.deepEqual([line?.after, line?.value], [3.75, 2.5]);
  assert.equal(summ.writes.length, 1);
});

test("a price landed but with no USD mark, or updatedAt not later than its pre-image, stops", async () => {
  for (const undo of [{ priceValueCurrency: undefined }, { updatedAt: T0 }]) {
    const summ = new FakeSumm();
    summ.failAfterWrite = 1;
    summ.add("e", [leg("e1", { trade: "income", price: 3.9 })]);
    const { dir, planDir } = stateFor(summ, planOf({ edit: [ed("r", [set("e1", "price", 3.9, 2.5)])] }));
    await assert.rejects(once(summ, dir, planDir), /server gone/);
    Object.assign(summ.leg("e1") as FakeLeg, undo);
    await assert.rejects(once(summ, dir, planDir), /price of leg e1 is 2.5/);
    assert.equal(summ.writes.length, 1);
  }
});

test("a partial mix stops: one change at its after-value, another at its before-value", async () => {
  const summ = new FakeSumm();
  summ.add("e", [leg("e1", { trade: "fee" })]);
  const plan = planOf({ edit: [ed("r", [set("e1", "trade", "withdrawal", "fee"), set("e1", "quantity", 1, 2)])] });
  const { dir, planDir } = stateFor(summ, plan);
  await assert.rejects(once(summ, dir, planDir), /partly applied/);
  assert.equal(summ.writes.length, 0);
});

test("an entry already at its after-value counts as done, via found, with no write", async () => {
  const summ = new FakeSumm();
  summ.add("e", [leg("e1", { trade: "fee" })]);
  const { dir, planDir } = stateFor(summ, planOf({ edit: [ed("r", [set("e1", "trade", "withdrawal", "fee")])] }));
  const result = await once(summ, dir, planDir);
  assert.deepEqual([result.edited, result.found, summ.writes.length], [0, 1, 0]);
  const line = logOf(dir).find((l) => l.via === "found");
  assert.equal(line?.entry, "edit-0");
  assert.equal(line?.legId, undefined, "with no intent logged, not the sync's own edit");
  assert.equal(isWriteLine(line as LogLine), false);
});

// ---- Deletes

const del1 = (summ: FakeSumm, entries = [del(["d"])]) => stateFor(summ, planOf({ delete: entries }));

test("two reads agree before a delete, and a change between them means reading again", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("d")]);
  const { dir, planDir } = del1(summ);
  const reads: unknown[] = [];
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    if (name === "inspect_transaction") reads.push(args.transactionId);
    // A rebuild between the first and second read
    if (reads.length === 1 && name === "inspect_transaction") {
      const text = await real(name, args);
      summ.recalculate();
      return text;
    }
    return real(name, args);
  };
  await once(summ, dir, planDir);
  assert.equal(reads.filter((r) => r === "d").length >= 3, true);
  assert.equal(summ.writes.filter((w) => w.kind === "delete").length, 1);
});

test("a delete's legs gone with no delete logged stops; with one logged, it is done", async () => {
  const gone = new FakeSumm();
  const first = del1(gone);
  await assert.rejects(once(gone, first.dir, first.planDir), /no longer in Summ, and this plan did not delete it/);

  const landed = new FakeSumm();
  landed.failAfterWrite = 1;
  landed.add("x", [leg("d")]);
  const second = del1(landed);
  await assert.rejects(once(landed, second.dir, second.planDir), /server gone/);
  const result = await once(landed, second.dir, second.planDir);
  assert.deepEqual([result.deleted, result.found], [0, 1]);
});

test("one leg of a delete gone and another not stops", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("a")]);
  const { dir, planDir } = del1(summ, [del(["a", "b"])]);
  await assert.rejects(once(summ, dir, planDir), /leg b is no longer in Summ, the others are/);
  assert.equal(summ.writes.length, 0);
});

test("a split slow to take effect is waited for, then deleted", async () => {
  const summ = new FakeSumm();
  summ.splitDelay = 3;
  summ.add("x", [leg("d"), leg("keeps", { trade: "deposit" })]);
  const { dir, planDir } = del1(summ);
  const result = await once(summ, dir, planDir);
  assert.deepEqual([result.split, result.deleted], [1, 1]);
  assert.deepEqual(
    [...summ.actions.values()].flat().map((l) => l._id),
    ["keeps"],
  );
});

test("ignored with its split logged, still sharing on a later run: waits, then stops, without another edit", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("x", [leg("d"), leg("keeps", { trade: "deposit" })]);
  const { dir, planDir } = del1(summ);
  await assert.rejects(once(summ, dir, planDir), /did not split/);
  const writes = summ.writes.length;
  await assert.rejects(once(summ, dir, planDir), /did not split/);
  assert.equal(summ.writes.length, writes);
});

test("a split that did not land is made again by the next run, and once", async () => {
  const summ = new FakeSumm();
  summ.failBeforeWrite = 1;
  summ.add("x", [leg("d"), leg("keeps", { trade: "deposit" })]);
  const { dir, planDir } = del1(summ);
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  assert.equal(summ.writes.length, 1, "not retried in the same run");
  const result = await once(summ, dir, planDir);
  assert.deepEqual([result.split, result.deleted], [1, 1]);
});

test("a made-up leg named only by the split is still ignored when the delete landed before a crash", async () => {
  const summ = new FakeSumm();
  summ.failAfterWrite = 2;
  summ.add("x", [leg("d", { side: "outgoing" }), soft("made")]);
  const { dir, planDir } = del1(summ);
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  assert.notEqual(summ.leg("made")?.trade, "ignoreIn");
  await once(summ, dir, planDir);
  assert.equal(summ.leg("made")?.trade, "ignoreIn");
});

// ---- Results and read-backs

/** A Summ whose result text for one tool is rewritten. */
function rewriting(summ: FakeSumm, tool: string, rewrite: (t: string) => string) {
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    return name === tool ? rewrite(text) : text;
  };
}

for (const [name, tool, rewrite, says] of [
  [
    "a delete reporting another count",
    "bulk_edit_transactions",
    (t: string) => t.replace(/removed \d+/, "removed 0"),
    /reports 0, expected 1/,
  ],
  ["a delete reporting no count", "bulk_edit_transactions", () => "Done.", /reports no count/],
] as const) {
  test(`${name} stops the run`, async () => {
    const summ = new FakeSumm();
    summ.add("x", [leg("d")]);
    summ.add("y", [leg("d2")]);
    rewriting(summ, tool, rewrite);
    const { dir, planDir } = del1(summ, [del(["d"]), del(["d2"])]);
    await assert.rejects(once(summ, dir, planDir), says);
    assert.equal(logOf(dir).at(-1)?.reason, "bad-result");
    assert.ok(summ.leg("d2"), "the next entry is not touched");
  });
}

for (const [name, rewrite, says] of [
  ["another count", (t: string) => t.replace(/Patched \d+/, "Patched 0"), /reports 0, expected 1/],
  ["no count", (t: string) => t.replace(/Patched \d+ transaction leg\(s\)\./, "Edited."), /reports no count/],
  ["no affected action", (t: string) => t.replace(/Affected Action IDs.*\n/, ""), /names no affected action/],
  [
    "an affected action that lacks the leg",
    (t: string) => t.replace(/(Affected Action IDs[^:]*: ).*/, "$1other"),
    /do not show/,
  ],
] as const) {
  test(`an edit whose result has ${name} stops the run`, async () => {
    const summ = new FakeSumm();
    summ.add("x", [leg("e")]);
    summ.add("other", [leg("o")]);
    summ.add("y", [leg("e2")]);
    rewriting(summ, "edit_transaction", rewrite);
    const plan = planOf({
      edit: [ed("r", [set("e", "trade", "withdrawal", "fee")]), ed("r2", [set("e2", "trade", "withdrawal", "fee")])],
    });
    const { dir, planDir } = stateFor(summ, plan);
    await assert.rejects(once(summ, dir, planDir), says);
    assert.equal(summ.leg("e2")?.trade, "withdrawal");
  });
}

test("an edit the read-back disagrees with stops, naming it; the next run finds the truth", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("e")]);
  const real = summ.callTool.bind(summ);
  let lost = true;
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    if (name === "edit_transaction" && lost) {
      lost = false;
      (summ.leg("e") as FakeLeg).trade = "withdrawal"; // Reported, and not done
    }
    return text;
  };
  const { dir, planDir } = stateFor(summ, planOf({ edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])] }));
  await assert.rejects(once(summ, dir, planDir), /do not show trade/);
  assert.equal(logOf(dir).at(-1)?.reason, "read-back");
  await once(summ, dir, planDir);
  assert.equal(summ.leg("e")?.trade, "fee");
});

test("an ignore's and a delete's results are read back too", async () => {
  const ignore = new FakeSumm();
  ignore.add("x", [soft("made")]);
  rewriting(ignore, "bulk_edit_transactions", (t) => t.replace(/updated \d+/, "updated 2"));
  const a = stateFor(ignore, planOf({ categorise: [ed("r", [], ["made"])] }));
  await assert.rejects(once(ignore, a.dir, a.planDir), /reports 2, expected 1/);

  const del2 = new FakeSumm();
  del2.add("x", [leg("d")]);
  const real = del2.callTool.bind(del2);
  del2.callTool = async (name, args) => {
    if (name !== "bulk_edit_transactions") return real(name, args);
    return "Bulk delete removed 1 transaction leg."; // Reported, and not done
  };
  const b = del1(del2);
  await assert.rejects(once(del2, b.dir, b.planDir), /still holds 1 of its legs/);
});

test("look-ups go by transactionId and never through the lagging search", async () => {
  const { summ, plan } = everyType();
  summ.searchLag = 100;
  const { dir, planDir } = stateFor(summ, plan);
  await once(summ, dir, planDir);
  assert.equal(summ.calls.filter((c) => c.name === "query_summ_transactions").length, 0);
});

// ---- Failed reads and writes in the log

test("a failed read stops but is no write: the plan can go on, and another plan can still start", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("e")]);
  const plan = planOf({ edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])] });
  const { dir, planDir } = stateFor(summ, plan);
  const real = summ.callTool.bind(summ);
  summ.callTool = async () => {
    throw new Error("tools/call -> 503");
  };
  await assert.rejects(once(summ, dir, planDir), /503/);
  const stop = logOf(dir).at(-1);
  assert.deepEqual([stop?.call, stop?.reason], ["apply-stop", "error"]);
  assert.equal(logOf(dir).filter(isWriteLine).length, 0);
  assert.doesNotThrow(() => checkFresh(dir, plan));
  summ.callTool = real;
  await once(summ, dir, planDir);
  assert.equal(summ.leg("e")?.trade, "fee");
});

test("a gateway's 404 is a failed read, not a leg gone: nothing is counted done", async () => {
  const summ = new FakeSumm();
  summ.failAfterWrite = 1;
  summ.add("x", [leg("d")]);
  const { dir, planDir } = del1(summ);
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  const real = summ.callTool.bind(summ);
  summ.callTool = async () => {
    throw new Error("tools/call -> 404 Not Found");
  };
  await assert.rejects(once(summ, dir, planDir), /404/);
  assert.equal(logOf(dir).filter((l) => l.via === "found").length, 0);
  summ.callTool = real;
  assert.equal((await once(summ, dir, planDir)).found, 1);
});

test("a failed write counts as a write, and is not retried in that run", async () => {
  const summ = new FakeSumm();
  summ.failBeforeWrite = 1;
  summ.add("x", [leg("e")]);
  const plan = planOf({ edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])] });
  const { dir, planDir } = stateFor(summ, plan);
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  assert.equal(summ.writes.length, 1);
  assert.equal(logOf(dir).at(-1)?.reason, "write-failed");
  assert.throws(() => checkFresh(dir, plan), /writes since snapshot/);
});

test("mergeTables waits for the plan to complete", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("e")]);
  summ.failBeforeWrite = 1;
  const plan = planOf({
    adopted: [{ legId: "l", id: "i" }],
    edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])],
  });
  const { dir, planDir } = stateFor(summ, plan);
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  assert.equal(existsSync(join(dir, "adopted.csv")), false);
  await once(summ, dir, planDir);
  assert.equal(existsSync(join(dir, "adopted.csv")), true);
});

// ---- Refusals

const line = (over: Record<string, unknown>) =>
  JSON.stringify({ time: "2024-01-03T00:00:00.000Z", plan: "p", call: "edit_transaction", ...over });

/** A plan with one edit and a log as given. */
function refusal(log: string[], { later = false } = {}) {
  const summ = new FakeSumm();
  summ.add("x", [leg("e")]);
  const plan = planOf({ edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])] });
  const { dir, planDir } = stateFor(summ, plan);
  if (log.length) writeFileSync(join(dir, "apply-log.jsonl"), log.join("\n") + "\n");
  if (later)
    writeFileSync(
      join(dir, "snapshots", "2025-01-01T00-00-00.json"),
      JSON.stringify({ takenAt: "2025-01-01T00:00:00.000Z", total: 0, actions: [] }),
    );
  return { summ, dir, planDir };
}

/** The apply-start of an earlier run of this very plan. */
async function started() {
  const summ = new FakeSumm();
  summ.failBeforeWrite = 1;
  summ.add("x", [leg("e")]);
  const plan = planOf({ edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])] });
  const dirs = stateFor(summ, plan);
  await assert.rejects(once(summ, dirs.dir, dirs.planDir), /server gone/);
  return { summ, plan, ...dirs };
}

test("refusal, first start: a later snapshot", async () => {
  const { summ, dir, planDir } = refusal([], { later: true });
  await assert.rejects(once(summ, dir, planDir), /the latest is 2025/);
  assert.equal(summ.calls.length, 0);
});

test("refusal, first start: any write since the snapshot was taken, old format, intent, or failure", async () => {
  for (const l of [
    line({}),
    line({ intent: true, legId: "a", field: "trade" }),
    line({ call: "error", error: "x" }),
    line({ plan: "other", run: "r" }),
  ]) {
    const { summ, dir, planDir } = refusal([l]);
    await assert.rejects(once(summ, dir, planDir), /1 writes since snapshot/);
    assert.equal(summ.calls.length, 0);
  }
});

test("first start allowed: writes before the snapshot, and lines that are no write", async () => {
  const old = line({ time: "2023-01-01T00:00:00.000Z" });
  const notWrites = ["skip", "found", "apply-start", "apply-stop"].map((call) => line({ call, plan: "other" }));
  const { summ, dir, planDir } = refusal([old, ...notWrites]);
  await once(summ, dir, planDir);
  assert.equal(summ.leg("e")?.trade, "fee");
});

test("refusal, resume: a later snapshot", async () => {
  const { summ, dir, planDir } = await started();
  writeFileSync(
    join(dir, "snapshots", "2025-01-01T00-00-00.json"),
    JSON.stringify({ takenAt: "2025-01-01T00:00:00.000Z", total: 0, actions: [] }),
  );
  await assert.rejects(once(summ, dir, planDir), /the latest is 2025/);
});

test("refusal, resume: plan.json changed", async () => {
  const { summ, dir, planDir } = await started();
  appendFileSync(join(planDir, "plan.json"), "\n");
  await assert.rejects(once(summ, dir, planDir), /changed since its apply began/);
});

test("refusal, resume: other flags, either way", async () => {
  for (const flags of [{ approveDeletes: false }, { approveFiled: true }]) {
    const { summ, dir, planDir } = await started();
    await assert.rejects(once(summ, dir, planDir, { ...ALL, ...flags }), /was applied with/);
  }
});

test("refusal, resume: a write since that is not this plan's runs'", async () => {
  for (const foreign of [{ plan: "other", run: "r" }, { run: "never-started" }, {}]) {
    const { summ, dir, planDir } = await started();
    appendFileSync(join(dir, "apply-log.jsonl"), line({ time: new Date().toISOString(), ...foreign }) + "\n");
    await assert.rejects(once(summ, dir, planDir), /1 writes since snapshot .* not this plan's/);
  }
});

test("resume allowed: this plan's own writes and failures, over several runs", async () => {
  const { summ, dir, planDir } = await started();
  summ.failBeforeWrite = 2;
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  await once(summ, dir, planDir);
  assert.equal(summ.leg("e")?.trade, "fee");
  assert.equal(logOf(dir).filter((l) => l.call === "apply-start").length, 3);
  assert.deepEqual(
    logOf(dir)
      .filter((l) => l.call === "apply-start")
      .map((l) => l.resumed),
    [false, true, true],
  );
  assert.equal(
    new Set(
      logOf(dir)
        .filter((l) => l.call === "apply-start")
        .map((l) => l.run),
    ).size,
    3,
  );
});

test("a finished plan reports complete and calls nothing, even with a later snapshot; other flags are still refused", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("e")]);
  const plan = planOf({ edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])] });
  const { dir, planDir } = stateFor(summ, plan);
  await once(summ, dir, planDir);
  writeFileSync(
    join(dir, "snapshots", "2025-01-01T00-00-00.json"),
    JSON.stringify({ takenAt: "2025-01-01T00:00:00.000Z", total: 0, actions: [] }),
  );
  const lines = logOf(dir).length;
  const calls = summ.calls.length;
  assert.equal((await once(summ, dir, planDir)).alreadyComplete, true);
  assert.deepEqual([logOf(dir).length, summ.calls.length], [lines, calls]);
  await assert.rejects(once(summ, dir, planDir, { ...ALL, approveFiled: true }), /was applied with/);
});

test("a dry run classifies and reports every conflict, and writes nothing, not even a log or a lock", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("e", { trade: "userSet" })]);
  summ.add("y", [leg("f", { trade: "fee" })]);
  const plan = planOf({
    edit: [ed("r", [set("e", "trade", "withdrawal", "fee")]), ed("r2", [set("f", "trade", "withdrawal", "fee")])],
  });
  const { dir, planDir } = stateFor(summ, plan);
  const result = await once(summ, dir, planDir, { ...ALL, dryRun: true });
  assert.match(result.skipped[0].reason, /trade of leg e is "userSet"/);
  assert.equal(result.found, 1);
  assert.equal(existsSync(join(dir, "apply-log.jsonl")), false);
  assert.equal(summ.writes.length, 0);
});

test("old logs keep working: their writes refuse a first start and read as the sync's edits", () => {
  const { dir } = refusal([line({ legId: "a", field: "trade", value: "fee", saved: "/x/actions/y.json" })]);
  assert.deepEqual(
    readApplyLog(dir).map((l) => l.value),
    ["fee"],
  );
  const before = refusal([line({ time: "2023-01-01T00:00:00.000Z", call: "skip", reason: "old" })]);
  assert.equal(logOf(before.dir)[0].call, "skip");
});

// ---- The log's last line

test("a torn last line is left out by every reader; the next apply moves it aside and appends cleanly", async () => {
  const { summ, dir, planDir } = refusal([
    line({ time: "2023-01-01T00:00:00.000Z", legId: "a", field: "trade", value: "fee" }),
  ]);
  const file = join(dir, "apply-log.jsonl");
  appendFileSync(file, '{"time":"2024-01-03T00:00:00.000Z","plan":"p","call":"edit_trans');
  assert.equal(readApplyLog(dir).length, 1);
  assert.equal(logOf(dir).length, 1);
  assert.doesNotThrow(() => checkFresh(dir, planOf()));
  assert.deepEqual(prune(dir, 9999).removed, []);
  await once(summ, dir, planDir);
  const torn = logOf(dir).find((l) => l.call === "torn-line");
  assert.match(String(torn?.text), /edit_trans$/);
  assert.equal(logOf(dir).at(-1)?.reason, "complete");
});

test("a whole last line that lost its newline counts, and gets it back", () => {
  const { dir } = refusal([]);
  const file = join(dir, "apply-log.jsonl");
  writeFileSync(file, line({ legId: "a", field: "trade", value: "fee" }));
  assert.equal(readApplyLog(dir).length, 1);
  repairLog(file, TAKEN, "p");
  assert.ok(readFileSync(file, "utf8").endsWith("}\n"));
  assert.equal(logOf(dir).length, 1);
});

test("a bad line anywhere else stops every reader with a clear message", async () => {
  const { summ, dir, planDir } = refusal([line({}), "not json", line({})]);
  for (const read of [
    () => readApplyLog(dir),
    () => checkFresh(dir, planOf()),
    () => logOf(dir),
    () => prune(dir, 9999),
  ])
    assert.throws(read, /apply-log\.jsonl: line 2 is not JSON/);
  await assert.rejects(once(summ, dir, planDir), /line 2 is not JSON/);
  assert.equal(summ.calls.length, 0);
});

test("a bad last line that has its newline is no torn line: it stops too", () => {
  const { dir } = refusal([line({}), "not json"]);
  assert.throws(() => logOf(dir), /line 2 is not JSON/);
});

// ---- The lock

test("a live lock refuses a second apply and is left alone; a dead or empty one is cleared; a run clears its own", async () => {
  const { summ, dir, planDir } = refusal([]);
  const lock = join(dir, ".lock");
  writeFileSync(lock, "4242\n");
  await assert.rejects(once(summ, dir, planDir, ALL, { isAlive: () => true }), /Another apply is running \(pid 4242/);
  assert.equal(readFileSync(lock, "utf8"), "4242\n");
  assert.equal(summ.calls.length, 0);
  writeFileSync(lock, "");
  takeLock(dir, () => true);
  assert.equal(Number(readFileSync(lock, "utf8")), process.pid);
  // A process that has exited, seen by the real check
  const exited = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(lock, `${exited.pid}\n`);
  await quiet(() => runApply(Object.assign(summ, { connect: async () => {} }), dir, planDir, ALL, 0));
  assert.equal(existsSync(lock), false);
});

test("a lock of this very process, seen by the real check, is live", () => {
  const { dir } = refusal([]);
  takeLock(dir);
  assert.throws(() => takeLock(dir), /Another apply is running/);
});

test("the lock is released on a stop", async () => {
  const { dir } = await started();
  assert.equal(existsSync(join(dir, ".lock")), false);
});

// ---- Signals

test("a signal lets the current entry finish, split then delete and made-up ignore, then stops; a resume finishes", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("d", { side: "outgoing" }), soft("made")]);
  summ.add("y", [leg("e")]);
  const plan = planOf({
    adopted: [{ legId: "l", id: "i" }],
    delete: [del(["d"])],
    edit: [ed("r", [set("e", "trade", "withdrawal", "fee")])],
  });
  const { dir, planDir } = stateFor(summ, plan);
  const signal = { requested: false };
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    if (name === "edit_transaction") signal.requested = true;
    return real(name, args);
  };
  const stopped = await once(summ, dir, planDir, ALL, { signal });
  assert.equal(stopped.stopped, true);
  assert.equal(summ.leg("d"), undefined, "the split's delete was made");
  assert.equal(summ.leg("made")?.trade, "ignoreIn");
  assert.equal(summ.leg("e")?.trade, "withdrawal", "the next entry was not begun");
  assert.deepEqual([logOf(dir).at(-1)?.call, logOf(dir).at(-1)?.reason], ["apply-stop", "signal"]);
  assert.equal(existsSync(join(dir, "adopted.csv")), false);
  await once(summ, dir, planDir);
  assert.equal(summ.leg("e")?.trade, "fee");
  assert.equal(existsSync(join(dir, "adopted.csv")), true);
});

test("a real SIGTERM: finishes the entry, says it is waiting, writes apply-stop, exits 130", () => {
  const summ = new FakeSumm();
  summ.add("d", [leg("leg-9"), leg("their-leg", { trade: "deposit" })]);
  summ.add("e", [leg("leg-8")]);
  const plan = planOf({ delete: [del(["leg-9"]), del(["leg-8"])] });
  const { dir, planDir } = stateFor(summ, plan);
  const child = fileURLToPath(new URL("signal-child.ts", import.meta.url));
  const out = spawnSync(process.execPath, [child, dir, planDir], { encoding: "utf8" });
  assert.equal(out.status, 130, out.stderr);
  assert.match(out.stdout, /Stopping: waiting for the current entry/);
  assert.match(out.stdout, /left: leg-8,their-leg/);
  assert.equal(logOf(dir).at(-1)?.reason, "signal");
  assert.equal(existsSync(join(dir, ".lock")), false);
});

// ---- From review: each pins a guard no other test reaches

test("a lost price edit, then a batch of Summ's moving updatedAt, on a leg already marked USD: sent again, not counted done", async () => {
  const summ = new FakeSumm();
  summ.failBeforeWrite = 1;
  summ.add("e", [leg("e1", { trade: "income", price: 3.9, priceValueCurrency: "USD" })]);
  const { dir, planDir } = stateFor(summ, planOf({ edit: [ed("r", [set("e1", "price", 3.9, 2.5)])] }));
  await assert.rejects(once(summ, dir, planDir), /server gone/);
  summ.batch();
  const result = await once(summ, dir, planDir);
  assert.deepEqual([result.edited, result.found, summ.writes.length], [1, 0, 2]);
  assert.equal(summ.leg("e1")?.price, 2.5);
});

test("a made-up leg still sharing after its send landed is reported; the run goes on and completes, and so does a resume", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("a", [leg("c"), soft("made")]);
  summ.add("b", [leg("e")]);
  const plan = planOf({
    edit: [ed("r2", [set("e", "trade", "withdrawal", "fee")])],
    categorise: [ed("r", [set("c", "trade", "withdrawal", "bridgeTradeOut")], ["made"])],
  });
  const { dir, planDir } = stateFor(summ, plan);
  const result = await once(summ, dir, planDir);
  assert.match(result.skipped[0].reason, /made-up leg made still shares its action with 1 other legs/);
  assert.equal(summ.leg("made")?.trade, "deposit");
  const skip = logOf(dir).find((l) => l.call === "skip");
  assert.deepEqual([skip?.entry, skip?.legId], ["categorise-0", undefined]);
  assert.deepEqual(readLeftLegs(dir), [{ legId: "made", id: "r", plan: "p", reason: skip?.reason }]);
  assert.equal(logOf(dir).at(-1)?.reason, "complete");
});

test("a made-up leg gone with no ignore logged stops", async () => {
  const summ = new FakeSumm();
  const { dir, planDir } = stateFor(summ, planOf({ categorise: [ed("r", [], ["made"])] }));
  await assert.rejects(
    once(summ, dir, planDir),
    /made-up leg made is no longer in Summ, and this plan did not ignore it/,
  );
});

test("only Summ's sentence for this very leg means gone; any other error stops, with a delete logged too", async () => {
  for (const message of [
    "inspect_transaction: Transaction 'another' was not found. Use `query_summ_transactions` to find current Transaction IDs.",
    "inspect_transaction: Transaction 'd' could not be read",
    "inspect_transaction: no such transaction",
    "inspect_transaction: d does not exist",
    "inspect_transaction: account not found",
  ]) {
    const summ = new FakeSumm();
    summ.failBeforeWrite = 1;
    summ.add("x", [leg("d")]);
    const { dir, planDir } = del1(summ);
    await assert.rejects(once(summ, dir, planDir), /server gone/);
    const real = summ.callTool.bind(summ);
    summ.callTool = async () => {
      throw new Error(message);
    };
    await assert.rejects(once(summ, dir, planDir), (e: Error) => e.message === message);
    assert.equal(logOf(dir).filter((l) => l.via === "found").length, 0);
    summ.callTool = real;
    assert.equal((await once(summ, dir, planDir)).deleted, 1);
  }
});

for (const [name, flags, entries] of [
  ["delete-only", { approveDeletes: true }, { delete: [del(["d"])] }],
  ["filed-only", { approveFiled: true }, { delete: [{ ...del(["d"]), filed: true }] }],
] as [string, Partial<ApplyOptions>, Partial<PlanFile>][]) {
  test(`a ${name} plan run without its flag wrote nothing: with the flag it needs no pull, and its flags then bind`, async () => {
    const summ = new FakeSumm();
    summ.add("x", [leg("d")]);
    const { dir, planDir } = stateFor(summ, planOf(entries));
    const without = { ...ALL, approveDeletes: false, approveFiled: false };
    await once(summ, dir, planDir, without);
    assert.equal(summ.writes.length, 0);
    assert.equal((await once(summ, dir, planDir, without)).alreadyComplete, true);
    const opts = { ...ALL, ...flags };
    await once(summ, dir, planDir, opts);
    assert.equal(summ.leg("d"), undefined);
    assert.equal((await once(summ, dir, planDir, opts)).alreadyComplete, true);
    await assert.rejects(once(summ, dir, planDir, without), /was applied with/);
  });
}

test("a signal during an entry with nothing written stops before the permanent delete, or the split; a resume does it", async () => {
  for (const legs of [[leg("d")], [leg("d"), leg("keeps", { trade: "deposit" })]]) {
    const summ = new FakeSumm();
    summ.add("x", legs);
    const { dir, planDir } = del1(summ);
    const signal = { requested: false };
    const real = summ.callTool.bind(summ);
    summ.callTool = async (name, args) => {
      signal.requested = true;
      return real(name, args);
    };
    const stopped = await once(summ, dir, planDir, ALL, { signal });
    assert.equal(stopped.stopped, true);
    assert.equal(summ.writes.length, 0);
    assert.equal(logOf(dir).at(-1)?.reason, "signal");
    summ.callTool = real;
    await once(summ, dir, planDir);
    assert.equal(summ.leg("d"), undefined);
  }
});

test("every price of an entry gets its own after, by leg, and plan's record stands for each", async () => {
  const summ = new FakeSumm();
  summ.usdRate = 2;
  summ.add("t", [leg("sell", { price: 3 }), leg("buy", { trade: "deposit", price: 5 })]);
  const plan = planOf({ edit: [ed("r", [set("sell", "price", 3, 1), set("buy", "price", 5, 4)])] });
  const { dir, planDir } = stateFor(summ, plan);
  await once(summ, dir, planDir);
  const after = (legId: string) =>
    readApplyLog(dir)
      .filter((e) => e.legId === legId && !e.intent)
      .map((e) => e.after);
  assert.deepEqual([after("sell"), after("buy")], [[2], [8]]);
});

test("an action-mate's changed price stops; a Summ-made fee with a new id and a planned made-up leg do not", async () => {
  const start = () => {
    const summ = new FakeSumm();
    summ.add("a", [
      leg("c"),
      soft("made"),
      leg("mate", { trade: "deposit", price: 2 }),
      leg("fee-1", { importType: "assumed-fee", side: "fees" }),
    ]);
    const plan = planOf({ categorise: [ed("r", [set("c", "trade", "withdrawal", "fee")], ["made"])] });
    return { summ, ...stateFor(summ, plan) };
  };
  const moved = start();
  (moved.summ.leg("mate") as FakeLeg).price = 9;
  await assert.rejects(once(moved.summ, moved.dir, moved.planDir), /price of leg mate is 9, was 2/);

  const renewed = start();
  (renewed.summ.leg("fee-1") as FakeLeg)._id = "fee-2";
  (renewed.summ.leg("made") as FakeLeg).quantity = "5";
  await once(renewed.summ, renewed.dir, renewed.planDir);
  assert.equal(renewed.summ.leg("c")?.trade, "fee");
});

test("a leg not ignored after its split read back is not split twice in a run", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("x", [leg("d"), leg("keeps", { trade: "deposit" })]);
  const { dir, planDir } = del1(summ);
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    if (name === "inspect_transaction" && args.transactionId && summ.writes.length) {
      const l = summ.leg("d") as FakeLeg;
      l.trade = "withdrawal";
    }
    return real(name, args);
  };
  await assert.rejects(once(summ, dir, planDir), /not ignored after its split/);
  assert.equal(summ.writes.length, 1);
});

test("a second real signal stops at once", () => {
  const summ = new FakeSumm();
  summ.add("d", [leg("leg-9"), leg("their-leg", { trade: "deposit" })]);
  summ.add("e", [leg("leg-8")]);
  const { dir, planDir } = stateFor(summ, planOf({ delete: [del(["leg-9"]), del(["leg-8"])] }));
  const child = fileURLToPath(new URL("signal-child.ts", import.meta.url));
  const out = spawnSync(process.execPath, [child, dir, planDir, "twice"], { encoding: "utf8" });
  assert.equal(out.signal, "SIGTERM");
  assert.doesNotMatch(out.stdout, /left:/);
});

test("a deleted row's made-up leg left sharing is on record for later plans; old skip lines name no leg", async () => {
  const summ = new FakeSumm();
  summ.add("x", [leg("d", { side: "outgoing" }), soft("made")]);
  summ.add("y", [leg("keeps", { trade: "deposit" })]);
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    // Summ pairs the made-up leg with another once the delete is made
    if ((args.operation as { type?: string } | undefined)?.type === "delete") {
      const [id, legs] = summ.holder("made") as [string, FakeLeg[]];
      summ.actions.delete(id);
      (summ.holder("keeps") as [string, FakeLeg[]])[1].push(...legs);
    }
    return text;
  };
  const { dir, planDir } = del1(summ);
  appendFileSync(
    join(dir, "apply-log.jsonl"),
    line({ time: "2023-01-01T00:00:00.000Z", call: "skip", reason: "old" }) + "\n",
  );
  const result = await once(summ, dir, planDir);
  assert.equal(result.deleted, 1);
  assert.deepEqual(
    readLeftLegs(dir).map((l) => [l.legId, l.id]),
    [["made", null]],
  );
  assert.equal(logOf(dir).at(-1)?.reason, "complete");
});

test("a leg no longer made up that also shares its action stops, and is not ignored", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ ...soft("made"), importType: "retyped" }, leg("other")]);
  const { dir, planDir } = stateFor(summ, planOf({ categorise: [ed("r", [], ["made"])] }));
  await assert.rejects(once(summ, dir, planDir), /leg made is not a made-up leg \(retyped\)/);
  assert.equal(summ.writes.length, 0);
  assert.deepEqual(readLeftLegs(dir), []);
});

test("a read-back holding one of an entry's two priced legs gives neither a price, and stops", async () => {
  const summ = new FakeSumm();
  summ.add("t", [leg("sell", { price: 3 }), leg("buy", { trade: "deposit", price: 5 })]);
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    // The second leg has moved to an action the result does not name
    if (name === "edit_transaction") {
      const [id, legs] = summ.holder("buy") as [string, FakeLeg[]];
      const buy = legs.find((l) => l._id === "buy") as FakeLeg;
      summ.actions.set(
        id,
        legs.filter((l) => l !== buy),
      );
      summ.actions.set("elsewhere", [buy]);
    }
    return text;
  };
  const plan = planOf({ edit: [ed("r", [set("sell", "price", 3, 1), set("buy", "price", 5, 4)])] });
  const { dir, planDir } = stateFor(summ, plan);
  await assert.rejects(once(summ, dir, planDir), /do not show/);
  const after = (legId: string) =>
    logOf(dir)
      .filter((l) => l.legId === legId && !l.intent)
      .map((l) => l.after);
  assert.deepEqual([after("sell"), after("buy")], [[null], [null]]);
  assert.equal(logOf(dir).at(-1)?.reason, "read-back");
});

// ---- A sell whose quote Summ cannot price: two edits, one entry (spec: Prices)
const UNKNOWN = { source: "unknown" };
const USD = 0.5;
const twoLegs = (): EditEntry => ({
  ...ed("row-sell", [set("sell", "price", 3, USD)]),
  match: { legId: "buy", baseLegId: "sell", summ: 2, desired: null },
});
function sellSumm(): FakeSumm {
  const summ = new FakeSumm();
  summ.usdRate = 1.5;
  summ.add("t", [
    leg("sell", { trade: "sell", side: "outgoing", quantity: "10", price: 3, currencyIdentifier: { symbol: "TKN" } }),
    leg("buy", { trade: "buy", side: "incoming", quantity: "4", price: 2, currencyIdentifier: UNKNOWN }),
    leg("fee", { trade: "fee", side: "fees", quantity: "0.1", price: 9, currencyIdentifier: { symbol: "GAS" } }),
  ]);
  return summ;
}
const valueOf = (summ: FakeSumm, legId: string) => {
  const l = summ.leg(legId) as FakeLeg;
  return Number(l.quantity) * (l.price as number);
};
const editsOf = (summ: FakeSumm) => summ.calls.filter((c) => c.name === "edit_transaction").map((c) => c.args.edits);

test("a two-leg entry: the sell in USD, then the buy at the sell's value as read back, in local price", async () => {
  const summ = sellSumm();
  const { dir, planDir } = stateFor(summ, planOf({ edit: [twoLegs()] }));
  const result = await once(summ, dir, planDir);
  assert.deepEqual(editsOf(summ), [
    [{ transactionId: "sell", updates: { price: USD, priceValueCurrency: "USD" } }],
    [{ transactionId: "buy", updates: { price: (10 * USD * 1.5) / 4 } }],
  ]);
  assert.equal(valueOf(summ, "sell"), valueOf(summ, "buy"));
  assert.equal(summ.leg("buy")?.priceValueCurrency, undefined);
  assert.equal(summ.leg("fee")?.price, 9);
  assert.equal(result.edited, 2);
  // Each is journalled: its pre-image, its intent, its after
  const lines = logOf(dir).filter((l) => l.legId === "buy");
  assert.deepEqual(
    lines.map((l) => [Boolean(l.intent), l.local, l.after]),
    [
      [true, true, undefined],
      [false, true, (10 * USD * 1.5) / 4],
    ],
  );
  assert.ok(existsSync(join(dir, String(lines[0].pre))));
  assert.match(String(lines[0].pre), /edit-0\.match\.json$/);
});

for (const mode of MODES) {
  test(`a two-leg entry, ${mode.name}: a crash at any step, then a resume, ends as a clean run does`, async () => {
    const clean = sellSumm();
    mode.set(clean);
    const cleanDirs = stateFor(clean, planOf({ edit: [twoLegs()] }));
    await drive(clean, cleanDirs.dir, cleanDirs.planDir);
    const want = JSON.stringify(clean.state());
    for (let n = 1; n <= clean.steps; n++) {
      const summ = sellSumm();
      mode.set(summ);
      const { dir, planDir } = stateFor(summ, planOf({ edit: [twoLegs()] }));
      summ.dieAt = n;
      await drive(summ, dir, planDir);
      assert.equal(JSON.stringify(summ.state()), want, `state after a crash at step ${n}`);
      assert.equal(valueOf(summ, "sell"), valueOf(summ, "buy"), `step ${n}`);
      assert.equal(logOf(dir).at(-1)?.reason, "complete", `step ${n}`);
      for (const legId of ["sell", "buy"]) {
        const own = readApplyLog(dir)
          .filter((e) => e.legId === legId && e.field === "price")
          .at(-1);
        assert.equal(own?.after, summ.leg(legId)?.price, `recorded price of ${legId}, step ${n}`);
      }
    }
  });
}

test("a two-leg entry: the sell edited and the buy not resumes by doing the buy, whatever the stop", async () => {
  // The buy's write fails and does not land
  const failed = sellSumm();
  failed.failBeforeWrite = 2;
  const a = stateFor(failed, planOf({ edit: [twoLegs()] }));
  await assert.rejects(once(failed, a.dir, a.planDir), /server gone/);
  assert.equal(failed.leg("buy")?.price, 2);
  assert.equal(logOf(a.dir).at(-1)?.reason, "write-failed");
  await once(failed, a.dir, a.planDir);
  assert.equal(valueOf(failed, "sell"), valueOf(failed, "buy"));

  // The sell's read-back never agrees: unconfirmed, and the resume finds it landed
  const lost = sellSumm();
  lost.failAfterWrite = 1;
  const b = stateFor(lost, planOf({ edit: [twoLegs()] }));
  await assert.rejects(once(lost, b.dir, b.planDir), /server gone/);
  const result = await once(lost, b.dir, b.planDir);
  assert.equal(result.found, 1);
  assert.equal(writesByLeg(lost).get("sell"), 1);
  assert.equal(valueOf(lost, "sell"), valueOf(lost, "buy"));

  // The buy landed and its answer was lost: done, and recorded as the sync's
  const landed = sellSumm();
  landed.failAfterWrite = 2;
  const c = stateFor(landed, planOf({ edit: [twoLegs()] }));
  await assert.rejects(once(landed, c.dir, c.planDir), /server gone/);
  await once(landed, c.dir, c.planDir);
  assert.equal(writesByLeg(landed).get("buy"), 1);
  const own = readApplyLog(c.dir)
    .filter((e) => e.legId === "buy")
    .at(-1);
  assert.equal(own?.after, landed.leg("buy")?.price);
});

test("a two-leg entry stops on a buy the plan did not expect, and when its value moved", async () => {
  const summ = sellSumm();
  (summ.leg("buy") as FakeLeg).price = 2.2;
  const a = stateFor(summ, planOf({ edit: [twoLegs()] }));
  await assert.rejects(once(summ, a.dir, a.planDir), /the plan expected 2 and sets/);
  assert.equal(summ.leg("buy")?.price, 2.2);

  // Only the buy planned, from the sell as pulled; the sell has moved since
  const moved = sellSumm();
  const plan = planOf({
    edit: [{ ...ed("row-sell", []), match: { legId: "buy", baseLegId: "sell", summ: 2, desired: 7.5 } }],
  });
  const b = stateFor(moved, plan);
  (moved.leg("sell") as FakeLeg).price = 3.1;
  await assert.rejects(once(moved, b.dir, b.planDir), /value of leg sell moved/);
  assert.equal(writesByLeg(moved).size, 0);
});

test("a two-leg entry with the sell standing edits the buy alone; one already equal is found done", async () => {
  const summ = sellSumm();
  const entry = { ...ed("row-sell", []), match: { legId: "buy", baseLegId: "sell", summ: 2, desired: 7.5 } };
  const a = stateFor(summ, planOf({ edit: [entry] }));
  await once(summ, a.dir, a.planDir);
  assert.deepEqual(editsOf(summ), [[{ transactionId: "buy", updates: { price: 7.5 } }]]);

  const done = sellSumm();
  (done.leg("buy") as FakeLeg).price = 7.5 + 1e-13;
  const b = stateFor(done, planOf({ edit: [entry] }));
  const result = await once(done, b.dir, b.planDir);
  assert.deepEqual([result.found, editsOf(done)], [1, []]);
  // Not taken for the sync's own edit
  assert.equal(readApplyLog(b.dir).length, 0);
});

test("a two-leg entry: a dry run writes nothing, and a signal between its edits finishes the entry", async () => {
  const summ = sellSumm();
  const a = stateFor(summ, planOf({ edit: [twoLegs()] }));
  await once(summ, a.dir, a.planDir, { ...ALL, dryRun: true });
  assert.deepEqual([editsOf(summ), summ.leg("sell")?.price], [[], 3]);

  const signalled = sellSumm();
  const signal = { requested: false };
  const real = signalled.callTool.bind(signalled);
  signalled.callTool = async (name, args) => {
    const text = await real(name, args);
    if (name === "edit_transaction") signal.requested = true;
    return text;
  };
  const plan = planOf({ edit: [twoLegs(), ed("later", [set("other", "trade", "withdrawal", "fee")])] });
  signalled.add("o", [leg("other")]);
  const b = stateFor(signalled, plan);
  await once(signalled, b.dir, b.planDir, ALL, { signal });
  assert.equal(valueOf(signalled, "sell"), valueOf(signalled, "buy"));
  assert.equal(signalled.leg("other")?.trade, "withdrawal");
});

test("an import's leg: price and category in one edit, its fee leg and amount untouched; a crash resumes", async () => {
  const fresh = () => {
    const summ = new FakeSumm();
    summ.usdRate = 1.5;
    summ.add("i", [
      leg("eth", { trade: "withdrawal", side: "outgoing", price: 3000 }),
      leg("gas", { trade: "fee", side: "fees", price: 3000 }),
    ]);
    return summ;
  };
  const entry = ed("row-eth", [set("eth", "trade", "withdrawal", "bridgeTradeOut"), set("eth", "price", 3000, 2000)]);
  const clean = fresh();
  const a = stateFor(clean, planOf({ categorise: [entry] }));
  await once(clean, a.dir, a.planDir);
  assert.deepEqual(editsOf(clean), [
    [{ transactionId: "eth", updates: { trade: "bridgeTradeOut", price: 2000, priceValueCurrency: "USD" } }],
  ]);
  assert.equal(clean.leg("gas")?.price, 3000);
  const want = JSON.stringify(clean.state());
  for (let n = 1; n <= clean.steps; n++) {
    const summ = fresh();
    const { dir, planDir } = stateFor(summ, planOf({ categorise: [entry] }));
    summ.dieAt = n;
    await drive(summ, dir, planDir);
    assert.equal(JSON.stringify(summ.state()), want, `step ${n}`);
  }
});

test("a plan made, applied and pulled again plans nothing: sell, buy and an import's leg, with Summ's history", async () => {
  const base = {
    line: "",
    chain: "THOR",
    file: "2023-07-01_2024-06-30_THOR_abcde_Example.csv",
    timestamp: "2024-03-01T10:00:00.000Z",
    feeCurrency: "",
    feeAmount: "",
    from: "w",
    to: "w",
    blockchain: "",
    referencePriceCurrency: "USD",
    quoteCurrency: "",
    quoteAmount: "",
  };
  const rows = [
    {
      ...base,
      id: "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa",
      type: "sell",
      baseCurrency: "TKN",
      baseAmount: "10",
      quoteCurrency: "SYN",
      quoteAmount: "4",
      description: "sell",
      referencePrice: "0.5",
      txids: ["1".repeat(64)],
    },
    {
      ...base,
      chain: "ETH",
      file: "2023-07-01_2024-06-30_ETH_abcde_Example.csv",
      id: "2024-03-01T10:00:00.000Z.out.bbbbbbbbbbbb",
      type: "bridge-trade-out",
      baseCurrency: "ETH",
      baseAmount: "1",
      description: "swap",
      referencePrice: "2000",
      txids: ["2".repeat(64)],
    },
  ];
  const common = { timestamp: base.timestamp, from: "w", to: "w", source: "csv-source", importType: "manual-csv" };
  const summ = new FakeSumm();
  summ.usdRate = 1.5;
  summ.add("t", [
    {
      ...leg("sell", { trade: "sell", side: "outgoing", quantity: "10", price: 3 }),
      ...common,
      id: rows[0].id,
      description: "sell",
      currencyIdentifier: { symbol: "TKN", source: "coingecko" },
    },
    {
      ...leg("buy", { trade: "buy", side: "incoming", quantity: "4", price: 2 }),
      ...common,
      id: rows[0].id,
      description: "sell",
      currencyIdentifier: { symbol: "SYN", source: "unknown" },
    },
  ]);
  summ.add("i", [
    {
      ...leg("eth", { trade: "withdrawal", side: "outgoing", price: 3000 }),
      ...common,
      id: "2".repeat(64),
      source: "eth-wallet",
      importType: "wallet",
      description: "",
      currencyIdentifier: { symbol: "ETH", source: "coingecko" },
    },
  ]);
  const makeFrom = (applyLog: ReturnType<typeof readApplyLog>, history: Map<string, string[]>) => {
    const details = [...summ.actions].map(([id, legs]) => parseDetail(summ.render(id, legs)));
    return makePlan({
      files: [],
      rows,
      legs: details.flatMap(legsOfDetail),
      history,
      txHashes: new Set(),
      config: { ...DEFAULTS, managedSources: ["csv-source"] },
      adopted: new Map(),
      overrides: [],
      applyLog,
      now: "2024-08-01T00:00:00.000Z",
    }).plan;
  };
  const first = makeFrom([], new Map());
  assert.equal(first.edit[0].match?.legId, "buy");
  assert.equal(first.categorise[0].changes.length, 2);
  const { dir, planDir } = stateFor(summ, planOf({ edit: first.edit, categorise: first.categorise }));
  await drive(summ, dir, planDir);
  assert.equal(valueOf(summ, "sell"), valueOf(summ, "buy"));
  // Summ labels the sync's edits as the user's, one Price line each, in the action as it now is
  const price = "1 Jan 2026 00:00 · user · Price: AUD 1 → AUD 2";
  const history = new Map(
    [...summ.actions].map(([id, legs]) => [id, legs.flatMap(() => [price])] as [string, string[]]),
  );
  const second = makeFrom(readApplyLog(dir), history);
  assert.deepEqual([second.edit, second.categorise, second.held, second.overridden], [[], [], [], []]);
});

test("a two-leg entry: a sell paying its fee in the asset sold gives the buy its net value", async () => {
  const summ = sellSumm();
  const fee = summ.leg("fee") as FakeLeg;
  Object.assign(fee, { quantity: "2", currencyIdentifier: { symbol: "TKN" } });
  const { dir, planDir } = stateFor(summ, planOf({ edit: [twoLegs()] }));
  await once(summ, dir, planDir);
  assert.equal(summ.leg("buy")?.price, (8 * USD * 1.5) / 4);
});

test("a two-leg entry stops when the buy's edit does not land, with nothing recorded as its price", async () => {
  const summ = sellSumm();
  const real = summ.callTool.bind(summ);
  summ.callTool = async (name, args) => {
    const text = await real(name, args);
    if (name === "edit_transaction" && summ.leg("buy")?.price !== 2) (summ.leg("buy") as FakeLeg).price = 2;
    return text;
  };
  const { dir, planDir } = stateFor(summ, planOf({ edit: [twoLegs()] }));
  await assert.rejects(once(summ, dir, planDir), /do not show/);
  assert.equal(
    logOf(dir)
      .filter((l) => l.legId === "buy")
      .at(-1)?.after,
    null,
  );
  assert.equal(logOf(dir).at(-1)?.reason, "read-back");
});

test("a two-leg entry's second edit stops when an action-mate changed since the pull", async () => {
  const summ = sellSumm();
  const entry = { ...ed("row-sell", []), match: { legId: "buy", baseLegId: "sell", summ: 2, desired: 7.5 } };
  const { dir, planDir } = stateFor(summ, planOf({ edit: [entry] }));
  (summ.leg("fee") as FakeLeg).price = 8;
  await assert.rejects(once(summ, dir, planDir), /other legs of its action changed/);
  assert.equal(writesByLeg(summ).size, 0);
});

test("a two-leg entry's buy is its own to change: a later entry in its action does not stop on it", async () => {
  const summ = sellSumm();
  (summ.actions.get("t") as FakeLeg[]).push(leg("other"));
  const plan = planOf({ edit: [twoLegs(), ed("later", [set("other", "trade", "withdrawal", "fee")])] });
  const { dir, planDir } = stateFor(summ, plan);
  await once(summ, dir, planDir);
  assert.equal(summ.leg("other")?.trade, "fee");
});

test("a dry run reports a two-leg entry as a live run would", async () => {
  // Finished, then a stop on a later entry: both runs go past it
  const summ = sellSumm();
  summ.add("o", [leg("other")]);
  const plan = planOf({ edit: [twoLegs(), ed("later", [set("other", "trade", "fee", "income")])] });
  const a = stateFor(summ, plan);
  await assert.rejects(once(summ, a.dir, a.planDir), /other/);
  const dry = await once(summ, a.dir, a.planDir, { ...ALL, dryRun: true });
  assert.deepEqual(
    dry.skipped.map((s) => s.id),
    ["later"],
  );

  // A quantity edit with a known price: the plan's price is from the new quantity
  const moved = sellSumm();
  const entry = {
    ...ed("row-sell", [set("sell", "quantity", 10, 20)]),
    match: { legId: "buy", baseLegId: "sell", summ: 2, desired: 15 },
  };
  const b = stateFor(moved, planOf({ edit: [entry] }));
  assert.deepEqual((await once(moved, b.dir, b.planDir, { ...ALL, dryRun: true })).skipped, []);
  assert.equal(writesByLeg(moved).size, 0);
  await once(moved, b.dir, b.planDir);
  assert.equal(moved.leg("buy")?.price, 15);

  // What stops a live run stops a dry one: the buy not at the plan's price, or a changed mate
  const handEdited = sellSumm();
  (handEdited.leg("buy") as FakeLeg).price = 2.2;
  const c = stateFor(handEdited, planOf({ edit: [twoLegs()] }));
  assert.equal((await once(handEdited, c.dir, c.planDir, { ...ALL, dryRun: true })).skipped.length, 1);
  const mate = sellSumm();
  const d = stateFor(mate, planOf({ edit: [twoLegs()] }));
  (mate.leg("fee") as FakeLeg).price = 8;
  assert.equal((await once(mate, d.dir, d.planDir, { ...ALL, dryRun: true })).skipped.length, 1);
});
