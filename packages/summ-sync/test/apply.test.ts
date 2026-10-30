import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPlan,
  checkFresh,
  runApply,
  type ApplyOptions,
  type LogLine,
  type PlanFile,
  type ToolCaller,
  undoHandle,
} from "../src/apply.ts";
import type { DeleteEntry, EditEntry } from "../src/plan.ts";

// Every value below is made up.
const OPTS: ApplyOptions = { approveDeletes: false, approveFiled: false, dryRun: false };

interface FakeLeg {
  price?: number;
  _id: string;
  trade: string;
  quantity: string;
  timestamp?: string;
  id?: string;
  importType?: string;
  side?: "incoming" | "outgoing" | "fees";
}

/** Summ as a fake MCP server: actions of incoming legs; an edit rebuilds the action under a new id. */
class FakeSumm implements ToolCaller {
  actions = new Map<string, FakeLeg[]>();
  calls: { name: string; args: Record<string, unknown> }[] = [];
  splits = true;
  private n = 0;

  add(actionId: string, legs: FakeLeg[]) {
    this.actions.set(actionId, legs);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, args });
    if (name === "query_summ_transactions") {
      // Like Summ's id filter: the leg's action, then unrelated ones
      const ids = (args.filter as { value: string[] }).value;
      const all = [...this.actions];
      const own = all.filter(([, legs]) => legs.some((l) => ids.includes(l._id)));
      const hits = [...own, ...all.filter((a) => !own.includes(a))];
      return hits.map(([actionId], i) => `## ${i + 1}. Send\n- **Action ID**: \`${actionId}\`\n`).join("\n");
    }
    if (name === "inspect_transaction") {
      const legs = this.actions.get(args.actionId as string) ?? [];
      const side = (s: string) => legs.filter((l) => (l.side ?? "incoming") === s).map(({ side: _, ...l }) => l);
      const action = { _id: args.actionId, incoming: side("incoming"), outgoing: side("outgoing"), fees: side("fees") };
      return `# Action\n\`\`\`json\n${JSON.stringify(action)}\n\`\`\`\n## Change History\n`;
    }
    if (name === "edit_transaction") {
      const legs = this.actions.get(args.actionId as string) as FakeLeg[];
      for (const { transactionId, updates } of args.edits as { transactionId: string; updates: Partial<FakeLeg> }[]) {
        Object.assign(legs.find((l) => l._id === transactionId) as FakeLeg, updates);
      }
      this.actions.delete(args.actionId as string);
      const next = `rebuilt${++this.n}`;
      // Like Summ: a categorised send no longer pairs with the receive it made up, which is left on its own,
      // and a leg edited to an ignore type moves to an action of its own
      const madeUp = legs.filter((l) => l.importType === "soft-transfer");
      const ignored = legs.filter((l) => l.trade === "ignoreIn" || l.trade === "ignoreOut");
      if (this.splits && madeUp.length) this.actions.set(`alone${this.n}`, madeUp);
      if (this.splits && ignored.length && ignored.length < legs.length) this.actions.set(`ignored${this.n}`, ignored);
      this.actions.set(next, this.splits ? legs.filter((l) => !madeUp.includes(l) && !ignored.includes(l)) : legs);
      return `Edited 1 action.\n- **Bulk Edit ID**: \`undo${this.n}abcdef\`\n- **Affected Action IDs**: ${next}`;
    }
    if (name === "bulk_edit_transactions") {
      if (args.filter) throw new Error("a write selected by filter");
      const ids = args.actionIds as string[];
      if ((args.operation as { type: string }).type === "ignore") {
        for (const id of ids) for (const l of this.actions.get(id) ?? []) l.trade = "ignoreIn";
        return `Bulk ignore updated ${ids.length} action.\nBulk Edit ID: ignore${++this.n}abcdef`;
      }
      for (const id of ids) this.actions.delete(id);
      return `Deleted ${ids.length} actions.`;
    }
    throw new Error(`unexpected tool ${name}`);
  }
}

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

async function run(summ: FakeSumm, plan: PlanFile, opts: Partial<ApplyOptions> = {}) {
  const log: Omit<LogLine, "time" | "plan">[] = [];
  const state = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  const result = await applyPlan(
    summ,
    plan,
    { ...OPTS, ...opts },
    (l) => log.push(l),
    () => {},
    0,
    state,
  );
  return { result, log, state };
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
  const change = log.find((l) => l.legId === "leg-1");
  assert.deepEqual([change?.field, change?.value, change?.undo], ["trade", "bridgeTradeOut", "undo1abcdef"]);
});

test("a price edit sends the USD price with its currency and logs the USD price", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "income", quantity: "1", price: 3.9 }]);
  const changes: EditEntry["changes"] = [{ leg: "base", legId: "leg-1", field: "price", summ: 3.9, desired: 2.5 }];
  const { result, log } = await run(summ, planFile({ edit: [edit({ changes })] }));
  assert.equal(result.edited, 1);
  const call = summ.calls.find((c) => c.name === "edit_transaction");
  assert.deepEqual(call?.args, {
    actionId: "a",
    edits: [{ transactionId: "leg-1", updates: { price: 2.5, priceValueCurrency: "USD" } }],
  });
  const change = log.find((l) => l.legId === "leg-1");
  assert.deepEqual([change?.field, change?.value, typeof change?.after], ["price", 2.5, "number"]);
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

test("a leg that changed since the pull is skipped and reported, not edited", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "deposit", quantity: "1" }]);
  const { result, log } = await run(summ, planFile({ categorise: [edit()] }));
  assert.equal(result.edited, 0);
  assert.match(result.skipped[0].reason, /trade of leg leg-1 is "deposit"/);
  assert.equal(
    summ.calls.some((c) => c.name === "edit_transaction"),
    false,
  );
  assert.equal(log[0].call, "skip");
  assert.equal(log[0].legId, undefined, "a skip must not read back as an edit of the sync");
});

const MADE_UP: FakeLeg = { _id: "made-up", trade: "deposit", quantity: "1", importType: "soft-transfer" };

test("after categorising, the receive Summ made up is ignored by its own action id once it is alone", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }, { ...MADE_UP }]);
  const { result, log } = await run(summ, planFile({ categorise: [edit({ ignore: ["made-up"] })] }));
  assert.equal(result.edited, 1);
  const ignore = summ.calls.find((c) => c.name === "bulk_edit_transactions");
  assert.deepEqual(ignore?.args, { actionIds: ["alone1"], operation: { type: "ignore" } });
  assert.equal(summ.actions.get("alone1")?.[0].trade, "ignoreIn");
  const line = log.find((l) => l.operation === "ignore");
  assert.deepEqual([line?.legIds, line?.undo, line?.field], [["made-up"], "ignore2abcdef", undefined]);
});

test("a made-up leg already on its own is ignored without an edit", async () => {
  const summ = new FakeSumm();
  summ.add("b", [{ ...MADE_UP }]);
  const { result } = await run(summ, planFile({ categorise: [edit({ changes: [], ignore: ["made-up"] })] }));
  assert.equal(result.edited, 0);
  assert.equal(summ.actions.get("b")?.[0].trade, "ignoreIn");
});

test("a made-up leg still in an action with other legs is skipped, not ignored", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("a", [{ _id: "leg-1", trade: "withdrawal", quantity: "1" }, { ...MADE_UP }]);
  const { result } = await run(summ, planFile({ categorise: [edit({ ignore: ["made-up"] })] }));
  assert.match(result.skipped[0].reason, /still shares its action with 1 other legs/);
  assert.equal(
    summ.calls.some((c) => c.name === "bulk_edit_transactions"),
    false,
  );
});

test("a made-up leg is not ignored when its send was skipped", async () => {
  const summ = new FakeSumm();
  summ.add("a", [{ _id: "leg-1", trade: "deposit", quantity: "1" }, { ...MADE_UP }]);
  await run(summ, planFile({ categorise: [edit({ ignore: ["made-up"] })] }));
  assert.equal(
    summ.calls.some((c) => c.name === "bulk_edit_transactions"),
    false,
  );
});

test("a leg no longer in Summ is skipped", async () => {
  const { result } = await run(new FakeSumm(), planFile({ edit: [edit()] }));
  assert.match(result.skipped[0].reason, /no longer in Summ/);
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
    summ.calls.map((c) => c.name).filter((n) => n !== "query_summ_transactions" && n !== "inspect_transaction"),
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

test("a deleted action is first saved to the store as it was just inspected, and the log names the file", async () => {
  const summ = new FakeSumm();
  summ.add("d", [{ _id: "leg-9", trade: "withdrawal", quantity: "1.5" }]);
  const { log, state } = await run(summ, planFile({ delete: [del()] }), { approveDeletes: true });
  const file = join(state, "actions", "d.json");
  assert.deepEqual(log[0].saved, [file]);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([saved.action._id, saved.action.incoming[0].quantity], ["d", "1.5"]);
  // a dry run saves nothing
  const summ2 = new FakeSumm();
  summ2.add("d", [{ _id: "leg-9", trade: "withdrawal", quantity: "1" }]);
  const dry = await run(summ2, planFile({ delete: [del()] }), { approveDeletes: true, dryRun: true });
  assert.equal(existsSync(join(dry.state, "actions")), false);
});

test("a leg that shares its action is split off by an ignore edit, then its own action is deleted", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "fee", quantity: "0.02", side: "fees" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  const { result, log, state } = await run(summ, planFile({ delete: [del({ otherLegs: 1 })] }), {
    approveDeletes: true,
  });
  assert.deepEqual([result.split, result.deleted], [1, 1]);
  const editCall = summ.calls.find((c) => c.name === "edit_transaction");
  assert.deepEqual(editCall?.args, {
    actionId: "d",
    edits: [{ transactionId: "leg-9", updates: { trade: "ignoreOut" } }],
  });
  const deleteCall = summ.calls.find((c) => c.name === "bulk_edit_transactions");
  assert.deepEqual(deleteCall?.args, { actionIds: ["ignored1"], operation: { type: "delete" } });
  // the legs that stay are untouched, in their rebuilt action
  assert.deepEqual([...summ.actions.values()], [[{ _id: "their-leg", trade: "deposit", quantity: "1" }]]);
  // both actions saved: the shared one before the edit, the split-off one before the delete
  assert.deepEqual(log.find((l) => l.legId === "leg-9")?.saved, join(state, "actions", "d.json"));
  assert.deepEqual(log.at(-1)?.saved, [join(state, "actions", "ignored1.json")]);
  assert.deepEqual(
    log.filter((l) => l.field).map((l) => [l.call, l.kind, l.legId, l.field, l.from, l.value, l.undo]),
    [["edit_transaction", "split", "leg-9", "trade", "fee", "ignoreOut", "undo1abcdef"]],
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

test("a leg already ignored that still shares its action is skipped, not edited again", async () => {
  const summ = new FakeSumm();
  summ.add("d", [
    { _id: "leg-9", trade: "ignoreOut", quantity: "1", side: "outgoing" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  const { result } = await run(summ, planFile({ delete: [del({ otherLegs: 1 })] }), { approveDeletes: true });
  assert.match(result.skipped[0].reason, /already ignored/);
  assert.equal(
    summ.calls.some((c) => c.name !== "query_summ_transactions" && c.name !== "inspect_transaction"),
    false,
  );
});

test("when Summ does not split the leg off, apply stops at the edit and reports the undo handle; nothing is deleted", async () => {
  const summ = new FakeSumm();
  summ.splits = false;
  summ.add("d", [
    { _id: "leg-9", trade: "withdrawal", quantity: "1" },
    { _id: "their-leg", trade: "deposit", quantity: "1" },
  ]);
  const { result } = await run(summ, planFile({ delete: [del({ otherLegs: 1 })] }), { approveDeletes: true });
  assert.equal(result.deleted, 0);
  assert.match(result.skipped[0].reason, /did not split.*undo undo1abcdef/);
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
    summ.calls.every((c) => c.name === "query_summ_transactions" || c.name === "inspect_transaction"),
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
  await assert.rejects(
    applyPlan(
      failing,
      plan,
      OPTS,
      () => {},
      () => {},
      0,
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
