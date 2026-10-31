import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { actionsWithTxids, pull, rangeOf } from "../src/pull.ts";
import {
  latestSnapshot,
  legsOf,
  type PullRange,
  readSnapshot,
  readSnapshotFile,
  snapshotNames,
} from "../src/snapshot.ts";

test("actionsWithTxids finds listed actions by tx hash, in any case and with or without 0x", () => {
  const txid = "ab".repeat(32);
  const actions = [
    { tags: [], "Action ID": "a1", "Tx Hash": `0x${txid.toUpperCase()}` },
    { tags: [], "Action ID": "a2", "Tx Hash": "cd".repeat(32) },
    { tags: [], "Action ID": "a3" },
    { tags: [], "Action ID": "a4", "Tx Hash": `${txid}__2` },
    { tags: [], "Action ID": "a5", "Tx Hash": `${txid}-0` },
  ];
  assert.deepEqual(actionsWithTxids(actions, new Set([txid])), ["a1", "a4", "a5"]);
});

/** Summ as a fake MCP server. `state.ids` is what the list shows now, `state.legs` each action's outgoing legs. Like
 * Summ, an edit may keep an action's id. `state.before` runs before each inspect, to change Summ during a pull. */
function fakeSumm(ids: string[], legs: Record<string, unknown[]> = {}) {
  const state = {
    ids,
    legs,
    sourceIds: null as string[] | null,
    gone: new Set<string>(),
    before: (_: string) => {},
  };
  const inspected: string[] = [];
  const filters: unknown[] = [];
  const client = {
    connect: async () => {},
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === "query_summ_transactions") {
        filters.push(args.filter);
        const isSource = JSON.stringify(args.filter ?? "").includes('"source"');
        const actionIds = isSource ? (state.sourceIds ?? state.ids) : state.ids;
        const blocks = actionIds.map(
          (id, i) =>
            `## ${i + 1}. send\n- **Action ID**: \`${id}\`\n- **Tx Hash**: \`h${id}\`\n- **Action Category**: send`,
        );
        return `# Transactions (Page 1 of 1, ${actionIds.length} returned, ${actionIds.length} total)\n\n${blocks.join("\n\n")}`;
      }
      const id = args.actionId as string;
      state.before(id);
      if (state.gone.has(id)) throw new Error(`inspect_transaction: Action '${id}' was not found.`);
      inspected.push(id);
      const action = { _id: id, outgoing: state.legs[id] ?? [] };
      return `\`\`\`json\n${JSON.stringify(action)}\n\`\`\`\n## Change History\n- 1 Jan 2024 10:00 · import (original)\n`;
    },
  };
  return { client, inspected, filters, state };
}

const quiet = async (fn: () => Promise<void>) => {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
  }
};
const stateDirOf = () => {
  const stateDir = mkdtempSync(join(tmpdir(), "summ-sync-pull-"));
  writeFileSync(join(stateDir, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
  return stateDir;
};
const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

test("every pull reads every detail, so an edit that keeps its action id is seen", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"], { a2: [{ _id: "l", quantity: 1, price: 1 }] });
    await pull(stateDir, undefined, { client: summ.client, now: T0 });
    assert.deepEqual(summ.inspected.sort(), ["a1", "a2"]);
    summ.inspected.length = 0;
    summ.state.legs.a2 = [{ _id: "l", quantity: 1, price: 2 }];
    const file = await pull(stateDir, undefined, { client: summ.client, now: T0 + HOUR });
    assert.deepEqual(summ.inspected.sort(), ["a1", "a2"]);
    assert.equal(readSnapshot(file).legs[0].price, 2);
    const snapshot = readSnapshotFile(file);
    assert.deepEqual([snapshot.version, snapshot.total, snapshot.details, snapshot.rounds], [2, 2, 2, 2]);
  }));

test("takenAt is when the pull started, so a write during it counts as after it", () =>
  quiet(async () => {
    const file = await pull(stateDirOf(), undefined, { client: fakeSumm(["a1"]).client, now: T0 });
    assert.equal(readSnapshotFile(file).takenAt, new Date(T0).toISOString());
  }));

test("a stopped pull leaves no snapshot and goes on from what it read", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2", "a3"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    assert.deepEqual(snapshotNames(stateDir), []);
    summ.inspected.length = 0;
    summ.state.before = () => {};
    const file = await pull(stateDir, undefined, { client: summ.client, now: T0 + HOUR });
    assert.deepEqual(summ.inspected.sort(), ["a2", "a3"]);
    assert.deepEqual([...readSnapshot(file).history.keys()], ["a1", "a2", "a3"]);
    assert.equal(readSnapshotFile(file).takenAt, new Date(T0).toISOString());
  }));

test("a line cut off by a stop is read again", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    const journal = join(stateDir, "snapshots", readdirSync(join(stateDir, "snapshots"))[0]);
    appendFileSync(journal, '{"a":"a2","action":{"_id"');
    summ.state.before = () => {};
    summ.inspected.length = 0;
    const file = await pull(stateDir, undefined, { client: summ.client, now: T0 + HOUR });
    assert.deepEqual(summ.inspected, ["a2"]);
    assert.deepEqual([...readSnapshot(file).history.keys()], ["a1", "a2"]);
  }));

test("a stopped pull over a day old is not resumed", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    summ.state.before = () => {};
    summ.inspected.length = 0;
    await pull(stateDir, undefined, { client: summ.client, now: T0 + 25 * HOUR });
    assert.deepEqual(summ.inspected.sort(), ["a1", "a2"]);
  }));

test("an action rebuilt during the pull is read under its new id, and only the new list counts", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    // a2 is rebuilt as a3 just before it is read
    summ.state.before = (id) => {
      if (id !== "a2" || summ.state.gone.has("a2")) return;
      summ.state.gone.add("a2");
      summ.state.ids = ["a1", "a3"];
    };
    const file = await pull(stateDir, undefined, { client: summ.client, now: T0 });
    const snapshot = readSnapshotFile(file);
    assert.deepEqual(
      snapshot.actions.map((a) => a.id),
      ["a1", "a3"],
    );
    assert.equal(snapshot.rounds, 3);
    assert.deepEqual([...readSnapshot(file).history.keys()], ["a1", "a3"]);
  }));

test("a list that keeps changing writes no snapshot, and says so", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1"]);
    let n = 1;
    summ.state.before = () => {
      summ.state.ids = [`a${++n}`];
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /kept changing/);
    assert.deepEqual(snapshotNames(stateDir), []);
  }));

test("an action only the source query lists never settles into a snapshot", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1"]);
    summ.state.sourceIds = ["a1", "a2"];
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /kept changing/);
  }));

test("a leg in two actions is read again, and writes no snapshot until it settles", () =>
  quiet(async () => {
    const leg = { _id: "l", quantity: 1 };
    const stuck = stateDirOf();
    const summ = fakeSumm(["a1", "a2"], { a1: [leg], a2: [leg] });
    await assert.rejects(pull(stuck, undefined, { client: summ.client, now: T0 }), /kept changing/);
    assert.deepEqual(snapshotNames(stuck), []);
    // Settled later: the stale read is replaced
    const settles = stateDirOf();
    const moved = fakeSumm(["a1", "a2"], { a1: [leg], a2: [leg] });
    let reads = 0;
    moved.state.before = () => {
      if (++reads === 3) moved.state.legs.a1 = [];
    };
    const file = await pull(settles, undefined, { client: moved.client, now: T0 });
    assert.deepEqual(
      readSnapshot(file).legs.map((l) => l.actionId),
      ["a2"],
    );
  }));

test("a detail read over an hour ago is read again on resuming", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    summ.state.before = () => {};
    summ.inspected.length = 0;
    await pull(stateDir, undefined, { client: summ.client, now: T0 + 2 * HOUR });
    assert.deepEqual(summ.inspected.sort(), ["a1", "a2"]);
  }));

test("a stopped pull is not resumed over a later write", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    writeFileSync(
      join(stateDir, "apply-log.jsonl"),
      JSON.stringify({ call: "edit_transaction", time: new Date(T0 + 1000).toISOString() }) + "\n",
    );
    summ.state.before = () => {};
    summ.inspected.length = 0;
    const file = await pull(stateDir, undefined, { client: summ.client, now: T0 + 2000 });
    assert.deepEqual(summ.inspected.sort(), ["a1", "a2"]);
    assert.equal(readSnapshotFile(file).takenAt, new Date(T0 + 2000).toISOString());
  }));

test("a resumed pull that finishes last is the latest snapshot, though it started first", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    summ.state.before = () => {};
    const other = await pull(stateDir, runDirOf(), { client: summ.client, now: T0 + 60_000 });
    const resumed = await pull(stateDir, undefined, { client: summ.client, now: T0 + 120_000 });
    assert.notEqual(other, resumed);
    assert.equal(latestSnapshot(stateDir), resumed);
    assert.equal(readSnapshotFile(resumed).takenAt, new Date(T0).toISOString());
  }));

test("rangeOf covers the run's periods with a day's margin", () => {
  const range = rangeOf(
    [{ period: { from: "2023-07-01", to: "2024-06-30" } }, { period: { from: "2022-07-01", to: "2023-06-30" } }],
    "UTC",
  );
  assert.deepEqual([range.from, range.to], ["2022-07-01", "2024-06-30"]);
  assert.equal(range.after, Date.parse("2022-06-30T00:00:00Z"));
  assert.equal(range.before, Date.parse("2024-07-02T00:00:00Z"));
});

const HEADER =
  "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional)";
function runDirOf(): string {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(dir, "csv"));
  writeFileSync(join(dir, "csv", "2023-07-01_2024-06-30_THOR_abc_Wallet.csv"), HEADER + "\n");
  return dir;
}

test("with a run, a pull asks for the run's range; --all asks for everything", () =>
  quiet(async () => {
    const runDir = runDirOf();
    const ranged = fakeSumm(["a1"]);
    const file = await pull(stateDirOf(), runDir, { client: ranged.client, now: T0 });
    const after = (f: unknown) => (JSON.stringify(f) ?? "").includes('"after"');
    assert.ok(ranged.filters.every(after));
    assert.deepEqual(
      [(readSnapshotFile(file).range as PullRange).from, readSnapshotFile(file).run],
      ["2023-07-01", resolve(runDir)],
    );
    const all = fakeSumm(["a1"]);
    const whole = await pull(stateDirOf(), runDir, { client: all.client, now: T0, all: true });
    assert.ok(!all.filters.some(after));
    assert.equal(readSnapshotFile(whole).range, null);
  }));

test("a different run or range does not resume another's stopped pull", () =>
  quiet(async () => {
    const stateDir = stateDirOf();
    const summ = fakeSumm(["a1", "a2"]);
    summ.state.before = (id) => {
      if (id === "a2") throw new Error("stopped");
    };
    await assert.rejects(pull(stateDir, undefined, { client: summ.client, now: T0 }), /stopped/);
    summ.state.before = () => {};
    summ.inspected.length = 0;
    await pull(stateDir, runDirOf(), { client: summ.client, now: T0 + HOUR });
    assert.deepEqual(summ.inspected.sort(), ["a1", "a2"]);
  }));

test("legsOf keeps a fee Summ holds on the leg itself, by its currency symbol or name", () => {
  const leg = (over: Record<string, unknown>) => ({
    _id: "g",
    id: "tx",
    trade: "out",
    currency: "BUSD-BD1",
    quantity: "100",
    ...over,
  });
  const legs = legsOf({
    action: {
      _id: "a1",
      outgoing: [
        leg({ feeQuantity: "0.000075", feeCurrency: "BNB" }),
        leg({ feeQuantity: 0.000075, feeCurrency: "x", feeCurrencyIdentifier: { symbol: "BNB" } }),
        leg({ feeQuantity: 0 }),
        leg({}),
      ],
    },
  } as never);
  assert.deepEqual(
    legs.map((l) => [l.feeQuantity, l.feeCurrency]),
    [
      [0.000075, "BNB"],
      [0.000075, "BNB"],
      [undefined, undefined],
      [undefined, undefined],
    ],
  );
});
