import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsWithTxids, pull } from "../src/pull.ts";
import { legsOf, readAction, readSnapshot, readSnapshotFile, syncView } from "../src/snapshot.ts";

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

/** Summ as a fake MCP server: the listed actions, all of the managed source (or `sourceIds`, as the source
 * query lists them); counts inspect calls. `legs` gives an action's outgoing legs, `moved` a value of a field
 * the sync does not read. */
function fakeSumm(listedIds: string[], legs: Record<string, unknown[]> = {}, moved = 0, sourceIds = listedIds) {
  const inspected: string[] = [];
  const client = {
    connect: async () => {},
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === "query_summ_transactions") {
        const actionIds = args.filter ? sourceIds : listedIds;
        const blocks = actionIds.map(
          (id, i) =>
            `## ${i + 1}. send\n- **Action ID**: \`${id}\`\n- **Tx Hash**: \`h${id}\`\n- **Action Category**: send`,
        );
        return `# Transactions (Page 1 of 1, ${actionIds.length} returned, ${actionIds.length} total)\n\n${blocks.join("\n\n")}`;
      }
      const id = args.actionId as string;
      inspected.push(id);
      const action = { _id: id, sortPriority: moved, outgoing: legs[id] ?? [] };
      return `\`\`\`json\n${JSON.stringify(action)}\n\`\`\`\n## Change History\n- 1 Jan 2024 10:00 · import (original)\n- _${moved} earlier versions not read._\n`;
    },
  };
  return { client, inspected };
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
const tick = () => new Promise((r) => setTimeout(r, 1100)); // snapshots are named by the second

test("pull stores each action once and fetches only the ids the store lacks", () =>
  quiet(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "summ-sync-pull-"));
    writeFileSync(join(stateDir, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
    const first = fakeSumm(["a1", "a2", "a3"]);
    await pull(stateDir, undefined, { client: first.client });
    assert.deepEqual(first.inspected.sort(), ["a1", "a2", "a3"]);
    await tick();
    // a2 was edited (a new id, a4), a3 deleted, a5 added
    const second = fakeSumm(["a1", "a4", "a5"]);
    const file = await pull(stateDir, undefined, { client: second.client });
    assert.deepEqual(second.inspected.sort(), ["a4", "a5"]);
    assert.deepEqual(readdirSync(join(stateDir, "actions")).sort(), [
      "a1.json",
      "a2.json",
      "a3.json",
      "a4.json",
      "a5.json",
    ]);
    assert.deepEqual(readdirSync(join(stateDir, "snapshots")).length, 2);
    const snapshot = readSnapshotFile(file);
    assert.deepEqual([snapshot.total, snapshot.details, snapshot.stored, snapshot.fetched], [3, 3, 1, 2]);
    assert.deepEqual(
      snapshot.actions,
      ["a1", "a4", "a5"].map((id) => ({ id, txHash: `h${id}`, category: "send", tags: [], detail: true })),
    );
    assert.deepEqual([...readSnapshot(file).history.keys()], ["a1", "a4", "a5"]);
  }));

test("pull --full fetches every needed action again and reports a stored id whose legs differ", () =>
  quiet(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "summ-sync-pull-"));
    writeFileSync(join(stateDir, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
    await pull(stateDir, undefined, { client: fakeSumm(["a1", "a2"], { a2: [{ _id: "l", quantity: 1 }] }).client });
    const a1 = readFileSync(join(stateDir, "actions", "a1.json"), "utf8");
    await tick();
    // a1 moved only in fields the sync does not read; a2's leg changed under the same id
    const full = fakeSumm(["a1", "a2"], { a2: [{ _id: "l", quantity: 2 }] }, 7);
    const file = await pull(stateDir, undefined, { client: full.client, full: true });
    assert.deepEqual(full.inspected.sort(), ["a1", "a2"]);
    assert.deepEqual(readSnapshotFile(file).differs, ["a2"]);
    assert.equal(readFileSync(join(stateDir, "actions", "a1.json"), "utf8"), a1, "kept as first read");
    assert.deepEqual(readAction(stateDir, "a2")?.action.outgoing, [{ _id: "l", quantity: 2 }], "replaced");
  }));

test("an action Summ rebuilt during the pull, seen only by the source query, joins the snapshot", () =>
  quiet(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "summ-sync-pull-"));
    writeFileSync(join(stateDir, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
    // the full list saw a1 and a2; by the source query a2 had been rebuilt as a3
    const file = await pull(stateDir, undefined, { client: fakeSumm(["a1", "a2"], {}, 0, ["a1", "a3"]).client });
    const snapshot = readSnapshotFile(file);
    assert.deepEqual(
      snapshot.actions.map((a) => [a.id, a.detail ?? false]),
      [
        ["a1", true],
        ["a2", false],
        ["a3", true],
      ],
    );
    assert.equal(snapshot.late, 1);
    assert.deepEqual([...readSnapshot(file).history.keys()], ["a1", "a3"]);
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

test("syncView leaves out updatedAt, which Summ moves under the same id, and keeps the price", () => {
  const detail = (updatedAt: string, price: number) => ({
    action: { _id: "a", incoming: [{ _id: "l", id: "x", trade: "income", quantity: 1, updatedAt, price }] },
    history: [],
  });
  assert.equal(syncView(detail("2026-01-01", 1) as never), syncView(detail("2026-01-02", 1) as never));
  assert.notEqual(syncView(detail("2026-01-01", 1) as never), syncView(detail("2026-01-01", 2) as never));
});
