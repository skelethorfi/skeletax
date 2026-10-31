import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { ADOPT_WINDOW, makePlan, parseScope, type PlanInput } from "../src/plan.ts";
import type { Row, RunFile } from "../src/run.ts";
import { type Leg, legsOf as legsOfDetail, writeSnapshot } from "../src/snapshot.ts";
import type { Override } from "../src/state.ts";
import { mergeTables, readOverrides } from "../src/state.ts";
import { priceLines, renderPlan, uploadedPrices, uploadFiles, uploadPriceFiles, writePlan } from "../src/write-plan.ts";
import { categorisedTxids } from "../src/pull.ts";
import { summType } from "../src/summ-types.ts";

// Every value below is made up.
const PERIOD = { from: "2023-07-01", to: "2024-06-30" };
const THOR_FILE = "2023-07-01_2024-06-30_THOR_abcde_Example.csv";
const BTC_FILE = "2023-07-01_2024-06-30_BTC_fghij_Example.csv";
const FILES: RunFile[] = [
  { name: THOR_FILE, chain: "THOR", period: PERIOD, header: "HEADER" },
  { name: BTC_FILE, chain: "BTC", period: PERIOD, header: "HEADER" },
];
const CONFIG: Config = { ...DEFAULTS, managedSources: ["csv-source"] };
const TX1 = "1".repeat(64);
const TX2 = "2".repeat(64);

let next = 0;
const legId = () => `leg${String(++next).padStart(4, "0")}`;

function row(over: Partial<Row> = {}): Row {
  const r: Row = {
    file: THOR_FILE,
    chain: "THOR",
    line: "",
    id: "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa",
    timestamp: "2024-03-01T10:00:00.000Z",
    type: "send",
    baseCurrency: "RUNE",
    baseAmount: "1.5",
    quoteCurrency: "",
    quoteAmount: "",
    feeCurrency: "",
    feeAmount: "",
    from: "wallet-a",
    to: "wallet-b",
    blockchain: "THORChain",
    description: `Sent 1.5 RUNE; ${TX1}`,
    txids: [TX1],
    ...over,
  };
  r.line = `${r.timestamp},${r.type},${r.id}`;
  return r;
}

/** The legs Summ makes of a managed row: base, quote of a trade, fee. */
function legsOf(r: Row, over: Partial<Leg> = {}, actionId = "action1"): Leg[] {
  const common = {
    actionId,
    id: r.id,
    timestamp: r.timestamp,
    from: r.from,
    to: r.to,
    blockchain: "thorchain",
    description: r.description,
    source: "csv-source",
    importType: "manual-csv",
    comments: [],
  };
  const sides: Record<string, ["incoming" | "outgoing", string]> = {
    send: ["outgoing", "withdrawal"],
    receive: ["incoming", "deposit"],
    sell: ["outgoing", "sell"],
    staking: ["incoming", "staking"],
    lost: ["outgoing", "lost"],
    "receive-lp-token": ["incoming", "receivingLiquidityProviderToken"],
    "return-lp-token": ["outgoing", "returningLiquidityProviderToken"],
  };
  const [side, trade] = sides[r.type];
  const legs: Leg[] = [
    { ...common, legId: legId(), side, trade, currency: r.baseCurrency, quantity: Number(r.baseAmount), ...over },
  ];
  if (r.quoteCurrency)
    legs.push({
      ...common,
      legId: legId(),
      side: side === "incoming" ? "outgoing" : "incoming",
      trade: "buy",
      currency: r.quoteCurrency,
      quantity: Number(r.quoteAmount),
    });
  if (r.feeAmount)
    legs.push({
      ...common,
      legId: legId(),
      side: "fees",
      trade: "fee",
      currency: r.feeCurrency,
      quantity: Number(r.feeAmount),
    });
  return legs;
}

function plan(over: Partial<PlanInput>) {
  return makePlan({
    files: FILES,
    rows: [],
    legs: [],
    history: new Map(),
    txHashes: new Set(),
    config: CONFIG,
    adopted: new Map(),
    overrides: [],
    applyLog: [],
    now: "2024-08-01T00:00:00.000Z",
    ...over,
  });
}

const empty = (p: ReturnType<typeof plan>["plan"]) =>
  [p.delete, p.edit, p.upload, p.categorise, p.report, p.overridden].every((s) => s.length === 0);

test("a row Summ holds as the run has it plans nothing", () => {
  const r = row({ feeCurrency: "RUNE", feeAmount: "0.02" });
  const { plan: p } = plan({ rows: [r], legs: legsOf(r) });
  assert.ok(empty(p), JSON.stringify(p, null, 1));
  assert.equal(p.counts.matchedRows, 1);
});

test("a trade compares its quote leg; amounts within 1e-8 of the amount or at the 8th decimal are equal", () => {
  const r = row({ type: "sell", quoteCurrency: "BTC", quoteAmount: "0.001" });
  const legs = legsOf(r);
  legs[0].quantity = 1.5 * (1 + 1e-10);
  assert.ok(empty(plan({ rows: [r], legs }).plan));
  legs[1].quantity = 0.00100000999;
  assert.ok(empty(plan({ rows: [r], legs }).plan));
  legs[1].quantity = 0.002;
  const { plan: p } = plan({ rows: [r], legs });
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.leg, c.field, c.summ, c.desired]),
    [["quote", "quantity", 0.002, 0.001]],
  );
});

test("a sell paying its fee in the asset sold matches Summ's amount with the fee added; another amount is an edit", () => {
  const r = row({
    type: "sell",
    baseAmount: "400",
    quoteCurrency: "BRUNE",
    quoteAmount: "399.4",
    feeCurrency: "RUNE",
    feeAmount: "0.24488481",
  });
  assert.ok(empty(plan({ rows: [r], legs: legsOf(r, { quantity: 400.24488481 }) }).plan));
  assert.ok(empty(plan({ rows: [r], legs: legsOf(r) }).plan));
  const { plan: p } = plan({ rows: [r], legs: legsOf(r, { quantity: 401 }) });
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.field, c.summ, c.desired]),
    [["quantity", 401, 400]],
  );
  const send = row({ feeCurrency: "RUNE", feeAmount: "0.02" });
  assert.deepEqual(
    plan({ rows: [send], legs: legsOf(send, { quantity: 1.52 }) }).plan.edit[0].changes.map((c) => c.field),
    ["quantity"],
  );
});

test("a changed amount, type or time is an edit of the leg", () => {
  const r = row({ type: "receive", baseAmount: "2" });
  const legs = legsOf(row({ type: "receive" }), { trade: "staking", timestamp: "2024-03-01T10:00:00.900Z" });
  const { plan: p } = plan({ rows: [r], legs });
  assert.equal(p.edit.length, 1);
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.field, c.summ, c.desired]),
    [
      ["trade", "staking", "deposit"],
      ["quantity", 1.5, 2],
    ],
  );
  assert.equal(p.edit[0].changes[0].legId, legs[0].legId);
});

test("a blank blockchain in Summ is not compared (Summ infers it from the wallet); another chain is", () => {
  const r = row();
  assert.ok(empty(plan({ rows: [r], legs: legsOf(r, { blockchain: "" }) }).plan));
  const { plan: p } = plan({ rows: [r], legs: legsOf(r, { blockchain: "btc" }) });
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.field, c.summ, c.desired]),
    [["blockchain", "btc", "thorchain"]],
  );
});

test("a categorised row matches a leg whose hash carries an output index", () => {
  const r = btcRow({ type: "bridge-trade-out" });
  const { plan: p } = plan({ rows: [r], legs: [ownLeg({ id: `${TX1}__1` })] });
  assert.equal(p.categorise.length, 1);
});

test("a changed time moves every leg of the row, in one edit", () => {
  const r = row({ feeCurrency: "RUNE", feeAmount: "0.02" });
  const legs = legsOf(r).map((l) => ({ ...l, timestamp: "2024-03-01T09:59:50.000Z" }));
  const { plan: p } = plan({ rows: [r], legs });
  assert.equal(p.edit.length, 1);
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.leg, c.field, c.desired]),
    [
      ["base", "timestamp", r.timestamp],
      ["fee", "timestamp", r.timestamp],
    ],
  );

  // a row whose fee leg Summ already split into another action is deleted and uploaded, not edited
  const split = legsOf(r).map((l) =>
    l.side === "fees" ? { ...l, actionId: "action2", timestamp: "2024-03-01T09:59:50.000Z" } : l,
  );
  const remade = plan({ rows: [r], legs: split }).plan;
  assert.deepEqual(
    [remade.edit, remade.delete.map((d) => d.reason), remade.upload.map((u) => u.ids)],
    [[], ["legs in several actions"], [[r.id]]],
  );

  // a fee leg's time the user set by hand is kept (captured), not moved
  const history = new Map([["action1", ["2 Jan 2024 · user · Date: 1 Mar 2024 10:00 → 1 Mar 2024 09:59"]]]);
  const kept = plan({
    rows: [r],
    legs: legsOf(r).map((l) => (l.side === "fees" ? { ...l, timestamp: "2024-03-01T09:59:50.000Z" } : l)),
    history,
  }).plan;
  assert.deepEqual([kept.edit, kept.overridden.map((o) => [o.kind, o.override.leg])], [[], [["captured", "fee"]]]);
});

test("a changed description, currency or shape deletes the legs and uploads the row", () => {
  const r = row({ feeCurrency: "RUNE", feeAmount: "0.02" });
  for (const [legs, reason] of [
    [legsOf(r, { description: "Old wording" }), /description/],
    [legsOf(r, { currency: "ETH" }), /currency/],
    [legsOf(row()), /shape/],
  ] as const) {
    const { plan: p } = plan({ rows: [r], legs: [...legs] });
    assert.equal(p.delete.length, 1);
    assert.match(p.delete[0].reason, reason);
    assert.deepEqual(
      p.delete[0].legIds,
      legs.map((l) => l.legId),
    );
    assert.deepEqual(p.upload, [{ file: THOR_FILE, filed: false, ids: [r.id] }]);
    assert.equal(p.edit.length, 0);
  }
});

test("a row with no fee whose Summ legs have one loses only the fee leg: a delete of it alone, no upload", () => {
  const r = row();
  const legs = legsOf(row({ feeCurrency: "RUNE", feeAmount: "0.02" }));
  const fee = legs.find((l) => l.side === "fees") as Leg;
  const { plan: p } = plan({ rows: [r], legs });
  assert.equal(p.delete.length, 1);
  assert.deepEqual(p.delete[0].legIds, [fee.legId]);
  assert.equal(p.delete[0].id, r.id);
  assert.equal(p.delete[0].otherLegs, 1);
  assert.match(p.delete[0].reason, /fee leg lost/);
  assert.deepEqual(p.upload, []);
  assert.equal(p.edit.length, 0);
  // a row that also changed otherwise is still deleted whole and uploaded
  const moved = plan({
    rows: [r],
    legs: legsOf(row({ feeCurrency: "RUNE", feeAmount: "0.02" }), { description: "Old wording" }),
  }).plan;
  assert.equal(moved.delete.length, 1);
  assert.equal(moved.delete[0].legIds.length, 2);
  assert.deepEqual(moved.upload, [{ file: THOR_FILE, filed: false, ids: [r.id] }]);
});

test("a row Summ lacks is uploaded, filed years apart, with the file header and its line", () => {
  const now = row();
  const old = row({ id: "2023-08-01T00:00:00.000Z.out.bbbbbbbbbbbb", timestamp: "2023-08-01T00:00:00.000Z" });
  const { plan: p } = plan({ rows: [now, old], config: { ...CONFIG, filedBefore: "2024-01-01" } });
  assert.deepEqual(p.upload, [
    { file: THOR_FILE, filed: false, ids: [now.id] },
    { file: THOR_FILE, filed: true, ids: [old.id] },
  ]);
  const files = uploadFiles(p, FILES, [now, old]);
  assert.deepEqual(
    files.map((f) => f.name),
    [THOR_FILE, THOR_FILE.replace(".csv", "_filed.csv")],
  );
  assert.equal(files[0].text, `HEADER\n${now.line}\n`);
});

test("a leg with no row is deleted only inside the run's periods", () => {
  const gone = legsOf(row({ id: "2024-02-01T00:00:00.000Z.in.cccccccccccc", timestamp: "2024-02-01T00:00:00.000Z" }));
  const earlier = legsOf(
    row({ id: "2022-02-01T00:00:00.000Z.in.dddddddddddd", timestamp: "2022-02-01T00:00:00.000Z" }),
  );
  const earlierLegacy = legsOf(row({ id: "old-file.csv:3", timestamp: "2022-02-01T00:00:00.000Z" }));
  const { plan: p } = plan({ legs: [...gone, ...earlier, ...earlierLegacy] });
  assert.deepEqual(
    p.delete.map((d) => [d.summId, d.reason]),
    [["2024-02-01T00:00:00.000Z.in.cccccccccccc", "no row in the run"]],
  );
  assert.equal(p.counts.managedLegsOutOfScope, 2);
});

test("a delete counts the other legs in its actions", () => {
  const gone = legsOf(row({ id: "2024-02-01T00:00:00.000Z.in.cccccccccccc" }), {}, "shared");
  const other: Leg = {
    ...gone[0],
    legId: legId(),
    side: "incoming",
    id: TX1,
    source: "btc-wallet",
    importType: "wallet",
  };
  const { plan: p } = plan({ legs: [...gone, other] });
  assert.equal(p.delete[0].otherLegs, 1);
});

test("an old <file>:<n> leg is adopted to the one row with its time, type, currency, amount and txid", () => {
  const r = row({ description: `New wording; ${TX1}` });
  const legs = legsOf(r, { id: "old-file.csv:7", description: `Old wording; ${TX1.toUpperCase()}` });
  const first = plan({ rows: [r], legs });
  assert.deepEqual(first.plan.adopted, [{ legId: legs[0].legId, id: r.id }]);
  assert.ok(empty(first.plan), JSON.stringify(first.plan, null, 1));
  assert.equal(first.adopted.get(legs[0].legId), r.id);

  // Next plan: matched through adopted.csv; a later amount change is an edit, not a re-upload
  const second = plan({ rows: [{ ...r, baseAmount: "1.6" }], legs, adopted: first.adopted });
  assert.deepEqual(second.plan.adopted, []);
  assert.deepEqual(
    second.plan.edit[0].changes.map((c) => c.field),
    ["quantity"],
  );
});

test("an old leg with another txid, or none of the row's values, is deleted and the row uploaded", () => {
  const r = row();
  for (const over of [{ description: `Old; ${TX2}` }, { quantity: 9 }]) {
    const { plan: p } = plan({ rows: [r], legs: legsOf(r, { id: "old-file.csv:7", ...over }) });
    assert.equal(p.adopted.length, 0);
    assert.match(p.delete[0].reason, /old ID/);
    assert.deepEqual(p.upload[0].ids, [r.id]);
  }
});

test("an old leg that fits two rows is reported, and neither row is uploaded", () => {
  const a = row({ description: "no txid" });
  const b = row({ id: "2024-03-01T10:00:00.000Z.out.eeeeeeeeeeee", description: "no txid either" });
  const { plan: p } = plan({ rows: [a, b], legs: legsOf(a, { id: "old-file.csv:7", description: "" }) });
  assert.equal(p.report[0].kind, "ambiguous-adoption");
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.delete, []);
});

test("an old leg a little apart from its row is adopted when it is in the same wallet, and its time edited", () => {
  const r = row({ description: "no txid" });
  const legs = legsOf(r, {
    id: "old-file.csv:7",
    description: "",
    timestamp: "2024-03-01T09:59:43.000Z",
    to: "vault-address",
  });
  const { plan: p } = plan({ rows: [r], legs });
  assert.deepEqual(p.adopted, [{ legId: legs[0].legId, id: r.id }]);
  assert.deepEqual(
    p.edit[0].changes.map((c) => c.field),
    ["timestamp", "to"],
  );
  assert.deepEqual([p.upload, p.delete], [[], []]);

  // In another wallet, or further apart than ADOPT_WINDOW, it is not
  for (const over of [
    { from: "wallet-z", timestamp: "2024-03-01T09:59:43.000Z" },
    { timestamp: new Date(Date.parse(r.timestamp) - (ADOPT_WINDOW + 1) * 1000).toISOString() },
  ]) {
    assert.deepEqual(
      plan({ rows: [r], legs: legsOf(r, { id: "old-file.csv:7", description: "", ...over }) }).plan.adopted,
      [],
    );
  }
});

test("an old leg of another type in the same wallet is adopted and its type edited, unless a row of its own type fits", () => {
  const r = row({ description: "no txid" });
  const legs = legsOf(r, {
    id: "old-file.csv:7",
    description: "",
    trade: "outgoingGift",
    timestamp: "2024-03-01T10:00:10.000Z",
  });
  const { plan: p } = plan({ rows: [r], legs });
  assert.deepEqual(
    p.adopted.map((a) => a.id),
    [r.id],
  );
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.field, c.desired]),
    [
      ["trade", "withdrawal"],
      ["timestamp", r.timestamp],
    ],
  );

  // A row of the leg's own type further apart is preferred to one of another type nearer
  const near = row({
    id: "2024-03-01T10:00:10.000Z.out.bbbbbbbbbbbb",
    timestamp: "2024-03-01T10:00:10.000Z",
    type: "sell",
    description: "no txid",
  });
  const own = row({
    id: "2024-03-01T10:01:00.000Z.out.cccccccccccc",
    timestamp: "2024-03-01T10:01:00.000Z",
    description: "no txid",
  });
  const both = plan({ rows: [near, own], legs: legsOf(r, { id: "old-file.csv:7", description: "" }) });
  assert.deepEqual(
    both.plan.adopted.map((a) => a.id),
    [own.id],
  );
  assert.deepEqual(both.plan.upload[0].ids, [near.id]);
});

test("an old leg with a row's currency and amount in the same wallet, but adopted to none, is reported, not deleted", () => {
  const r = row({ description: "no txid" });
  const legs = legsOf(r, { id: "old-file.csv:7", description: "", timestamp: "2024-03-01T07:00:00.000Z" });
  const { plan: p } = plan({ rows: [r], legs });
  assert.deepEqual(
    p.report.map((e) => [e.kind, e.legIds]),
    [["legacy-lookalike", [legs[0].legId]]],
  );
  assert.match(p.report[0].detail, new RegExp(r.id));
  assert.deepEqual([p.adopted, p.delete, p.upload], [[], [], []]);

  // One that names another txid is another tx, and one more than a day apart another event: deleted, and the
  // row uploaded
  for (const over of [
    { description: `Old; ${TX2}`, timestamp: "2024-03-01T07:00:00.000Z" },
    { description: "", timestamp: "2024-02-28T10:00:00.000Z" },
  ]) {
    const other = plan({ rows: [r], legs: legsOf(r, { id: "old-file.csv:7", ...over }) }).plan;
    assert.deepEqual([other.report, other.delete.length, other.upload[0].ids], [[], 1, [r.id]]);
  }

  // A price helper counts nothing, so it doubles nothing: the old leg is deleted and the helper uploaded
  const helper = row({ type: "spam", description: "no txid" });
  const old = legsOf(row({ type: "send", description: "no txid" }), {
    id: "old-file.csv:7",
    description: "",
    trade: "deposit",
    side: "incoming",
    timestamp: "2024-03-01T07:00:00.000Z",
  });
  const spam = plan({ rows: [helper], legs: old }).plan;
  assert.deepEqual([spam.report, spam.delete.length, spam.upload[0].ids], [[], 1, [helper.id]]);
});

test("an extra row a run row exports itself is left out, and its leg in Summ adopts to the run row", () => {
  const r = row();
  const extra = row({ id: "extra-file.csv:1", description: `Hand-made; ${TX1}`, extra: true });
  const legs = legsOf(extra);
  const { plan: p } = plan({ rows: [r, extra], legs });
  assert.deepEqual(p.superseded, [{ extra: extra.id, run: r.id }]);
  assert.deepEqual(p.adopted, [{ legId: legs[0].legId, id: r.id }]);
  assert.deepEqual([p.upload, p.delete, p.edit, p.report], [[], [], [], []]);

  // Neither in Summ yet: the run row is uploaded once
  assert.deepEqual(
    plan({ rows: [r, extra] }).plan.upload.map((u) => u.ids),
    [[r.id]],
  );
  // A run without the event keeps the extra row
  assert.deepEqual(
    plan({ rows: [extra] }).plan.upload.map((u) => u.ids),
    [[extra.id]],
  );
  // An extra row without a txid is never left out
  const bare = row({ id: "extra-file.csv:2", description: "Hand-made", txids: [], extra: true });
  assert.deepEqual(plan({ rows: [r, bare] }).plan.superseded, []);
});

test("an extra row sharing a txid and currency with a run row on its side, but not the same row, is reported and neither is uploaded", () => {
  const r = row();
  const other = row({
    id: "2024-03-01T10:00:00.000Z.in.bbbbbbbbbbbb",
    type: "receive",
    baseCurrency: "ETH",
    baseAmount: "0.1",
    description: `Received; ${TX1}`,
  });
  const extra = row({ id: "extra-file.csv:1", baseAmount: "1", description: `Hand-made; ${TX1}`, extra: true });
  const { plan: p } = plan({ rows: [r, other, extra] });
  assert.deepEqual(p.superseded, []);
  assert.deepEqual(
    p.report.map((e) => [e.kind, e.id]),
    [["extra-overlap", extra.id]],
  );
  // The run row of the same txid in another currency is not held back
  assert.deepEqual(
    p.upload.map((u) => u.ids),
    [[other.id]],
  );

  // Listed in keepExtra: no report, all uploaded
  const kept = plan({ rows: [r, other, extra], config: { ...CONFIG, keepExtra: [extra.id] } }).plan;
  assert.deepEqual([kept.report, kept.upload.flatMap((u) => u.ids)], [[], [r.id, other.id, extra.id]]);
  // One on the other side, or in another currency, adds to the run's rows: no report, all uploaded
  for (const over of [{ type: "receive" }, { baseCurrency: "BTC" }]) {
    const add = plan({
      rows: [r, row({ id: "extra-file.csv:1", description: `Hand-made; ${TX1}`, extra: true, ...over })],
    }).plan;
    assert.deepEqual([add.report, add.upload.flatMap((u) => u.ids).length], [[], 2]);
  }
});

test("an extra row in another wallet is not superseded; both in Summ, the extra row's legs are deleted", () => {
  const r = row();
  const elsewhere = row({ id: "extra-file.csv:1", from: "wallet-z", description: `Hand-made; ${TX1}`, extra: true });
  assert.deepEqual(plan({ rows: [r, elsewhere] }).plan.superseded, []);
  // Another label for the other side is the same row
  const relabelled = row({ id: "extra-file.csv:1", to: "other-label", description: `Hand-made; ${TX1}`, extra: true });
  assert.deepEqual(plan({ rows: [r, relabelled] }).plan.superseded, [{ extra: relabelled.id, run: r.id }]);

  // The run row and the extra row both already in Summ: the run row matches, the extra row's legs go
  const extra = row({ id: "extra-file.csv:1", description: `Hand-made; ${TX1}`, extra: true });
  const legs = [...legsOf(r), ...legsOf(extra, {}, "action2")];
  const { plan: p } = plan({ rows: [r, extra], legs });
  assert.deepEqual(
    p.delete.map((d) => [d.summId, d.legIds]),
    [[extra.id, [legs[1].legId]]],
  );
  assert.deepEqual([p.upload, p.adopted], [[], []]);
});

test("a leg adopted to an extra row, and its override, follow the run row that supersedes it", () => {
  const r = row();
  const extra = row({ id: "extra-file.csv:1", description: `Hand-made; ${TX1}`, extra: true });
  const legs = legsOf(extra, { id: "old-file.csv:3", trade: "outgoingGift" });
  const override: Override = {
    id: extra.id,
    leg: "base",
    field: "trade",
    run: "withdrawal",
    summ: "outgoingGift",
    seenAt: "",
    reason: "mine",
    retainUserEdit: "yes",
  };
  const { plan: p } = plan({
    rows: [r, extra],
    legs,
    adopted: new Map([[legs[0].legId, extra.id]]),
    overrides: [override],
  });
  assert.deepEqual(p.adopted, [{ legId: legs[0].legId, id: r.id }]);
  assert.deepEqual([p.edit, p.overridden.map((o) => o.kind)], [[], []]);
  assert.ok(renderPlan(p, "snap", "run").includes(`| ${extra.id} | ${r.id} |`));
});

test("a field the user changed in Summ is captured as an override and kept", () => {
  const r = row();
  const legs = legsOf(r, { trade: "outgoingGift" });
  const history = new Map([
    ["action1", ["1 Jan 2024 · import (original)", "2 Jan 2024 · user · Category: Send → Outgoing Gift"]],
  ]);
  const first = plan({ rows: [r], legs, history });
  assert.deepEqual(first.plan.edit, []);
  assert.deepEqual(
    first.plan.overridden.map((o) => [o.kind, o.override.field, o.override.run, o.override.summ]),
    [["captured", "trade", "withdrawal", "outgoingGift"]],
  );

  // Once kept (retainUserEdit: yes), listed again only when the run's value moves under it
  const overrides = first.overrides.map((o) => ({ ...o, retainUserEdit: "yes" as const }));
  assert.ok(empty(plan({ rows: [r], legs, history, overrides }).plan));
  const moved = plan({
    rows: [{ ...r, type: "receive" }],
    legs: legsOf(r, { side: "incoming", trade: "outgoingGift" }),
    history,
    overrides,
  });
  assert.deepEqual(
    moved.plan.overridden.map((o) => [o.kind, o.runNow]),
    [["run-changed", "deposit"]],
  );
  assert.deepEqual(moved.plan.edit, []);
});

test("an edit apply-log records is the sync's own, not drift", () => {
  const r = row();
  const legs = legsOf(r, { trade: "outgoingGift" });
  const history = new Map([["action1", ["2 Jan 2024 · user · Category: Send → Outgoing Gift"]]]);
  const { plan: p } = plan({
    rows: [r],
    legs,
    history,
    applyLog: [{ legId: legs[0].legId, field: "trade", value: "outgoingGift" }],
  });
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.field, c.desired]),
    [["trade", "withdrawal"]],
  );
  assert.deepEqual(p.overridden, []);
});

test("retainUserEdit: undecided keeps the user's value and lists it on every plan; yes keeps it quietly", () => {
  const r = row();
  const legs = legsOf(r, { trade: "outgoingGift" });
  const history = new Map([["action1", ["2 Jan 2024 · user · Category: Send → Outgoing Gift"]]]);
  const first = plan({ rows: [r], legs, history });
  assert.deepEqual(
    first.overrides.map((o) => o.retainUserEdit),
    ["undecided"],
  );
  const again = plan({ rows: [r], legs, history, overrides: first.overrides });
  assert.deepEqual(again.plan.edit, []);
  assert.deepEqual(
    again.plan.overridden.map((o) => o.kind),
    ["undecided"],
  );
  const kept = first.overrides.map((o) => ({ ...o, retainUserEdit: "yes" as const }));
  assert.ok(empty(plan({ rows: [r], legs, history, overrides: kept }).plan));
});

test("retainUserEdit: no plans the run's value back; a later value of the user's is a new edit", () => {
  const r = row();
  const legs = legsOf(r, { trade: "outgoingGift" });
  const history = new Map([["action1", ["2 Jan 2024 · user · Category: Send → Outgoing Gift"]]]);
  const overrides = plan({ rows: [r], legs, history }).overrides.map((o) => ({ ...o, retainUserEdit: "no" as const }));

  const reverted = plan({ rows: [r], legs, history, overrides });
  assert.deepEqual(
    reverted.plan.edit[0].changes.map((c) => [c.field, c.summ, c.desired]),
    [["trade", "outgoingGift", "withdrawal"]],
  );
  assert.deepEqual(reverted.plan.overridden, []);
  assert.deepEqual(reverted.overrides, overrides);

  // After the apply: Summ holds the run's value, so nothing is planned or captured, though the history still
  // shows the user's edit
  const after = plan({
    rows: [r],
    legs: legsOf(r),
    history,
    overrides,
    applyLog: [{ legId: legs[0].legId, field: "trade", value: "withdrawal" }],
  });
  assert.ok(empty(after.plan));

  // The user sets yet another value: not the one decided on, so it is captured as undecided, not set back
  const third = plan({ rows: [r], legs: legsOf(r, { trade: "lost" }), history, overrides });
  assert.deepEqual(third.plan.edit, []);
  assert.deepEqual(
    third.plan.overridden.map((o) => [o.kind, o.override.summ, o.override.retainUserEdit]),
    [["captured", "lost", "undecided"]],
  );
});

test("retainUserEdit: yes, then a new value of the user's, is captured as undecided", () => {
  const r = row();
  const history = new Map([["action1", ["2 Jan 2024 · user · Category: Send → Outgoing Gift"]]]);
  const overrides = plan({ rows: [r], legs: legsOf(r, { trade: "outgoingGift" }), history }).overrides.map((o) => ({
    ...o,
    retainUserEdit: "yes" as const,
  }));
  const moved = plan({ rows: [r], legs: legsOf(r, { trade: "lost" }), history, overrides });
  assert.deepEqual(
    moved.overrides.map((o) => [o.summ, o.retainUserEdit]),
    [["lost", "undecided"]],
  );
});

test("an override whose row left the run is listed as gone", () => {
  const override: Override = {
    id: "gone-id",
    leg: "base",
    field: "trade",
    run: "a",
    summ: "b",
    seenAt: "",
    reason: "",
    retainUserEdit: "undecided",
  };
  const { plan: p } = plan({ overrides: [override] });
  assert.deepEqual(
    p.overridden.map((o) => o.kind),
    ["gone"],
  );
});

function btcRow(over: Partial<Row> = {}): Row {
  return row({
    file: BTC_FILE,
    chain: "BTC",
    id: "2024-03-01T10:00:00.000Z.in.ffffffffffff",
    type: "send",
    baseCurrency: "BTC",
    baseAmount: "0.01",
    feeCurrency: "BTC",
    feeAmount: "0.0001",
    blockchain: "BTC",
    ...over,
  });
}

function ownLeg(over: Partial<Leg> = {}): Leg {
  return {
    legId: legId(),
    actionId: "l1",
    side: "outgoing",
    id: TX1,
    trade: "withdrawal",
    currency: "BTC",
    quantity: 0.0101,
    timestamp: "2024-03-01T10:00:00.000Z",
    from: "",
    to: "",
    blockchain: "btc",
    description: "",
    source: "btc-wallet",
    importType: "wallet",
    comments: [],
    ...over,
  };
}

test("a row no import of its chain can hold (LP token, price helper, kept refund) is managed on an L1 file: uploaded, then matched by ID", () => {
  const lp = btcRow({
    id: "2024-03-01T10:00:00.000Z.in.111111111111",
    type: "receive-lp-token",
    baseCurrency: "ThorLP.BTC.BTC",
    baseAmount: "2",
    feeCurrency: "",
    feeAmount: "",
  });
  const lost = btcRow({
    id: "2024-03-01T10:00:00.000Z.unreturned.222222222222",
    type: "lost",
    feeCurrency: "",
    feeAmount: "",
  });
  const add = btcRow({ type: "add-liquidity" });
  const before = plan({ rows: [lp, lost, add], legs: [ownLeg()] }).plan;
  assert.deepEqual(before.upload, [{ file: BTC_FILE, filed: false, ids: [lp.id, lost.id] }]);
  assert.deepEqual(
    before.report.filter((r) => r.id === lp.id || r.id === lost.id),
    [],
  );
  assert.equal(before.categorise.length, 1);
  assert.match(
    renderPlan(before, "snap", "run"),
    new RegExp(`${BTC_FILE}: 2 rows \\(into the THORChain or Maya account, not the BTC wallet`),
  );
  // uploaded under a managed source: matched by ID, nothing planned for them (Summ lowercases an L1 address)
  const held = [
    ...legsOf(lp, { blockchain: "btc" }),
    ...legsOf(lost, { blockchain: "btc", from: lost.from.toLowerCase() }, "action2"),
  ];
  const after = plan({ rows: [lp, lost], legs: held }).plan;
  assert.deepEqual([after.upload, after.delete, after.edit, after.report], [[], [], [], []]);
  assert.deepEqual(categorisedTxids([lp, lost, add], CONFIG), new Set(add.txids));

  // On THORChain, when the user leaves it to Summ's import, these types are on chain: not uploaded
  const thor = row({ id: "2024-03-01T10:00:00.000Z.out.444444444444", type: "fee", description: `Fee; ${TX2}` });
  const left = plan({ rows: [thor], config: { ...CONFIG, managedChains: ["MAYA"] } }).plan;
  assert.deepEqual(left.upload, []);
  assert.deepEqual(
    left.report.map((r) => r.id),
    [thor.id],
  );
});

test("a return whose withdraw request paid L1 gas is managed without its fee: Summ's import of the wallet holds the gas", () => {
  const header = "Timestamp (UTC),Type,Fee Currency (Optional),Fee Amount (Optional),ID (Optional)";
  const files = FILES.map((f) => (f.name === BTC_FILE ? { ...f, header } : f));
  const id = "2024-03-01T10:00:00.000Z.out.333333333333";
  const paid = {
    ...btcRow({ id, type: "return-lp-token", baseCurrency: "ThorLP.BTC.BTC", baseAmount: "2" }),
    line: `2024-03-01T10:00:00.000Z,return-lp-token,BTC,0.0001,${id}`,
  };
  // Summ's import holds the request (a dust send and its gas); the token return is not in it
  const request = [
    ownLeg({ trade: "expense", quantity: 0.00001 }),
    ownLeg({ side: "fees", trade: "fee", quantity: 0.0001 }),
  ];
  const { plan: up, rows } = plan({ rows: [paid], legs: request, files });
  assert.deepEqual([up.upload, up.report, up.categorise], [[{ file: BTC_FILE, filed: false, ids: [id] }], [], []]);
  assert.equal(uploadFiles(up, files, rows)[0].text, `${header}\n2024-03-01T10:00:00.000Z,return-lp-token,,,${id}\n`);
  // uploaded: matched by ID with no fee leg, nothing planned
  const unpaid = { ...paid, feeCurrency: "", feeAmount: "" };
  const after = plan({
    rows: [paid],
    legs: [...request, ...legsOf(unpaid, { blockchain: "btc" }, "action2")],
    files,
  }).plan;
  assert.deepEqual([after.upload, after.delete, after.edit, after.report], [[], [], [], []]); // the snapshot fetches the request's action
  assert.deepEqual(categorisedTxids([paid], CONFIG), new Set(paid.txids));

  // Summ's imports hold no leg of the request: the gas left out counts nowhere, reported
  const missing = plan({ rows: [paid], files }).plan;
  assert.deepEqual(
    [missing.upload.map((u) => u.ids), missing.report.map((e) => [e.kind, e.id])],
    [[[id]], [["fee", id]]],
  );
  assert.match(
    missing.report[0].detail,
    /fee of 0\.0001 BTC is its request's gas, uploaded without it, but no leg of Summ's imports has its txid in BTC/,
  );
  // Summ lists the request but the snapshot lacks its detail
  assert.deepEqual(
    plan({ rows: [paid], files, txHashes: new Set(paid.txids) }).plan.report.map((e) => e.kind),
    ["not-in-snapshot"],
  );

  // only the fee columns change, whatever the other fields hold
  const quoted =
    "Timestamp (UTC),Type,Description (Optional),Fee Currency (Optional),Fee Amount (Optional),ID (Optional)";
  const described = {
    ...paid,
    line: `2024-03-01T10:00:00.000Z,return-lp-token,"Return, ""LP""; ${TX1}",BTC,0.0001,${id}`,
  };
  const withDescription = FILES.map((f) => (f.name === BTC_FILE ? { ...f, header: quoted } : f));
  const out = plan({ rows: [described], legs: request, files: withDescription });
  assert.equal(
    uploadFiles(out.plan, withDescription, out.rows)[0].text,
    `${quoted}\n2024-03-01T10:00:00.000Z,return-lp-token,"Return, ""LP""; ${TX1}",,,${id}\n`,
  );
});

test("a categorised row with no leg of its amount takes the one leg with its txid, side and currency, and reports the difference", () => {
  const r = btcRow({ type: "bridge-trade-out" });
  const gross = ownLeg({ quantity: 0.01017 });
  const { plan: p } = plan({ rows: [r], legs: [gross] });
  assert.deepEqual(
    p.categorise.map((c) => [c.id, c.changes.map((x) => [x.field, x.desired])]),
    [[r.id, [["trade", "bridgeTradeOut"]]]],
  );
  const fee = p.report.find((x) => x.kind === "fee" && x.id === r.id);
  assert.match(
    fee?.detail ?? "",
    /matched by txid: Summ's leg holds 0\.01017 BTC, \+0\.00007 beyond the row's 0\.01 plus its fee 0\.0001/,
  );
  assert.deepEqual(
    p.report.filter((x) => x.kind === "no-leg"),
    [],
  );

  // a leg another row has exactly is not taken by a looser fit
  const exact = btcRow({
    id: "2024-03-01T10:00:00.000Z.in.eeeeeeeeeeee",
    type: "bridge-trade-out",
    baseAmount: "0.01017",
    feeAmount: "",
    feeCurrency: "",
  });
  const both = plan({ rows: [r, exact], legs: [ownLeg({ quantity: 0.01017 })] }).plan;
  assert.deepEqual(
    both.categorise.map((c) => c.id),
    [exact.id],
  );
  assert.deepEqual(
    both.report.filter((x) => x.kind === "no-leg").map((x) => x.id),
    [r.id],
  );

  // two rows that both fit the one leg only loosely: neither takes it
  const other = btcRow({
    id: "2024-03-01T10:00:00.000Z.out.dddddddddddd",
    type: "failed-out",
    baseAmount: "0.00002",
    feeAmount: "",
    feeCurrency: "",
  });
  const rivals = plan({ rows: [r, other], legs: [ownLeg({ quantity: 0.01017 })] }).plan;
  assert.deepEqual(rivals.categorise, []);
  assert.deepEqual(
    rivals.report
      .filter((x) => x.kind === "no-leg")
      .map((x) => x.id)
      .sort(),
    [r.id, other.id].sort(),
  );

  // a gas the user split off and ignored is not the row's leg
  const split = plan({
    rows: [r],
    legs: [ownLeg({ quantity: 0.0096 }), ownLeg({ quantity: 0.0005, trade: "ignoreOut", actionId: "l2" })],
  }).plan;
  assert.deepEqual(
    split.categorise.map((c) => c.actionId),
    ["l1"],
  );
  // but not when the legs do not add up to the row: the ignored one may be the row's, ignored on purpose
  const apart = plan({
    rows: [r],
    legs: [ownLeg({ quantity: 0.02 }), ownLeg({ quantity: 0.007, trade: "ignoreOut", actionId: "l2" })],
  }).plan;
  assert.deepEqual([apart.categorise, apart.report.map((x) => x.kind)], [[], ["no-leg"]]);

  // two legs with the txid, side and currency, neither of the row's amount: not guessed
  const two = plan({ rows: [r], legs: [ownLeg({ quantity: 0.02 }), ownLeg({ quantity: 0.03, actionId: "l2" })] }).plan;
  assert.deepEqual([two.categorise, two.report.map((x) => x.kind)], [[], ["no-leg"]]);
});

test("a categorised row sets the type of Summ's own leg with its txid, currency and gross amount; a fee that differs is reported, not edited", () => {
  const r = btcRow({ type: "bridge-trade-out" });
  const leg = ownLeg();
  const fee = ownLeg({ side: "fees", trade: "fee", quantity: 0.0002 });
  const { plan: p } = plan({ rows: [r], legs: [leg, fee] });
  assert.equal(p.categorise.length, 1);
  assert.deepEqual(
    p.categorise[0].changes.map((c) => [c.leg, c.field, c.desired]),
    [["base", "trade", "bridgeTradeOut"]],
  );
  assert.deepEqual(
    p.report.map((x) => [x.kind, x.legIds, x.detail]),
    [["fee", [fee.legId], "Summ's import holds a fee of 0.0002 BTC, the row 0.0001; the fee is not edited"]],
  );
  assert.equal(p.upload.length, 0);
  // the same fee: nothing reported
  assert.deepEqual(
    plan({ rows: [r], legs: [ownLeg(), ownLeg({ side: "fees", trade: "fee", quantity: 0.0001 })] }).plan.report,
    [],
  );
});

test("the receive Summ made up to pair a categorised send as a transfer is ignored, never matched", () => {
  const made = (over: Partial<Leg> = {}) =>
    ownLeg({
      side: "incoming",
      trade: "deposit",
      quantity: 0.0101,
      source: "manual",
      importType: "soft-transfer",
      to: "THORChain",
      ...over,
    });
  const fee = () => ownLeg({ side: "fees", trade: "fee", quantity: 0.0001 });
  // in the send's action, before the send is categorised
  const soft = made();
  const before = plan({ rows: [btcRow({ type: "bridge-trade-out" })], legs: [ownLeg(), fee(), soft] }).plan;
  assert.deepEqual(
    before.categorise.map((e) => [e.changes.map((c) => c.desired), e.ignore]),
    [[["bridgeTradeOut"], [soft.legId]]],
  );
  // left on its own after the send was categorised: ignored without an edit
  const alone = made({ actionId: "l2" });
  const after = plan({
    rows: [btcRow({ type: "bridge-trade-out" })],
    legs: [ownLeg({ trade: "bridgeTradeOut" }), fee(), alone],
  }).plan;
  assert.deepEqual(
    after.categorise.map((e) => [e.changes, e.ignore]),
    [[[], [alone.legId]]],
  );
  // already ignored, or the row is a plain send (Summ's transfer is right): nothing to do
  assert.deepEqual(
    plan({
      rows: [btcRow({ type: "bridge-trade-out" })],
      legs: [ownLeg({ trade: "bridgeTradeOut" }), fee(), made({ trade: "ignoreIn" })],
    }).plan.categorise,
    [],
  );
  assert.deepEqual(plan({ rows: [btcRow()], legs: [ownLeg(), fee(), made()] }).plan.categorise, []);
  // a categorised receive is never matched to a made-up leg of the same amount
  const receive = btcRow({ type: "bridge-trade-in", feeCurrency: "", feeAmount: "" });
  const own = ownLeg({ side: "incoming", trade: "deposit", quantity: 0.01 });
  const p = plan({ rows: [receive], legs: [own, made({ quantity: 0.01 })] }).plan;
  assert.deepEqual([p.report, p.categorise.map((e) => e.changes[0].legId)], [[], [own.legId]]);
});

test("the send Summ made up to pair a categorised receive as a transfer is ignored", () => {
  const receive = btcRow({ type: "bridge-trade-in", feeCurrency: "", feeAmount: "" });
  const own = ownLeg({ side: "incoming", trade: "deposit", quantity: 0.01 });
  const made = ownLeg({
    side: "outgoing",
    trade: "withdrawal",
    quantity: 0.01,
    source: "manual",
    importType: "soft-transfer",
    from: "THORChain",
  });
  const p = plan({ rows: [receive], legs: [own, made] }).plan;
  assert.deepEqual(
    p.categorise.map((e) => [e.changes.map((c) => [c.legId, c.desired]), e.ignore]),
    [[[[own.legId, "bridgeTradeIn"]], [made.legId]]],
  );
  assert.deepEqual(p.report, []);
});

test("a categorised row with no or several fitting legs is reported, never guessed", () => {
  const r = btcRow();
  const none = plan({ rows: [r], legs: [ownLeg({ id: TX2 })] }).plan;
  assert.deepEqual(
    none.report.map((e) => e.kind),
    ["no-leg"],
  );
  // a payout row's report names every txid, so the one Summ's import lists can be searched for
  const payout = btcRow({ type: "bridge-trade-in", feeCurrency: "", feeAmount: "", txids: [TX1, TX2] });
  assert.deepEqual(
    plan({ rows: [payout], legs: [] }).plan.report.map((e) => e.txids),
    [[TX1, TX2]],
  );
  const unfetched = plan({ rows: [r], legs: [], txHashes: new Set([TX1]) }).plan;
  assert.deepEqual(
    unfetched.report.map((e) => e.kind),
    ["not-in-snapshot"],
  );
  const several = plan({ rows: [r], legs: [ownLeg(), ownLeg({ quantity: 0.0101, actionId: "l2" })] }).plan;
  assert.deepEqual(
    several.report.map((e) => e.kind),
    ["several-legs"],
  );
  assert.deepEqual(several.categorise, []);
});

test("a tx Summ holds twice, once with a fee leg and once gross: the leg with the row's amount and fee is the row's, the other reported", () => {
  const r = btcRow({ type: "bridge-trade-out" });
  const net = ownLeg({ quantity: 0.01 });
  const fee = ownLeg({ side: "fees", trade: "fee", quantity: 0.0001 });
  const gross = ownLeg({ quantity: 0.0101, trade: "out", actionId: "l2" });
  const p = plan({ rows: [r], legs: [net, fee, gross] }).plan;
  assert.deepEqual(
    p.categorise.map((c) => c.changes.map((x) => x.legId)),
    [[net.legId]],
  );
  assert.deepEqual(
    p.report.map((e) => [e.kind, e.legIds]),
    [["duplicate-leg", [gross.legId]]],
  );
  // the gross leg alone, with no fee leg: the row's fee in Summ's shape, nothing reported
  const alone = plan({ rows: [r], legs: [ownLeg({ quantity: 0.0101 })] }).plan;
  assert.deepEqual([alone.categorise.length, alone.report], [1, []]);
  // the user ignored the other leg: nothing reported
  const ignored = plan({ rows: [r], legs: [net, fee, { ...gross, trade: "ignoreOut" }] }).plan;
  assert.deepEqual([ignored.categorise.map((c) => c.changes[0].legId), ignored.report], [[net.legId], []]); // the other leg is another row's exactly (a second send of the gross amount in the tx): not a duplicate
  const second = btcRow({
    id: "2024-03-01T10:00:00.000Z.out.cccccccccccc",
    type: "bridge-trade-out",
    baseAmount: "0.0101",
    feeCurrency: "",
    feeAmount: "",
  });
  const both = plan({ rows: [r, second], legs: [net, fee, gross] }).plan;
  assert.deepEqual(
    both.categorise.map((c) => [c.id, c.actionId]),
    [
      [r.id, "l1"],
      [second.id, "l2"],
    ],
  );
  assert.deepEqual(
    both.report.filter((e) => e.kind === "duplicate-leg"),
    [],
  );
});

test("a leg of the amount alone, with no fee leg, does not hold the row's fee: reported", () => {
  const r = btcRow({ type: "bridge-trade-out" });
  const p = plan({ rows: [r], legs: [ownLeg({ quantity: 0.01 })] }).plan;
  assert.equal(p.categorise.length, 1);
  assert.deepEqual(
    p.report.map((e) => [e.kind, e.detail]),
    [["fee", "the row has a fee of 0.0001 BTC; Summ has 0 fee legs"]],
  );
  // a fee within the amount's tolerance cannot be told from no fee: still reported, not taken as held in the amount
  const large = btcRow({ type: "bridge-trade-out", baseAmount: "2000000", feeAmount: "0.01" });
  const q = plan({ rows: [large], legs: [ownLeg({ quantity: 2000000 })] }).plan;
  assert.deepEqual(
    q.report.map((e) => [e.kind, e.detail]),
    [["fee", "the row has a fee of 0.01 BTC; Summ has 0 fee legs"]],
  );
});

test("a fee Summ keeps on the leg itself, with no fee leg, is the row's fee: compared like a fee leg", () => {
  const r = btcRow({ type: "bridge-trade-out" });
  const p = plan({ rows: [r], legs: [ownLeg({ quantity: 0.01, feeQuantity: 0.0001, feeCurrency: "BTC" })] }).plan;
  assert.deepEqual([p.categorise.length, p.report], [1, []]);
  const other = plan({ rows: [r], legs: [ownLeg({ quantity: 0.01, feeQuantity: 0.0002, feeCurrency: "BTC" })] }).plan;
  assert.deepEqual(
    other.report.map((e) => [e.kind, e.detail]),
    [["fee", "Summ's import holds a fee of 0.0002 BTC on the leg, the row 0.0001; the fee is not edited"]],
  );
  // in another currency it is not the row's fee
  const eth = plan({ rows: [r], legs: [ownLeg({ quantity: 0.01, feeQuantity: 0.0001, feeCurrency: "ETH" })] }).plan;
  assert.deepEqual(
    eth.report.map((e) => e.detail),
    ["the row has a fee of 0.0001 BTC; Summ has 0 fee legs"],
  );
  // of a tx Summ holds twice, the leg with the amount and its fee on the leg is the row's
  const gross = ownLeg({ quantity: 0.0101, trade: "out", actionId: "l2" });
  const net = ownLeg({ quantity: 0.01, feeQuantity: 0.0001, feeCurrency: "BTC" });
  const twice = plan({ rows: [r], legs: [net, gross] }).plan;
  assert.deepEqual(
    twice.categorise.map((c) => c.actionId),
    ["l1"],
  );
  assert.deepEqual(
    twice.report.map((e) => [e.kind, e.legIds, /a fee on the leg/.test(e.detail)]),
    [["duplicate-leg", [gross.legId], true]],
  );
  // a leg with a fee leg ranks before one with the fee on the leg
  const withFeeLeg = ownLeg({ quantity: 0.01, actionId: "l3" });
  const feeLeg = ownLeg({ side: "fees", trade: "fee", quantity: 0.0001, actionId: "l3" });
  const both = plan({ rows: [r], legs: [net, withFeeLeg, feeLeg] }).plan;
  assert.deepEqual(
    both.categorise.map((c) => c.actionId),
    ["l3"],
  );
  // a token sent with its fee in another currency on the leg: compared, nothing reported
  const token = btcRow({
    type: "bridge-trade-out",
    baseCurrency: "BUSD",
    baseAmount: "100",
    feeCurrency: "BNB",
    feeAmount: "0.000075",
  });
  const busd = plan({
    rows: [token],
    legs: [ownLeg({ currency: "BUSD", quantity: 100, feeQuantity: 0.000075, feeCurrency: "BNB" })],
  }).plan;
  assert.deepEqual([busd.categorise.length, busd.report], [1, []]);
  // the row has no fee: a fee on the leg is reported, as a fee leg is
  const noFee = btcRow({ type: "bridge-trade-out", feeCurrency: "", feeAmount: "" });
  const extra = plan({
    rows: [noFee],
    legs: [ownLeg({ quantity: 0.01, feeQuantity: 0.0001, feeCurrency: "BTC" })],
  }).plan;
  assert.deepEqual(
    extra.report.map((e) => e.detail),
    ["the row has no fee; Summ has a fee on the leg"],
  );
});

test("a manual entry naming a row's txid is reported", () => {
  const r = row();
  const manual = ownLeg({ importType: "manual", source: "manual", id: "x-manual", comments: [`see ${TX1}`] });
  const { plan: p } = plan({ rows: [r], legs: [...legsOf(r), manual] });
  assert.deepEqual(
    p.report.map((e) => [e.kind, e.id]),
    [["manual-entry", r.id]],
  );
});

test("a row held in summ-sync.json gets nothing planned and is listed under held", () => {
  const edited = row({ id: "2024-03-01T10:00:00.000Z.out.111111111111" });
  const missing = row({
    id: "2024-03-01T10:00:00.000Z.in.222222222222",
    type: "receive",
    txids: [TX2],
    description: `Received; ${TX2}`,
  });
  const clean = row({ id: "2024-03-01T10:00:00.000Z.out.333333333333", txids: [], description: "Sent" });
  const hold = [edited, missing, clean].map((r) => ({ id: r.id, reason: "pending a decision" }));
  const legs = [...legsOf(edited, { to: "wallet-c" }), ...legsOf(clean, {}, "action2")];
  const free = plan({ rows: [edited, missing, clean], legs }).plan;
  assert.deepEqual([free.edit.length, free.upload.length], [1, 1]);
  const { plan: p } = plan({
    rows: [edited, missing, clean],
    legs,
    config: { ...CONFIG, hold: [...hold, { id: "2024-03-02T10:00:00.000Z.out.444444444444", reason: "gone" }] },
  });
  assert.deepEqual([p.edit, p.upload, p.counts.uploads], [[], [], 0]);
  assert.deepEqual(
    p.held.map((h) => [h.kind, h.id, h.held.map((x) => x.split(" ")[0])]),
    [
      ["hold", edited.id, ["edit"]],
      ["hold", missing.id, ["upload"]],
      ["hold", clean.id, []],
    ],
  );
  assert.deepEqual(p.notes, ["hold: no row 2024-03-02T10:00:00.000Z.out.444444444444 in the run"]);
  // a held row that left the run: its legs are not deleted
  const gone = plan({ rows: [], legs: legsOf(edited), config: { ...CONFIG, hold } }).plan;
  assert.deepEqual(
    [gone.delete, gone.held.map((h) => [h.kind, h.id, h.summId, h.held])],
    [[], [["hold", null, edited.id, ["delete (no row in the run)"]]]],
  );
  assert.match(
    renderPlan(p, "snap", "run"),
    /## Held .*\(3\)[\s\S]*\| hold \| 2024-03-01T10:00:00.000Z.out.333333333333 \| pending a decision \| nothing to do \|/,
  );
});

test("a hold may name a txid: every row naming it is held, and legs naming it with no row are not deleted", () => {
  const send = row({ id: "2024-03-01T10:00:00.000Z.out.111111111111", type: "send" });
  const back = row({
    id: "2024-03-01T10:05:00.000Z.in.222222222222",
    type: "receive",
    timestamp: "2024-03-01T10:05:00.000Z",
  });
  const other = row({ id: "2024-03-01T10:00:00.000Z.out.333333333333", txids: [TX2], description: `Sent; ${TX2}` });
  const hold = [{ txid: TX1.toUpperCase(), reason: "pending a decision" }];
  const { plan: p } = plan({ rows: [send, back, other], config: { ...CONFIG, hold } });
  assert.deepEqual(
    p.upload.map((u) => u.ids),
    [[other.id]],
  );
  assert.deepEqual(
    p.held.map((h) => [h.kind, h.id, h.reason, h.held.map((x) => x.split(" ")[0])]),
    [
      ["hold", send.id, "pending a decision", ["upload"]],
      ["hold", back.id, "pending a decision", ["upload"]],
    ],
  );
  const gone = plan({ rows: [], legs: legsOf(send), config: { ...CONFIG, hold } }).plan;
  assert.deepEqual(
    [gone.delete, gone.held.map((h) => [h.kind, h.id, h.summId, h.held])],
    [[], [["hold", null, send.id, ["delete (no row in the run)"]]]],
  );
  assert.deepEqual(gone.notes, [`hold: no row with txid ${TX1} in the run`]);
});

test("a scope file: one entry per line, comments and blank lines left out", () => {
  assert.throws(() => parseScope("0".repeat(64)), /placeholder txid/);
  assert.deepEqual(parseScope("a\na # again\n"), ["a"]);
  assert.deepEqual(parseScope("Pool#3 # a comment\n#all of it\n"), ["Pool#3"]);
  assert.deepEqual(parseScope(`# savers stage\nExSavers.\n\n${TX1}  # the claim\n  row-1\n`), [
    "ExSavers.",
    TX1,
    "row-1",
  ]);
});

test("a scoped plan (plan --only) plans only for the rows its entries match: by ID, txid or text in the line", () => {
  // Rows have no txid unless one is given, so a txid entry matches only the rows naming it
  const own = (over: Partial<Row>, line: string) => ({ ...row({ txids: [], description: "x", ...over }), line });
  const saver = own({ id: "2024-03-01T10:00:00.000Z.in.111111111111", type: "receive" }, "receive,ExSavers.BTC");
  const missing = own({ id: "2024-03-01T10:00:00.000Z.in.222222222222", type: "receive" }, "receive,RUNE");
  const decided = own({ id: "2024-03-01T10:00:00.000Z.out.333333333333" }, "send,RUNE");
  const decidedOut = own({ id: "2024-03-01T10:00:00.000Z.out.444444444444" }, "send,RUNE");
  const drifted = own({ id: "2024-03-01T10:00:00.000Z.out.555555555555" }, "send,RUNE");
  const bridged = btcRow({ type: "bridge-trade-out" });
  const legs = [
    ...legsOf(decided, { trade: "outgoingGift" }, "a3"),
    ...legsOf(decidedOut, { trade: "outgoingGift" }, "a4"),
    ...legsOf(drifted, { trade: "outgoingGift" }, "a5"),
    ownLeg(),
    ...legsOf(row({ id: "2024-03-02T10:00:00.000Z.out.666666666666" }), {}, "a6"),
    ...legsOf(row({ id: "2024-03-02T10:00:00.000Z.out.777777777777", txids: [], description: "y" }), {}, "a7"),
  ];
  const history = new Map([["a5", ["2 Jan 2024 · user · Category: Send → Outgoing Gift"]]]);
  // Both decided against (no): the full plan sets both back; a scoped one only the row in scope
  const overrides: Override[] = [decided, decidedOut].map((r) => ({
    id: r.id,
    leg: "base",
    field: "trade",
    run: "withdrawal",
    summ: "outgoingGift",
    seenAt: "",
    reason: "",
    retainUserEdit: "no",
  }));
  const input = { rows: [saver, missing, decided, decidedOut, drifted, bridged], legs, history, overrides };
  const full = plan(input).plan;
  assert.deepEqual(
    [
      full.upload.flatMap((u) => u.ids),
      full.edit.map((e) => e.id),
      full.categorise.length,
      full.delete.length,
      full.overridden.length,
    ],
    [[saver.id, missing.id], [decided.id, decidedOut.id], 1, 2, 1],
  );

  // TX1 matches the categorised row and the legs of a gone row naming it; a gone row also matches by its ID
  const scope = ["ExSavers.", decided.id, TX1.toUpperCase(), "2024-03-02T10:00:00.000Z.out.777777777777", "Nothing"];
  const { plan: p } = plan({ ...input, scope });
  assert.deepEqual(
    [
      p.upload.flatMap((u) => u.ids),
      p.edit.map((e) => e.id),
      p.categorise.map((e) => e.id),
      p.delete.map((d) => d.summId),
      p.overridden,
    ],
    [
      [saver.id],
      [decided.id],
      [bridged.id],
      ["2024-03-02T10:00:00.000Z.out.666666666666", "2024-03-02T10:00:00.000Z.out.777777777777"],
      [],
    ],
  );
  assert.deepEqual(p.notes, ["scope: Nothing matches nothing in the run or Summ's legs with no row"]);
  assert.equal(p.counts.scopedRows, 3);
  assert.match(renderPlan(p, "snap", "run"), /- Scope \(plan --only\): .*`ExSavers\.`/);
  assert.doesNotMatch(renderPlan(full, "snap", "run"), /- Scope/);
});

test("a scoped plan lists held entries and adopts legs of the rows in scope only", () => {
  const a = row({ id: "2024-03-01T10:00:00.000Z.out.111111111111", txids: [], description: "a" });
  const b = row({ id: "2024-03-01T10:00:00.000Z.out.222222222222", txids: [], description: "b", baseAmount: "2" });
  const old = (r: Row, n: string) => legsOf(r, { id: `old.csv:${n}`, description: "" }, `old${n}`);
  const hold = [
    { id: a.id, reason: "pending" },
    { id: b.id, reason: "pending" },
  ];
  const held = plan({ rows: [a, b], config: { ...CONFIG, hold }, scope: [a.id] }).plan;
  assert.deepEqual(
    held.held.map((h) => h.id),
    [a.id],
  );
  assert.equal(plan({ rows: [a, b], config: { ...CONFIG, hold } }).plan.held.length, 2);
  const legs = [...old(a, "1"), ...old(b, "2")];
  assert.deepEqual(
    plan({ rows: [a, b], legs }).plan.adopted.map((x) => x.id),
    [a.id, b.id],
  );
  const adopted = plan({ rows: [a, b], legs, scope: [a.id] }).plan;
  assert.deepEqual(
    adopted.adopted.map((x) => x.id),
    [a.id],
  );
});

test("a scoped plan keeps a categorise back while its event has an upload outside the scope", () => {
  const swap = row({ id: "2024-03-01T10:00:00.000Z.in.111111111111", type: "receive" });
  const bridged = btcRow({ type: "bridge-trade-out" });
  const input = { rows: [swap, bridged], legs: [ownLeg()] };
  const { plan: p } = plan({ ...input, scope: [bridged.id] });
  assert.deepEqual([p.categorise, p.upload], [[], []]);
  assert.deepEqual(p.notes, [
    `scope: categorise of ${bridged.id} waits for the upload of ${swap.id}, not in this plan`,
  ]);
  const both = plan({ ...input, scope: [bridged.id, swap.id] }).plan;
  assert.deepEqual(
    [both.categorise.map((e) => e.id), both.upload.flatMap((u) => u.ids), both.notes],
    [[bridged.id], [swap.id], []],
  );
});

test("a scoped plan deletes legs with no row that name a txid of a row in scope: the same tx", () => {
  const TX3 = "3".repeat(64);
  const ZERO = "0".repeat(64);
  const r = row({ id: "2024-03-01T10:00:00.000Z.out.111111111111", txids: [TX1, ZERO], description: `${TX1} ${ZERO}` });
  const outside = row({
    id: "2024-03-01T10:00:00.000Z.in.999999999999",
    type: "receive",
    txids: [TX3],
    description: TX3,
  });
  const gone = (n: string, description: string) =>
    legsOf(row({ id: `2024-03-01T10:00:00.000Z.out.${n.repeat(12)}`, description }), {}, `a${n}`);
  const legs = [
    ...gone("2", `Sent; ${TX1}`),
    ...gone("3", `Sent; ${TX2}`),
    // a placeholder txid links nothing
    ...gone("4", `Sent; ${ZERO}`),
  ];
  const { plan: p } = plan({ rows: [r, outside], legs, scope: [r.id] });
  assert.deepEqual(
    [p.delete.map((d) => d.summId), p.upload.flatMap((u) => u.ids), p.notes],
    [["2024-03-01T10:00:00.000Z.out.222222222222"], [r.id], []],
  );

  // Legs that also name the tx of a row outside the scope that the full plan uploads are left, matched by a txid of
  // the scope, by text or by a txid entry; the scope's rows and other legs of that tx wait with them: the tx stays as
  // it is, no side dropped or doubled
  const both = gone("5", `Swapped; ${TX1} ${TX3}`);
  for (const scope of [[r.id], [r.id, "Swapped"], [TX1]]) {
    const left = plan({ rows: [r, outside], legs: [...legs, ...both], scope }).plan;
    assert.deepEqual(
      [left.delete, left.upload, left.notes],
      [
        [],
        [],
        [
          `scope: legs 2024-03-01T10:00:00.000Z.out.555555555555 are not deleted: they also name the tx of ${outside.id}, outside the scope (add it to the scope)`,
          `scope: ${r.id}, 2024-03-01T10:00:00.000Z.out.222222222222 wait with the legs of their tx left above`,
        ],
      ],
    );
  }
  // A row outside the scope that Summ already holds loses nothing: the legs go
  const held = plan({ rows: [r, outside], legs: [...legs, ...both, ...legsOf(outside, {}, "a9")], scope: [r.id] });
  assert.deepEqual(
    held.plan.delete.map((d) => d.summId),
    ["2024-03-01T10:00:00.000Z.out.222222222222", "2024-03-01T10:00:00.000Z.out.555555555555"],
  );
  // An entry naming legs by their ID in Summ takes them though their tx waits
  const named2 = plan({
    rows: [r, outside],
    legs: [...legs, ...both],
    scope: [r.id, "2024-03-01T10:00:00.000Z.out.222222222222"],
  });
  assert.deepEqual(
    [named2.plan.delete.map((d) => d.summId), named2.plan.upload, named2.plan.notes.at(-1)],
    [
      ["2024-03-01T10:00:00.000Z.out.222222222222"],
      [],
      "scope: legs 2024-03-01T10:00:00.000Z.out.222222222222 are deleted as named, though their tx waits",
    ],
  );
  // Every tx of a waiting row waits: its stale legs of another tx are not deleted either
  const r2 = { ...r, txids: [TX1, TX2], description: `${TX1} ${TX2}` };
  const chained = plan({ rows: [r2, outside], legs: [...both, ...gone("6", `Sent; ${TX2}`)], scope: [r.id] }).plan;
  assert.deepEqual([chained.delete, chained.upload], [[], []]);
  // and every tx of a waiting leg: a row of the scope naming only that tx waits too
  const r3 = row({ id: "2024-03-01T10:00:00.000Z.out.cccccccccccc", txids: [TX2], description: TX2 });
  const viaLeg = plan({
    rows: [r, r3, outside],
    legs: [...both, ...gone("6", `Sent; ${TX1} ${TX2}`)],
    scope: [r.id, r3.id],
  });
  assert.deepEqual([viaLeg.plan.delete, viaLeg.plan.upload], [[], []]);
  // A remake (delete and upload of a row in scope) waits whole
  const remade = plan({
    rows: [r, outside],
    legs: [...legsOf({ ...r, description: "old" }, {}, "a8"), ...both],
    scope: [r.id],
  }).plan;
  assert.deepEqual([remade.delete, remade.upload], [[], []]);
  const remake = plan({ rows: [r, outside], legs: [...legsOf({ ...r, description: "old" }, {}, "a8"), ...both] }).plan;
  assert.deepEqual(
    [remake.delete.map((d) => d.id), remake.upload.flatMap((u) => u.ids)],
    [
      [null, r.id],
      [r.id, outside.id],
    ],
  );
  // Text matching only legs that are left or wait is not "nothing"
  for (const [scope, extra] of [
    [["Swapped"], []],
    [[r.id, "Zork"], gone("7", `Zork; ${TX1}`)],
  ] as const)
    assert.deepEqual(
      plan({ rows: [r, outside], legs: [...both, ...extra], scope: [...scope] }).plan.notes.filter((n) =>
        n.includes("matches nothing"),
      ),
      [],
    );
  // Only the legs' own ID in Summ takes them whatever they name, noted when a row of their tx is not uploaded
  assert.deepEqual(
    plan({ rows: [r, outside], legs: both, scope: ["2024-03-01T10:00:00.000Z.out.555555555555"] }).plan.notes,
    [
      `scope: legs 2024-03-01T10:00:00.000Z.out.555555555555 are deleted as named, though ${r.id}, ${outside.id} of their tx, outside the scope, are not uploaded by this plan`,
    ],
  );
  const named = plan({ rows: [r, outside], legs: both, scope: [r.id, "2024-03-01T10:00:00.000Z.out.555555555555"] });
  assert.deepEqual(
    [named.plan.delete.map((d) => d.summId), named.plan.upload.flatMap((u) => u.ids), named.plan.notes],
    [
      ["2024-03-01T10:00:00.000Z.out.555555555555"],
      [r.id],
      [
        `scope: legs 2024-03-01T10:00:00.000Z.out.555555555555 are deleted as named, though ${outside.id} of their tx, outside the scope, are not uploaded by this plan`,
      ],
    ],
  );

  // Two rows of one tx (both sides of an add), one in scope: the legs naming the tx are the other row's too
  const side = row({ id: "2024-03-01T10:00:00.000Z.in.888888888888", type: "receive", txids: [TX1], description: TX1 });
  const shared = plan({ rows: [r, side], legs: gone("2", `Sent; ${TX1}`), scope: [r.id] }).plan;
  assert.deepEqual([shared.delete, shared.upload], [[], []]);
});

test("an event whose Summ actions hold a manual entry gets nothing planned: the user's pairing is held, every row sharing its txids too", () => {
  // A managed send paired in Summ with the user's manual receive, and the categorised receive of the same tx
  const send = row({ to: "wallet-c" });
  const manual: Leg = {
    ...legsOf(send)[0],
    legId: legId(),
    side: "incoming",
    trade: "bridgeTradeIn",
    currency: "BTC",
    quantity: 0.0099,
    id: "entry-manual",
    source: "manual",
    importType: "manual",
    description: "",
  };
  const receive = btcRow({ type: "bridge-trade-in", feeCurrency: "", feeAmount: "" });
  const deposit = ownLeg({ side: "incoming", trade: "deposit", quantity: 0.01 });
  const legs = [...legsOf(send, { to: "wallet-b" }), manual, deposit];
  const free = plan({ rows: [send, receive], legs: legs.filter((l) => l !== manual) }).plan;
  assert.deepEqual([free.edit.length, free.categorise.length], [1, 1]);
  const { plan: p } = plan({ rows: [send, receive], legs });
  assert.deepEqual([p.edit, p.categorise], [[], []]);
  assert.deepEqual(
    p.held.map((h) => [h.kind, h.id, h.legIds, h.held.map((x) => x.split(" ")[0])]).sort(),
    [
      ["manual-pairing", receive.id, [manual.legId], ["categorise"]],
      ["manual-pairing", send.id, [manual.legId], ["edit"]],
    ].sort(),
  );
  // A leg with no row in the run, beside a manual entry: not deleted either
  const orphan = legsOf(row({ id: "2024-03-01T10:00:00.000Z.out.999999999999" }), {}, "action9");
  const del = plan({ rows: [], legs: [...orphan, { ...manual, actionId: "action9" }] }).plan;
  assert.deepEqual(
    [del.delete, del.held.map((h) => [h.kind, h.id, h.summId, h.held[0]])],
    [[], [["manual-pairing", null, orphan[0].id, "delete (no row in the run)"]]],
  );
  // A manual entry in an action of its own that names the event's txid (a stand-in for the row): the row is not uploaded
  const named = { ...manual, actionId: "action7", description: `Payout; ${TX1}` };
  const standIn = plan({ rows: [send], legs: [named] }).plan;
  assert.deepEqual(
    [standIn.upload, standIn.held.map((h) => [h.id, h.held])],
    [[], [[send.id, [`upload into ${THOR_FILE}`]]]],
  );
  // A placeholder txid (all zeros) links no rows
  const ZERO = "0".repeat(64);
  const a = row({ id: "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaa1", txids: [TX1, ZERO] });
  const b = row({ id: "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaa2", txids: [TX2, ZERO] });
  const apart = plan({ rows: [a, b], legs: [{ ...manual, actionId: "action7", description: `Payout; ${TX1}` }] }).plan;
  assert.deepEqual([apart.upload.flatMap((u) => u.ids), apart.held.map((h) => h.id)], [[b.id], [a.id]]);
});

test("a managed row Summ paired with a leg no row of its event names is reported, with the matcher's changes", () => {
  const TX3 = "3".repeat(64);
  const send = row();
  const other = (over: Partial<Leg>): Leg => ({
    ...legsOf(send)[0],
    legId: legId(),
    side: "incoming",
    trade: "bridgeTradeIn",
    currency: "ETH",
    quantity: 0.1,
    source: "eth-wallet",
    importType: "wallet",
    description: "",
    ...over,
  });
  const history = new Map([
    [
      "action1",
      [
        "1 Jan 2024 10:00 · transactionMatching · Category: Bridge In → Cross Chain Buy",
        "1 Jan 2024 09:00 · import (original)",
      ],
    ],
  ]);
  const stolen = other({ id: `0x${TX3}` });
  const { plan: p } = plan({ rows: [send], legs: [...legsOf(send), stolen], history });
  assert.deepEqual(
    p.report.map((r) => [r.kind, r.id, r.legIds, r.txids]),
    [["foreign-pair", send.id, [stolen.legId], [TX3]]],
  );
  assert.match(
    p.report[0].detail,
    /its matcher changed: 1 Jan 2024 10:00 · transactionMatching · Category: Bridge In → Cross Chain Buy\. Categorise/,
  );
  // the leg of a row of the same event (a payout named by the receive row), or an exchange's own record: no report
  const receive = btcRow({ type: "bridge-trade-in", feeCurrency: "", feeAmount: "", txids: [TX1, TX3] });
  assert.deepEqual(
    plan({ rows: [send, receive], legs: [...legsOf(send), stolen], history }).plan.report.filter(
      (r) => r.kind === "foreign-pair",
    ),
    [],
  );
  assert.deepEqual(
    plan({ rows: [send], legs: [...legsOf(send), other({ id: "1234567890", source: "exchange" })] }).plan.report,
    [],
  );
  // the event's own payout row that has no txid of the leg (the exporter could not name the payout): no foreign pair
  const unnamedPayout = btcRow({
    type: "bridge-trade-in",
    baseCurrency: "ETH",
    baseAmount: "0.1",
    feeCurrency: "",
    feeAmount: "",
  });
  assert.deepEqual(
    plan({ rows: [send, unnamedPayout], legs: [...legsOf(send), stolen], history }).plan.report.filter(
      (r) => r.kind === "foreign-pair",
    ),
    [],
  );
  // a payout row of the event that did match its own leg does not excuse the stolen one
  const payout = ownLeg({
    id: TX1,
    side: "incoming",
    trade: "deposit",
    currency: "ETH",
    quantity: 0.1,
    actionId: "l9",
  });
  const claimed = plan({ rows: [send, unnamedPayout], legs: [...legsOf(send), stolen, payout], history }).plan;
  assert.deepEqual(
    claimed.report.filter((r) => r.kind === "foreign-pair").map((r) => r.legIds),
    [[stolen.legId]],
  );
  // a held row: left alone on purpose
  const held = plan({
    rows: [send],
    legs: [...legsOf(send), stolen],
    history,
    config: { ...CONFIG, hold: [{ id: send.id, reason: "pending" }] },
  }).plan;
  assert.deepEqual(
    held.report.filter((r) => r.kind === "foreign-pair"),
    [],
  );
});

test("a row uploaded under a source not in managedSources is reported, not uploaded again", () => {
  const r = row();
  const { plan: p } = plan({ rows: [r], legs: legsOf(r, { source: "other-account" }) });
  assert.deepEqual(
    p.report.map((e) => e.kind),
    ["other-source"],
  );
  assert.deepEqual(p.upload, []);
});

test("a CSV type with no Summ type stops the plan", () => {
  assert.throws(() => plan({ rows: [row({ type: "teleport" })] }), /No Summ type for CSV type teleport/);
});

test("plan.md lists each section and keeps filed entries apart", () => {
  const { plan: p } = plan({
    rows: [row(), row({ id: "2023-08-01T00:00:00.000Z.out.bbbbbbbbbbbb", timestamp: "2023-08-01T00:00:00.000Z" })],
    config: { ...CONFIG, filedBefore: "2024-01-01" },
  });
  const md = renderPlan(p, "snap", "run");
  for (const heading of [
    "## Delete",
    "## Edit",
    "## Upload (",
    "## Categorise",
    "## Report",
    "## Overridden",
    "### Amendments",
  ])
    assert.ok(md.includes(heading), heading);
});

test("an exact fit is adopted though a looser fit of another old leg claims the same row, and no row is uploaded beside an ambiguous leg", () => {
  const r = row({ description: "no txid" });
  const r2 = row({
    id: "2024-03-01T10:00:30.000Z.out.bbbbbbbbbbbb",
    timestamp: "2024-03-01T10:00:30.000Z",
    type: "sell",
    description: "no txid",
  });
  // a: r at the same second; b: r2 under its old type 17 s off, and r (same type) within the window
  const a = legsOf(r, { id: "old-file.csv:7", description: "" });
  const b = legsOf(r, { id: "old-file.csv:8", description: "", timestamp: "2024-03-01T10:00:47.000Z" }, "action2");
  const { plan: p } = plan({ rows: [r, r2], legs: [...a, ...b] });
  assert.deepEqual(
    p.adopted.map((x) => [x.legId, x.id]),
    [
      [a[0].legId, r.id],
      [b[0].legId, r2.id],
    ],
  );
  assert.deepEqual([p.upload, p.delete, p.report], [[], [], []]);

  // Two old legs both 17 s off r: ambiguous, and r2, which they fit less well, is not uploaded either
  const c = legsOf(r, { id: "old-file.csv:9", description: "", timestamp: "2024-03-01T09:59:43.000Z" }, "action3");
  const amb = plan({ rows: [r, r2], legs: [...b, ...c] }).plan;
  assert.deepEqual(
    amb.report.map((x) => x.kind),
    ["ambiguous-adoption", "ambiguous-adoption"],
  );
  assert.deepEqual([amb.upload, amb.adopted], [[], []]);

  // Two old legs tied at r's exact second hold r back; a third, 50 s off, does not take it
  const x1 = legsOf(r, { id: "old-file.csv:10", description: "" }, "action4");
  const x2 = legsOf(r, { id: "old-file.csv:11", description: "" }, "action5");
  const z = legsOf(r, { id: "old-file.csv:12", description: "", timestamp: "2024-03-01T10:00:50.000Z" }, "action6");
  const tie = plan({ rows: [r], legs: [...x1, ...x2, ...z] }).plan;
  assert.deepEqual(
    tie.report.map((x) => x.kind),
    ["ambiguous-adoption", "ambiguous-adoption", "ambiguous-adoption"],
  );
  assert.deepEqual([tie.upload, tie.adopted, tie.delete], [[], [], []]);
});

test("an old leg under another type goes to the row at its exact second before one within the window; an ignored twin yields", () => {
  // Two rows 58 s apart, each with an old leg at its exact second under an old type: each adopts its own
  const r1 = row({ type: "sell", description: "no txid", txids: [] });
  const r2 = row({
    id: "2024-03-01T10:00:58.000Z.out.bbbbbbbbbbbb",
    timestamp: "2024-03-01T10:00:58.000Z",
    type: "sell",
    description: "no txid",
    txids: [],
  });
  const a = legsOf(row({ type: "send" }), { id: "old-file.csv:1", description: "" }, "action1");
  const b = legsOf(
    row({ type: "send", timestamp: "2024-03-01T10:00:58.000Z" }),
    { id: "old-file.csv:2", description: "" },
    "action2",
  );
  const { plan: p } = plan({ rows: [r1, r2], legs: [...a, ...b] });
  assert.deepEqual(
    p.adopted.map((x) => [x.legId, x.id]).sort(),
    [
      [a[0].legId, r1.id],
      [b[0].legId, r2.id],
    ].sort(),
  );
  assert.deepEqual([p.upload, p.delete, p.report], [[], [], []]);
  assert.deepEqual(
    p.edit.map((e) => e.changes.map((c) => [c.field, c.desired])),
    [[["trade", "sell"]], [["trade", "sell"]]],
  );

  // One row, two old legs 10 s off under another type, one ignored by the user: the other is adopted, the twin deleted
  const r = row({ type: "staking", id: "2024-03-01T10:00:00.000Z.in.cccccccccccc", description: "no txid", txids: [] });
  const kept = legsOf(
    row({ type: "receive" }),
    { id: "old-file.csv:3", description: "", timestamp: "2024-03-01T10:00:10.000Z" },
    "action3",
  );
  const twin = legsOf(
    row({ type: "receive" }),
    { id: "old-file.csv:4", description: "", timestamp: "2024-03-01T10:00:10.000Z", trade: "ignoreIn" },
    "action4",
  );
  const t = plan({ rows: [r], legs: [...kept, ...twin] }).plan;
  assert.deepEqual(
    [t.adopted.map((x) => [x.legId, x.id]), t.delete.map((d) => d.legIds), t.report, t.upload],
    [[[kept[0].legId, r.id]], [[twin[0].legId]], [], []],
  );
  // the yielded twin takes no other row either, at the same rank or a looser one
  const r60 = row({
    type: "staking",
    id: "2024-03-01T10:01:00.000Z.in.dddddddddddd",
    timestamp: "2024-03-01T10:01:00.000Z",
    description: "no txid",
    txids: [],
  });
  const kept0 = legsOf(row({ type: "receive" }), { id: "old-file.csv:6", description: "" }, "action6");
  const twin0 = legsOf(
    row({ type: "receive" }),
    { id: "old-file.csv:7", description: "", trade: "ignoreIn" },
    "action7",
  );
  const later = plan({ rows: [r, r60], legs: [...kept0, ...twin0] }).plan;
  assert.deepEqual(
    [later.adopted.map((x) => x.id), later.delete.map((d) => [d.legIds, d.reason])],
    [[r.id], [[[twin0[0].legId], "old ID: an ignored duplicate of old ID old-file.csv:6"]]],
  );
  assert.deepEqual(
    later.upload.flatMap((u) => u.ids),
    [r60.id],
  );
  // a kept leg that is ambiguous itself (it fits two rows) takes nothing, so its twin does not yield: both reported
  const kept10 = legsOf(
    row({ type: "receive" }),
    { id: "old-file.csv:8", description: "", timestamp: "2024-03-01T10:00:30.000Z" },
    "action8",
  );
  const twin10 = legsOf(
    row({ type: "receive" }),
    { id: "old-file.csv:9", description: "", timestamp: "2024-03-01T10:00:30.000Z", trade: "ignoreIn" },
    "action9",
  );
  const amb = plan({ rows: [r, r60], legs: [...kept10, ...twin10] }).plan;
  assert.deepEqual(
    [amb.adopted, amb.delete, amb.report.map((x) => x.kind)],
    [[], [], ["ambiguous-adoption", "ambiguous-adoption"]],
  );
  // a twin that two kept legs each take a row from: deleted once, naming both
  // (rows 200 s apart; each kept leg 10 s from one row, the twin 100 s from both: all at the window's rank)
  const r200 = row({
    type: "staking",
    id: "2024-03-01T10:03:20.000Z.in.eeeeeeeeeeee",
    timestamp: "2024-03-01T10:03:20.000Z",
    description: "no txid",
    txids: [],
  });
  const k1 = legsOf(
    row({ type: "receive", timestamp: "2024-03-01T10:00:10.000Z" }),
    { id: "old-file.csv:10", description: "" },
    "action10",
  );
  const k2 = legsOf(
    row({ type: "receive", timestamp: "2024-03-01T10:03:10.000Z" }),
    { id: "old-file.csv:11", description: "" },
    "action11",
  );
  const tw = legsOf(
    row({ type: "receive", timestamp: "2024-03-01T10:01:40.000Z" }),
    { id: "old-file.csv:12", description: "", trade: "ignoreIn" },
    "action12",
  );
  const two = plan({ rows: [r, r200], legs: [...k1, ...k2, ...tw] }).plan;
  assert.deepEqual(
    [two.adopted.map((x) => x.id).sort(), two.delete.map((d) => d.reason)],
    [[r.id, r200.id].sort(), ["old ID: an ignored duplicate of old ID old-file.csv:10, old-file.csv:11"]],
  );
  assert.deepEqual([two.report, two.upload], [[], []]);
  // both ignored, or neither: still ambiguous
  const both = plan({
    rows: [r],
    legs: [
      ...legsOf(
        row({ type: "receive" }),
        { id: "old-file.csv:5", description: "", timestamp: "2024-03-01T10:00:10.000Z", trade: "ignoreIn" },
        "action5",
      ),
      ...twin,
    ],
  }).plan;
  assert.deepEqual(
    both.report.map((x) => x.kind),
    ["ambiguous-adoption", "ambiguous-adoption"],
  );
  assert.match(both.report[1].detail, /fits 1 rows \(2024-03-01T10:00:00.000Z.in.cccccccccccc\),/);
});

test("plan writes nothing to the state dir; mergeTables adds its adoptions and captures and keeps hand edits", () => {
  const state = mkdtempSync(join(tmpdir(), "summ-sync-state-"));
  const runDir = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  writeFileSync(join(state, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
  const header =
    "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional),Reference Price Per Unit (Optional),Reference Price Currency (Optional)";
  const r = row();
  mkdirSync(join(runDir, "csv"));
  writeFileSync(
    join(runDir, "csv", THOR_FILE),
    `${header}\n${r.timestamp},send,RUNE,1.5,,,,,wallet-a,wallet-b,THORChain,${r.id},${r.description},,\n`,
  );
  // Summ holds the row under an old ID, so the plan adopts its leg
  const leg = {
    _id: "leg-old",
    id: "old-file.csv:7",
    trade: "withdrawal",
    currency: "RUNE",
    quantity: "1.5",
    timestamp: r.timestamp,
    from: "wallet-a",
    to: "wallet-b",
    description: "",
    source: "csv-source",
  };
  mkdirSync(join(state, "actions"));
  writeFileSync(
    join(state, "actions", "action1.json"),
    JSON.stringify({ action: { _id: "action1", outgoing: [leg] }, history: [] }),
  );
  mkdirSync(join(state, "snapshots"));
  writeFileSync(
    join(state, "snapshots", "2024-08-01T00-00-00.json"),
    JSON.stringify({
      takenAt: "2024-08-01T00:00:00.000Z",
      total: 1,
      actions: [{ id: "action1", txHash: "old-file.csv:7", category: "", tags: [], detail: true }],
    }),
  );

  const dir = writePlan(state, runDir);
  assert.ok(!existsSync(join(state, "adopted.csv")) && !existsSync(join(state, "overrides.json")));
  const saved = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(saved.adopted, [{ legId: "leg-old", id: r.id }]);

  // A reason filled in by hand after the plan is kept when the same override is captured again
  const own: Override = {
    id: r.id,
    leg: "base",
    field: "trade",
    run: "withdrawal",
    summ: "outgoingGift",
    seenAt: "",
    reason: "mine",
    retainUserEdit: "yes",
  };
  writeFileSync(join(state, "overrides.json"), JSON.stringify([own]));
  assert.deepEqual(mergeTables(state, saved.adopted, [{ ...own, reason: "" }]), ["adopted.csv"]);
  assert.equal(readFileSync(join(state, "adopted.csv"), "utf8"), `Leg,ID\nleg-old,${r.id}\n`);
  assert.equal(JSON.parse(readFileSync(join(state, "overrides.json"), "utf8"))[0].reason, "mine");
  assert.deepEqual(mergeTables(state, saved.adopted, []), []);

  // A value the user set again since replaces the override, still with their reason, and undecided: the
  // decision was on the old value
  assert.deepEqual(mergeTables(state, [], [{ ...own, summ: "lost", reason: "", retainUserEdit: "undecided" }]), [
    "overrides.json",
  ]);
  assert.deepEqual(
    readOverrides(state).map((o) => [o.summ, o.reason, o.retainUserEdit]),
    [["lost", "mine", "undecided"]],
  );
});

test("overrides.json: an entry without retainUserEdit is undecided; any other value is an error", () => {
  const state = mkdtempSync(join(tmpdir(), "summ-sync-overrides-"));
  const old = { id: "a.csv:1", leg: "base", field: "trade", run: "withdrawal", summ: "lost", seenAt: "", reason: "" };
  writeFileSync(join(state, "overrides.json"), JSON.stringify([old]));
  assert.deepEqual(
    readOverrides(state).map((o) => o.retainUserEdit),
    ["undecided"],
  );
  writeFileSync(join(state, "overrides.json"), JSON.stringify([{ ...old, retainUserEdit: "false" }]));
  assert.throws(() => readOverrides(state), /retainUserEdit of a\.csv:1 trade must be "yes", "no" or "undecided"/);
});

test("CSV types map to the trade Summ holds for them", () => {
  // Summ's enum has `collateral`, not `collateralDeposit`: a CSV collateral-deposit row is held as `collateral`
  assert.deepEqual(summType("collateral-deposit"), { side: "outgoing", trade: "collateral" });
  assert.deepEqual(summType("collateral-withdrawal"), { side: "incoming", trade: "collateralWithdrawal" });
});

const priced = (over: Partial<Row> = {}) => row({ referencePrice: "2.5", referencePriceCurrency: "USD", ...over });
const pricedLegs = (r: Row, over: Partial<Leg> = {}) => legsOf(r, { price: 3.9, ...over });
const priceEdits = (p: ReturnType<typeof plan>["plan"]) =>
  p.edit.flatMap((e) => e.changes).filter((c) => c.field === "price");
// What apply logs for one price edit: the line before the call, then the result
const priceLine = (legId: string, value: number, after: number | null) => [
  { legId, field: "price", value, intent: true },
  { legId, field: "price", value, after },
];
const priceHistory = (...lines: string[]) => new Map([["action1", lines]]);
const USER_PRICE = "30 Oct 2026 20:39 · user · Price: EUR 3.90 → EUR 3.95";
const UNDO_PRICE = "30 Oct 2026 20:40 · undo · Price: EUR 3.95 → EUR 3.90";
const priceOverride = (r: Row, retainUserEdit: Override["retainUserEdit"], summ = 3.9): Override => ({
  id: r.id,
  leg: "base",
  field: "price",
  run: 2.5,
  summ,
  seenAt: "",
  reason: "",
  retainUserEdit,
});

test("price: a leg with no recorded price is edited, in USD", () => {
  const r = priced();
  const legs = pricedLegs(r);
  assert.deepEqual(priceEdits(plan({ rows: [r], legs }).plan), [
    { leg: "base", legId: legs[0].legId, field: "price", summ: 3.9, desired: 2.5 },
  ]);
});

test("price: a row with no reference price is left alone", () => {
  const r = row();
  assert.deepEqual(priceEdits(plan({ rows: [r], legs: pricedLegs(r) }).plan), []);
});

test("price: the plan is empty after the sync's own edit, with or without a history line for it", () => {
  const r = priced();
  const legs = pricedLegs(r);
  for (const history of [priceHistory(USER_PRICE), priceHistory()]) {
    const p = plan({ rows: [r], legs, history, applyLog: priceLine(legs[0].legId, 2.5, 3.9) }).plan;
    assert.deepEqual(priceEdits(p), []);
    assert.deepEqual(p.overridden, []);
  }
});

test("price: a moved reference price is edited again", () => {
  const r = priced({ referencePrice: "2.6" });
  const legs = pricedLegs(r);
  const p = plan({ rows: [r], legs, applyLog: priceLine(legs[0].legId, 2.5, 3.9) }).plan;
  assert.deepEqual(
    priceEdits(p).map((c) => c.desired),
    [2.6],
  );
});

test("price: an uploaded leg's price comes from the plan's upload file", () => {
  const r = priced();
  const legs = pricedLegs(r, { priceValueCurrency: "USD" });
  assert.deepEqual(priceEdits(plan({ rows: [r], legs, uploadedPrices: new Map([[r.id, 2.5]]) }).plan), []);
  assert.equal(priceEdits(plan({ rows: [r], legs }).plan).length, 1);
});

test("price: an upload holds its file's price though Summ does not mark it, by the leg's creation time", () => {
  const r = priced();
  const at = (time: string, price: number | null) => ({ planTime: Date.parse(time), price });
  const legs = (createdAt: string) => pricedLegs(r).map((l) => ({ ...l, createdAt }));
  const files = new Map([[r.id, [at("2026-01-01T00:00:00Z", 2.5), at("2026-03-01T00:00:00Z", 2.6)]]]);
  // Uploaded from the first file: the row's price is the same, so nothing to do
  assert.deepEqual(priceEdits(plan({ rows: [r], legs: legs("2026-02-01T00:00:00Z"), uploadFiles: files }).plan), []);
  // Made before any file with a price: it holds Summ's market price
  assert.equal(priceEdits(plan({ rows: [r], legs: legs("2025-12-01T00:00:00Z"), uploadFiles: files }).plan).length, 1);
  // Uploaded from a file with no price
  const blank = new Map([[r.id, [at("2026-01-01T00:00:00Z", null)]]]);
  assert.equal(priceEdits(plan({ rows: [r], legs: legs("2026-02-01T00:00:00Z"), uploadFiles: blank }).plan).length, 1);
  // Files that disagree: any can be the one uploaded, so it is edited once
  const added = new Map([[r.id, [at("2026-01-01T00:00:00Z", null), at("2026-01-15T00:00:00Z", 2.5)]]]);
  assert.equal(priceEdits(plan({ rows: [r], legs: legs("2026-02-01T00:00:00Z"), uploadFiles: added }).plan).length, 1);
  for (const [first, second] of [
    [2.5, 2.6],
    [2.5, null],
  ] as const) {
    const differ = new Map([[r.id, [at("2026-01-01T00:00:00Z", first), at("2026-01-15T00:00:00Z", second)]]]);
    assert.equal(
      priceEdits(plan({ rows: [r], legs: legs("2026-02-01T00:00:00Z"), uploadFiles: differ }).plan).length,
      1,
    );
  }
  // A file made after the leg does not count, nor one in the same instant
  const later = new Map([[r.id, [at("2026-02-01T00:00:00Z", 2.5)]]]);
  assert.equal(priceEdits(plan({ rows: [r], legs: legs("2026-02-01T00:00:00Z"), uploadFiles: later }).plan).length, 1);
  // A user's price edit is still theirs
  const edited = plan({
    rows: [r],
    legs: legs("2026-02-01T00:00:00Z"),
    uploadFiles: files,
    history: priceHistory(USER_PRICE),
  }).plan;
  assert.deepEqual(priceEdits(edited), []);
  assert.deepEqual(
    edited.overridden.map((o) => o.kind),
    ["captured"],
  );
});

test("price: the USD mark an undo left behind is not trusted, and the undone edit is no drift", () => {
  const r = priced();
  const legs = pricedLegs(r, { priceValueCurrency: "USD" });
  const p = plan({
    rows: [r],
    legs,
    uploadedPrices: new Map([[r.id, 2.5]]),
    history: priceHistory(USER_PRICE, UNDO_PRICE),
  }).plan;
  assert.equal(priceEdits(p).length, 1);
  assert.deepEqual(p.overridden, []);
});

test("price: a price the user set, with no edit of the sync's, is captured and kept", () => {
  const r = priced();
  const p = plan({ rows: [r], legs: pricedLegs(r), history: priceHistory(USER_PRICE) }).plan;
  assert.deepEqual(priceEdits(p), []);
  assert.deepEqual(
    p.overridden.map((o) => [o.kind, o.override.field, o.override.summ]),
    [["captured", "price", 3.9]],
  );
});

test("price: a local price other than the one after the sync's edit is captured, however the history reads", () => {
  const r = priced();
  const legs = pricedLegs(r);
  for (const history of [priceHistory(USER_PRICE, USER_PRICE), priceHistory()]) {
    const p = plan({ rows: [r], legs, history, applyLog: priceLine(legs[0].legId, 2.5, 3.8) }).plan;
    assert.deepEqual(priceEdits(p), []);
    assert.deepEqual(
      p.overridden.map((o) => o.kind),
      ["captured"],
    );
  }
});

test("price: retainUserEdit no sets the run's price over the sync's earlier edit, and is clean after", () => {
  const r = priced();
  const legs = pricedLegs(r);
  const overrides = [priceOverride(r, "no")];
  const before = plan({ rows: [r], legs, overrides, applyLog: priceLine(legs[0].legId, 2.5, 3.8) }).plan;
  assert.equal(priceEdits(before).length, 1);
  const moved = legs.map((l) => ({ ...l, price: 3.85 }));
  const after = plan({
    rows: [r],
    legs: moved,
    overrides,
    applyLog: [...priceLine(legs[0].legId, 2.5, 3.8), ...priceLine(legs[0].legId, 2.5, 3.85)],
  }).plan;
  assert.deepEqual(priceEdits(after), []);
  assert.deepEqual(after.overridden, []);
});

test("price: a kept override holds with no history left to show it, until the price moves", () => {
  const r = priced();
  const legs = pricedLegs(r);
  assert.deepEqual(priceEdits(plan({ rows: [r], legs, overrides: [priceOverride(r, "yes")] }).plan), []);
  const moved = plan({
    rows: [r],
    legs,
    overrides: [priceOverride(r, "yes", 4)],
    history: priceHistory(USER_PRICE),
  }).plan;
  assert.deepEqual(
    moved.overridden.map((o) => o.kind),
    ["captured"],
  );
});

test("price: a failed read-back is no drift: the edit is made again", () => {
  const r = priced();
  const legs = pricedLegs(r);
  const p = plan({
    rows: [r],
    legs,
    history: priceHistory(USER_PRICE),
    applyLog: priceLine(legs[0].legId, 2.5, null),
  }).plan;
  assert.equal(priceEdits(p).length, 1);
  assert.deepEqual(p.overridden, []);
});

test("price: after a failed read-back, a further edit in the history or a null price is not taken as the sync's", () => {
  const r = priced();
  const legs = pricedLegs(r);
  const lines = priceLine(legs[0].legId, 2.5, null);
  const edited = plan({ rows: [r], legs, history: priceHistory(USER_PRICE, USER_PRICE), applyLog: lines }).plan;
  assert.deepEqual(priceEdits(edited), []);
  assert.deepEqual(
    edited.overridden.map((o) => o.kind),
    ["captured"],
  );
  const unpriced = legs.map((l) => ({ ...l, price: null }));
  assert.equal(priceEdits(plan({ rows: [r], legs: unpriced, applyLog: lines }).plan).length, 1);
});

test("price: a crash after the edit is not taken for the user's edit; the edit is made again", () => {
  const r = priced();
  const legs = pricedLegs(r);
  const applyLog = priceLine(legs[0].legId, 2.5, null).slice(0, 1);
  const p = plan({ rows: [r], legs, history: priceHistory(USER_PRICE), applyLog }).plan;
  assert.equal(priceEdits(p).length, 1);
  assert.deepEqual(p.overridden, []);
});

test("drift: an intent line alone, a crash during the edit, counts as the sync's own", () => {
  const r = row();
  const legs = legsOf(r, { trade: "outgoingGift" });
  const history = new Map([["action1", ["2 Jan 2024 · user · Category: Send → Outgoing Gift"]]]);
  const { plan: p } = plan({
    rows: [r],
    legs,
    history,
    applyLog: [{ legId: legs[0].legId, field: "trade", value: "outgoingGift", intent: true }],
  });
  assert.deepEqual(p.overridden, []);
  assert.deepEqual(
    p.edit[0].changes.map((c) => [c.field, c.desired]),
    [["trade", "withdrawal"]],
  );
});

test("price: intent lines of an edit's other fields do not count as price edits", () => {
  const r = priced();
  const legs = pricedLegs(r);
  const applyLog = [
    { legId: legs[0].legId, field: "trade", value: "income", intent: true },
    { legId: legs[0].legId, field: "quantity", value: 1, intent: true },
    ...priceLine(legs[0].legId, 2.5, null),
  ];
  // Two price lines in the history against one edit: foreign, as with one intent and nothing else
  const two = plan({ rows: [r], legs, history: priceHistory(USER_PRICE, USER_PRICE), applyLog }).plan;
  assert.equal(two.overridden[0]?.kind, "captured");
  const one = plan({ rows: [r], legs, history: priceHistory(USER_PRICE), applyLog }).plan;
  assert.deepEqual(one.overridden, []);
});

test("price: retainUserEdit no is honoured with no history and an upload file at the run's price", () => {
  const r = priced();
  const legs = pricedLegs(r, { priceValueCurrency: "USD" });
  const p = plan({
    rows: [r],
    legs,
    overrides: [priceOverride(r, "no")],
    uploadedPrices: new Map([[r.id, 2.5]]),
  }).plan;
  assert.equal(priceEdits(p).length, 1);
});

test("price: a price other than the one decided on is captured with no history, whatever the decision", () => {
  const r = priced();
  const legs = pricedLegs(r, { priceValueCurrency: "USD" });
  for (const decision of ["yes", "no", "undecided"] as const) {
    const p = plan({
      rows: [r],
      legs,
      overrides: [priceOverride(r, decision, 4)],
      uploadedPrices: new Map([[r.id, 2.5]]),
    }).plan;
    assert.deepEqual(priceEdits(p), []);
    assert.deepEqual(
      p.overridden.map((o) => o.kind),
      ["captured"],
    );
  }
});

test("price: the sync's edit of one leg is no drift for the other leg of its action", () => {
  const a = priced();
  const b = priced({ id: "2024-03-01T10:00:00.000Z.in.bbbbbbbbbbbb", type: "receive" });
  const legs = [...pricedLegs(a), ...pricedLegs(b)];
  const p = plan({
    rows: [a, b],
    legs,
    history: priceHistory(USER_PRICE),
    applyLog: priceLine(legs[0].legId, 2.5, 3.9),
  }).plan;
  assert.deepEqual(
    priceEdits(p).map((c) => c.legId),
    [legs[1].legId],
  );
  assert.deepEqual(p.overridden, []);
});

test("price: a recorded price the run no longer has is reported", () => {
  const r = row();
  const legs = pricedLegs(r);
  const p = plan({ rows: [r], legs, applyLog: priceLine(legs[0].legId, 2.5, 3.9) }).plan;
  assert.deepEqual(
    p.report.map((e) => e.kind),
    ["price-blank"],
  );
  assert.deepEqual(priceEdits(p), []);
});

test("price: a held row gets no price edit", () => {
  const r = priced();
  const config = { ...CONFIG, hold: [{ id: r.id, reason: "pending" }] };
  assert.deepEqual(priceEdits(plan({ rows: [r], legs: pricedLegs(r), config }).plan), []);
});

test("price: uploadedPrices reads the newest plan's upload file, and a blank price clears an older one", () => {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-"));
  const header = "ID (Optional),Reference Price Per Unit (Optional),Reference Price Currency (Optional)";
  const write = (plan: string, lines: string[]) => {
    mkdirSync(join(dir, "plans", plan, "upload"), { recursive: true });
    writeFileSync(join(dir, "plans", plan, "upload", "f.csv"), [header, ...lines].join("\n") + "\n");
  };
  write("2026-01-01T00-00-00", ["a,1.5,USD", "b,2.5,USD", "c,3.5,USD"]);
  write("2026-01-02T00-00-00", ["b,2.75,USD", "c,,"]);
  assert.deepEqual(
    [...uploadedPrices(dir)],
    [
      ["a", 1.5],
      ["b", 2.75],
    ],
  );
});

test("price: uploadPriceFiles lists each plan's price by the folder's time, and skips a folder with no time", () => {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-"));
  const header = "ID (Optional),Reference Price Per Unit (Optional),Reference Price Currency (Optional)";
  const write = (plan: string, lines: string[]) => {
    mkdirSync(join(dir, "plans", plan, "upload"), { recursive: true });
    writeFileSync(join(dir, "plans", plan, "upload", "f.csv"), [header, ...lines].join("\n") + "\n");
  };
  write("2026-01-01T00-00-00", ["a,1.5,USD"]);
  write("2026-01-02T03-04-05-note", ["a,,"]);
  write("hand-made", ["a,9,USD"]);
  assert.deepEqual(uploadPriceFiles(dir).get("a"), [
    { planTime: Date.parse("2026-01-01T00:00:00Z"), price: 1.5 },
    { planTime: Date.parse("2026-01-02T03:04:05Z"), price: null },
  ]);
});

test("price: plan.md lists price edits apart, the rate furthest from the median at the head", () => {
  const entry = (id: string, legId: string, summ: number, desired: number) => ({
    id,
    filed: false,
    actionId: "a",
    changes: [{ leg: "base" as const, legId, field: "price", summ, desired }],
  });
  const text = priceLines(
    [entry("near", "l1", 1.5, 1), entry("mid", "l2", 3, 2), entry("far", "l3", 90, 3), entry("zero", "l4", 0, 5)],
    new Map([
      ["l1", 100],
      ["l2", 1],
      ["l3", 1],
    ]),
  ).join("\n");
  assert.match(text, /Median rate 1\.5000/);
  assert.equal(text.split("| zero |").length, 2);
  assert.ok(text.indexOf("| far |") < text.indexOf("| near |"));
  assert.ok(text.lastIndexOf("| near |") < text.lastIndexOf("| far |"));
});

test("plan refuses a version 2 snapshot pulled for another run", () => {
  const state = mkdtempSync(join(tmpdir(), "summ-sync-"));
  writeFileSync(join(state, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(run, "csv"));
  const header =
    "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional)";
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_THOR_abc_Wallet.csv"), `${header}\n`);
  const file = join(state, "snapshots", "2026-01-01T00-00-00.json");
  writeSnapshot(file, { version: 2, takenAt: "", total: 0, run: "/elsewhere", range: null, actions: [] });
  writeFileSync(file.replace(".json", ".details.jsonl"), "{}\n");
  assert.throws(() => writePlan(state, run), /pulled for \/elsewhere/);
});

test("plan refuses wider changes from a snapshot of part of the history", () => {
  const state = mkdtempSync(join(tmpdir(), "summ-sync-"));
  writeFileSync(join(state, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"] }));
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(run, "csv"));
  const header =
    "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional)";
  const line = `2023-08-01T00:00:00.000Z,send,RUNE,1,,,,,a,b,THORChain,2023-08-01T00:00:00.000Z.out.aaaaaaaaaaaa,x`;
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_THOR_abc_Wallet.csv"), `${header}\n${line}\n`);
  const file = join(state, "snapshots", "2026-01-01T00-00-00.json");
  const range = { from: "2023-07-01", to: "2024-06-30", after: 0, before: 1 };
  writeSnapshot(file, {
    version: 2,
    takenAt: "",
    total: 0,
    run: resolve(run),
    range,
    managedSources: ["csv-source"],
    managedChains: DEFAULTS.managedChains,
    actions: [],
  });
  writeFileSync(file.replace(".json", ".details.jsonl"), "{}\n");
  assert.throws(() => writePlan(state, run), /Pull with --all/);
});

test("a partial snapshot refuses deletes and filed-year edits, and notes its limit on an edit it allows", () => {
  const header =
    "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional)";
  const id = "2023-08-01T00:00:00.000Z.out.aaaaaaaaaaaa";
  const leg = (legId: string, legRowId: string, quantity: number) => ({
    _id: legId,
    id: legRowId,
    trade: "withdrawal",
    currency: "RUNE",
    quantity,
    timestamp: "2023-08-01T00:00:00.000Z",
    from: "a",
    to: "b",
    description: "x",
    source: "csv-source",
    importType: "manual-csv",
  });
  const setup = (legs: unknown[], config: Record<string, unknown> = {}) => {
    const state = mkdtempSync(join(tmpdir(), "summ-sync-"));
    writeFileSync(join(state, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"], ...config }));
    const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
    mkdirSync(join(run, "csv"));
    writeFileSync(
      join(run, "csv", "2023-07-01_2024-06-30_THOR_abc_Wallet.csv"),
      `${header}\n2023-08-01T00:00:00.000Z,send,RUNE,1,,,,,a,b,THORChain,${id},x\n`,
    );
    const file = join(state, "snapshots", "2026-01-01T00-00-00.json");
    writeSnapshot(file, {
      version: 2,
      takenAt: "",
      total: 1,
      run: resolve(run),
      range: { from: "2023-07-01", to: "2024-06-30", after: 0, before: 1 },
      managedSources: ["csv-source"],
      managedChains: DEFAULTS.managedChains,
      actions: [{ id: "a1", txHash: id, category: "send", tags: [], detail: true }],
    });
    const detail = { a: "a1", at: "", action: { _id: "a1", outgoing: legs }, history: [] };
    writeFileSync(file.replace(".json", ".details.jsonl"), `{}\n${JSON.stringify(detail)}\n`);
    return { state, run };
  };
  // A leg with no row in the run, beside the row's own leg: a delete
  const deleting = setup([leg("l1", id, 1), leg("l2", "2023-08-02T00:00:00.000Z.out.bbbbbbbbbbbb", 2)]);
  assert.throws(() => writePlan(deleting.state, deleting.run), /1 deletes.*Pull with --all/);
  // The row's amount differs: an edit, in a filed year
  const filed = setup([leg("l1", id, 2)], { filedBefore: "2024-07-01" });
  assert.throws(() => writePlan(filed.state, filed.run), /edits in filed years.*Pull with --all/);
  // The same edit in a current year passes, and says what the snapshot covers
  const allowed = setup([leg("l1", id, 2)]);
  const dir = writePlan(allowed.state, allowed.run);
  assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /covers only 2023-07-01 to 2024-06-30/);
});

test("a partial snapshot allows an import leg's price alone in a current year; any other categorise needs a whole pull", () => {
  const txid = "1".repeat(64);
  const header =
    "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional),Reference Price Per Unit (Optional),Reference Price Currency (Optional)";
  const id = "2023-08-01T00:00:00.000Z.out.aaaaaaaaaaaa";
  const own = (over: Record<string, unknown>) => ({
    _id: "l1",
    id: txid,
    trade: "bridgeTradeOut",
    currency: "BTC",
    quantity: 1,
    price: 9,
    timestamp: "2023-08-01T00:00:00.000Z",
    source: "btc-wallet",
    importType: "wallet",
    ...over,
  });
  const setup = (legs: unknown[], config: Record<string, unknown> = {}) => {
    const state = mkdtempSync(join(tmpdir(), "summ-sync-"));
    writeFileSync(join(state, "summ-sync.json"), JSON.stringify({ managedSources: ["csv-source"], ...config }));
    const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
    mkdirSync(join(run, "csv"));
    writeFileSync(
      join(run, "csv", "2023-07-01_2024-06-30_BTC_abc_Wallet.csv"),
      `${header}\n2023-08-01T00:00:00.000Z,bridge-trade-out,BTC,1,,,,,a,b,BTC,${id},${txid},5,USD\n`,
    );
    const file = join(state, "snapshots", "2026-01-01T00-00-00.json");
    writeSnapshot(file, {
      version: 2,
      takenAt: "",
      total: 1,
      run: resolve(run),
      range: { from: "2023-07-01", to: "2024-06-30", after: 0, before: 1 },
      managedSources: ["csv-source"],
      managedChains: DEFAULTS.managedChains,
      actions: [{ id: "a1", txHash: txid, category: "send", tags: [], detail: true }],
    });
    const detail = { a: "a1", at: "", action: { _id: "a1", outgoing: legs }, history: [] };
    writeFileSync(file.replace(".json", ".details.jsonl"), `{}\n${JSON.stringify(detail)}\n`);
    return { state, run };
  };
  const allowed = setup([own({})]);
  const planned = JSON.parse(readFileSync(join(writePlan(allowed.state, allowed.run), "plan.json"), "utf8"));
  assert.deepEqual(
    planned.categorise[0].changes.map((c: { field: string }) => c.field),
    ["price"],
  );
  const typed = setup([own({ trade: "withdrawal" })]);
  assert.throws(() => writePlan(typed.state, typed.run), /1 categorisations.*Pull with --all/);
  const filed = setup([own({})], { filedBefore: "2024-07-01" });
  assert.throws(() => writePlan(filed.state, filed.run), /1 categorisations.*Pull with --all/);
  const made = own({ _id: "l2", trade: "deposit", importType: "soft-transfer", source: "manual", side: "incoming" });
  const ignoring = setup([own({}), made]);
  assert.throws(() => writePlan(ignoring.state, ignoring.run), /1 categorisations.*Pull with --all/);
});

test("a made-up leg an apply left in place is reported while it is in Summ and not ignored, with or without a row", () => {
  const left = { legId: "made", id: null, plan: "p1", reason: "still shares its action" };
  const leg = (trade: string) => ({
    ...legsOf(row())[0],
    legId: "made",
    trade,
    source: "other",
    importType: "soft-transfer",
  });
  const report = (over: Partial<PlanInput>) => plan(over).plan.report.filter((r) => r.kind === "made-up-left");
  const held = report({ legs: [leg("deposit")], leftLegs: [left] });
  assert.deepEqual(
    held.map((r) => [r.id, r.legIds]),
    [[undefined, ["made"]]],
  );
  assert.match(held[0].detail, /plan p1.*still shares its action/);
  assert.equal(report({ legs: [leg("deposit")], leftLegs: [{ ...left, id: "row-1" }] })[0].id, "row-1");
  assert.deepEqual(report({ legs: [leg("ignoreIn")], leftLegs: [left] }), []);
  assert.deepEqual(report({ legs: [], leftLegs: [left] }), []);
  assert.deepEqual(report({ legs: [leg("deposit")] }), []);
});

// ---- A price edit must not part a sell's sides (spec: Prices)
const sellRow = (over: Partial<Row> = {}) =>
  priced({
    type: "sell",
    description: "sold",
    baseAmount: "10",
    quoteCurrency: "SYN",
    quoteAmount: "4",
    ...over,
  });
const sellLegs = (r: Row, source = "unknown", buy: Partial<Leg> = {}, sell: Partial<Leg> = {}) => {
  const [base, quote] = legsOf(r, { price: 3, ...sell });
  return [base, { ...quote, price: 7.5, currencySource: source, ...buy }];
};
const standing = (legs: Leg[], usd = 2.5, after = 3) => priceLine(legs[0].legId, usd, after);

test("trade price: a quote Summ cannot price gives one entry for both legs", () => {
  const r = sellRow();
  const legs = sellLegs(r);
  const { edit, held } = plan({ rows: [r], legs }).plan;
  assert.deepEqual(held, []);
  assert.equal(edit.length, 1);
  assert.deepEqual(edit[0].changes, [{ leg: "base", legId: legs[0].legId, field: "price", summ: 3, desired: 2.5 }]);
  assert.deepEqual(edit[0].match, { legId: legs[1].legId, baseLegId: legs[0].legId, summ: 7.5, desired: null });

  const md = renderPlan(plan({ rows: [r], legs }).plan, "snap", "run");
  const prices = md.slice(md.indexOf("## Edit: reference prices"), md.indexOf("## Upload"));
  assert.match(
    prices,
    new RegExp(
      `\\| ${r.id} \\| \`${legs[0].legId}\` \\| US\\$2\\.5 \\| \`${legs[1].legId}\` \\| 7\\.5 \\| sell value / buy amount \\(local\\) \\|`,
    ),
  );
});

test("trade price: a quote with a market price, or with no evidence, holds the price edit and lists why", () => {
  for (const source of ["coingecko", ""]) {
    const r = sellRow();
    const legs = sellLegs(r, source);
    const { edit, held } = plan({ rows: [r], legs }).plan;
    assert.deepEqual(edit, []);
    assert.equal(held.length, 1);
    assert.equal(held[0].kind, "price");
    assert.deepEqual(held[0].legIds, [legs[0].legId, legs[1].legId]);
    assert.match(held[0].reason, /awaiting a test of what upload produces/);
  }
  // A change other than the price still goes ahead; a price with nothing to do holds nothing
  const r = sellRow();
  const moved = sellLegs(r, "coingecko", {}, { from: "elsewhere" });
  const { edit } = plan({ rows: [r], legs: moved }).plan;
  assert.deepEqual(
    edit[0].changes.map((c) => c.field),
    ["from"],
  );
  const equal = sellLegs(r, "coingecko");
  const quiet = plan({ rows: [r], legs: equal, applyLog: standing(equal) }).plan;
  assert.deepEqual([quiet.edit, quiet.held], [[], []]);
  // Its price stands and its sides are parted: listed, so nothing stays parted unseen
  const parted = sellLegs(r, "coingecko", { price: 1 });
  const seen = plan({ rows: [r], legs: parted, applyLog: standing(parted) }).plan;
  assert.deepEqual(seen.edit, []);
  assert.equal(seen.held[0].kind, "price");
  assert.match(seen.held[0].held[0], /a value other than the base leg's/);
  // A row held whole lists the price with the rest, once
  const whole = plan({
    rows: [r],
    legs: sellLegs(r, "coingecko"),
    config: { ...CONFIG, hold: [{ id: r.id, reason: "x" }] },
  }).plan;
  assert.equal(whole.held.length, 1);
  assert.match(whole.held[0].held.join(), /price of the base leg/);
});

test("trade price: a row repaired by hand plans nothing, by value, whatever its history says", () => {
  const r = sellRow();
  const legs = sellLegs(r, "unknown", { price: 7.5 + 1e-13 });
  const history = priceHistory(USER_PRICE, USER_PRICE);
  const { plan: p } = plan({ rows: [r], legs, applyLog: standing(legs), history });
  assert.ok(empty(p), JSON.stringify(p, null, 1));
});

test("trade price: a sell standing with its buy parted plans the buy alone, at the known price", () => {
  const r = sellRow();
  const legs = sellLegs(r, "unknown", { price: 7 });
  const history = priceHistory(USER_PRICE);
  const { plan: p } = plan({ rows: [r], legs, applyLog: standing(legs), history });
  assert.deepEqual(p.edit[0].changes, []);
  assert.deepEqual(p.edit[0].match, { legId: legs[1].legId, baseLegId: legs[0].legId, summ: 7, desired: 7.5 });
  assert.match(renderPlan(p, "snap", "run"), /keeps its price .* 7\.5 \(local\)/);
});

test("trade price: a moved reference price takes both legs, a repaired buy following its sell", () => {
  const r = sellRow({ referencePrice: "2.6" });
  const legs = sellLegs(r);
  const history = priceHistory(USER_PRICE, USER_PRICE);
  const { edit, overridden } = plan({ rows: [r], legs, applyLog: standing(legs), history }).plan;
  assert.equal(edit[0].changes[0].desired, 2.6);
  assert.equal(edit[0].match?.desired, null);
  assert.deepEqual(overridden, []);
});

test("trade price: an amount edited in the same entry gives the buy's price from the new amount", () => {
  const r = sellRow({ quoteAmount: "5" });
  const legs = sellLegs(r, "unknown", { quantity: 4, price: 7.5 });
  const { edit } = plan({ rows: [r], legs, applyLog: standing(legs) }).plan;
  assert.deepEqual(
    edit[0].changes.map((c) => c.field),
    ["quantity"],
  );
  assert.equal(edit[0].match?.desired, 6);
});

test("trade price: a user's price on the buy is kept as an override, and the sell's edit goes on", () => {
  const r = sellRow();
  // More Price lines in the action's history than the sync's edits: the sell stands, the buy parted
  const legs = sellLegs(r, "unknown", { price: 7 });
  const history = priceHistory(USER_PRICE, USER_PRICE);
  const first = plan({ rows: [r], legs, applyLog: standing(legs), history }).plan;
  assert.deepEqual(first.edit, []);
  const captured = first.overridden.map((o) => o.override);
  assert.deepEqual(
    captured.map((o) => [o.leg, o.field, o.summ, o.retainUserEdit, o.run]),
    [["quote", "price", 7, "undecided", 7.5]],
  );

  // The buy no longer shows the sync's own `after`
  const own = [...standing(legs), ...priceLine(legs[1].legId, 7.5, 7.5)];
  const edited = plan({ rows: [r], legs, applyLog: own }).plan;
  assert.deepEqual(edited.edit, []);
  assert.equal(edited.overridden[0].override.leg, "quote");

  const quote = (retainUserEdit: Override["retainUserEdit"], summ = 7): Override => ({
    ...priceOverride(r, retainUserEdit, summ),
    leg: "quote",
    run: 7.5,
  });
  // undecided and yes hold, undecided listed; a moved reference price still edits the sell alone
  const held = plan({ rows: [r], legs, applyLog: standing(legs), history, overrides: [quote("undecided")] }).plan;
  assert.deepEqual([held.edit, held.overridden.map((o) => o.kind)], [[], ["undecided"]]);
  const moved = sellRow({ referencePrice: "2.6" });
  const yes = plan({ rows: [moved], legs: sellLegs(moved, "unknown", { price: 7 }), overrides: [quote("yes")] }).plan;
  assert.equal(yes.edit[0].match, undefined);
  assert.equal(yes.edit[0].changes[0].field, "price");
  // no sets it back
  const no = plan({ rows: [r], legs, applyLog: standing(legs), history, overrides: [quote("no")] }).plan;
  assert.equal(no.edit[0].match?.desired, 7.5);
  // A value other than the one decided on is captured again
  const again = plan({ rows: [r], legs, applyLog: standing(legs), history, overrides: [quote("yes", 6)] }).plan;
  assert.deepEqual([again.edit, again.overridden[0].kind], [[], "captured"]);
});

test("trade price: a sell's own override leaves the buy alone too", () => {
  const r = sellRow();
  const legs = sellLegs(r);
  const { edit } = plan({ rows: [r], legs, overrides: [priceOverride(r, "yes", 3)] }).plan;
  assert.deepEqual(edit, []);
});

test("trade price: a row with no reference price, or a quote with no amount, leaves the buy alone", () => {
  const r = sellRow({ referencePrice: "", referencePriceCurrency: "" });
  assert.deepEqual(plan({ rows: [r], legs: sellLegs(r, "unknown", { price: 1 }) }).plan.edit, []);
  const zero = sellRow({ quoteAmount: "0" });
  const { edit } = plan({ rows: [zero], legs: sellLegs(zero, "unknown", { quantity: 0 }) }).plan;
  assert.equal(edit[0].match, undefined);
});

test("trade price: a row with no quote leg, as each managed side of a swap is, keeps its own price alone", () => {
  const out = priced({ type: "lost" });
  const legs = pricedLegs(out);
  const { edit } = plan({ rows: [out], legs }).plan;
  assert.equal(edit[0].match, undefined);
  assert.equal(priceEdits(plan({ rows: [out], legs }).plan).length, 1);
});

const swapRow = (over: Partial<Row> = {}) =>
  btcRow({
    type: "bridge-trade-out",
    referencePrice: "60000",
    referencePriceCurrency: "USD",
    ...over,
  });

test("import price: a swap's leg takes the row's USD price, in one edit with its category; never amount or fee", () => {
  const r = swapRow({ baseAmount: "0.01", feeAmount: "0.0002" });
  const leg = ownLeg({ quantity: 0.01, price: 90000 });
  const fee = ownLeg({ side: "fees", trade: "fee", quantity: 0.0001, price: 90000, id: TX1 });
  const { categorise, edit } = plan({ rows: [r], legs: [leg, fee] }).plan;
  assert.deepEqual(edit, []);
  assert.equal(categorise.length, 1);
  assert.deepEqual(
    categorise[0].changes.map((c) => [c.legId, c.field, c.desired]),
    [
      [leg.legId, "trade", "bridgeTradeOut"],
      [leg.legId, "price", 60000],
    ],
  );
  const md = renderPlan(plan({ rows: [r], legs: [leg, fee] }).plan, "snap", "run");
  assert.match(md, new RegExp(`\\| ${r.id} \\(Summ's import\\) \\| \`${leg.legId}\``));
  const part = md.slice(md.indexOf("## Categorise"), md.indexOf("## Held"));
  assert.match(part, /\| trade \|/);
  assert.doesNotMatch(part, /\| price \|/);
});

test("trade price: a sell's value goes by the amount net of a fee in the asset sold", () => {
  const r = sellRow({ baseAmount: "9.5", feeCurrency: "RUNE", feeAmount: "0.5" });
  const [base, quote, fee] = legsOf(r, { price: 3, quantity: 10 });
  const at = (price: number, source = "unknown") => [base, { ...quote, price, currencySource: source }, fee];
  // Equal to Summ's net value: nothing, though price x gross differs
  const equal = at((9.5 * 3) / 4);
  const clean = plan({ rows: [r], legs: equal, applyLog: standing(equal) }).plan;
  assert.deepEqual([clean.edit, clean.held], [[], []]);
  const parted = at(7.5);
  assert.equal(
    plan({ rows: [r], legs: parted, applyLog: standing(parted) }).plan.edit[0].match?.desired,
    (9.5 * 3) / 4,
  );
  // The same on a held sell, and a fee in another currency takes nothing off
  const known = at((9.5 * 3) / 4, "coingecko");
  assert.deepEqual(plan({ rows: [r], legs: known, applyLog: standing(known) }).plan.held, []);
  const other = sellRow({ feeCurrency: "BTC", feeAmount: "0.5" });
  const [b, q, f] = legsOf(other, { price: 3 });
  const legs = [b, { ...q, price: 7.5, currencySource: "unknown" }, f];
  assert.deepEqual(plan({ rows: [other], legs, applyLog: standing(legs) }).plan.edit, []);
});

test("trade price: a difference beyond a float's noise is parted, however small", () => {
  const r = sellRow();
  const at = (price: number) => {
    const legs = sellLegs(r, "unknown", { price });
    return plan({ rows: [r], legs, applyLog: standing(legs) }).plan.edit.length;
  };
  assert.equal(at(7.5 * (1 + 1e-10)), 0);
  assert.equal(at(7.5 * (1 + 1e-7)), 1);
  assert.equal(at(7.5 * 1.0005), 1);
});

test("import price: price alone is planned once categorised, and nothing once it stands", () => {
  const r = swapRow({ feeCurrency: "", feeAmount: "" });
  const leg = ownLeg({ quantity: 0.01, trade: "bridgeTradeOut", price: 90000 });
  const { categorise } = plan({ rows: [r], legs: [leg] }).plan;
  assert.deepEqual(
    categorise[0].changes.map((c) => c.field),
    ["price"],
  );
  const { plan: after } = plan({
    rows: [r],
    legs: [{ ...leg, price: 91000 }],
    applyLog: priceLine(leg.legId, 60000, 91000),
    history: new Map([["l1", [USER_PRICE]]]),
  });
  assert.ok(empty(after), JSON.stringify(after, null, 1));
});

test("import price: Summ's own import leg is not an upload, whatever a plan's file says", () => {
  const r = swapRow({ feeCurrency: "", feeAmount: "" });
  const leg = {
    ...ownLeg({ quantity: 0.01, trade: "bridgeTradeOut", price: 90000 }),
    createdAt: "2026-02-01T00:00:00Z",
  };
  const uploadFiles = new Map([[r.id, [{ planTime: Date.parse("2026-01-01T00:00:00Z"), price: 60000 }]]]);
  assert.deepEqual(
    plan({ rows: [r], legs: [leg], uploadFiles }).plan.categorise[0].changes.map((c) => c.field),
    ["price"],
  );
});

test("import price: other categorised rows, and rows with no price, stay at market", () => {
  for (const type of ["send", "add-liquidity", "bridge-in", "bridge-out", "buy", "sell"]) {
    const r = swapRow({ type, feeCurrency: "", feeAmount: "" });
    const leg = ownLeg({ quantity: 0.01, trade: (summType(type) as { trade: string }).trade, price: 90000 });
    assert.deepEqual(plan({ rows: [r], legs: [leg] }).plan.categorise, [], type);
  }
  const blank = swapRow({ referencePrice: "", referencePriceCurrency: "", feeCurrency: "", feeAmount: "" });
  const leg = ownLeg({ quantity: 0.01, trade: "bridgeTradeOut", price: 90000 });
  assert.deepEqual(plan({ rows: [blank], legs: [leg] }).plan.categorise, []);
});

test("import price: a user's price is captured and kept; a filed row is an amendment; a held row is held", () => {
  const r = swapRow({ feeCurrency: "", feeAmount: "" });
  const leg = ownLeg({ quantity: 0.01, trade: "bridgeTradeOut", price: 90000 });
  const drift = plan({ rows: [r], legs: [leg], history: new Map([["l1", [USER_PRICE]]]) }).plan;
  assert.deepEqual(drift.categorise, []);
  assert.deepEqual(
    drift.overridden.map((o) => [o.kind, o.override.field, o.override.leg]),
    [["captured", "price", "base"]],
  );
  const kept = plan({ rows: [r], legs: [leg], overrides: [priceOverride(r, "yes", 90000)] }).plan;
  assert.deepEqual(kept.categorise, []);
  const filed = plan({ rows: [r], legs: [leg], config: { ...CONFIG, filedBefore: "2024-07-01" } }).plan;
  assert.equal(filed.categorise[0].filed, true);
  const held = plan({ rows: [r], legs: [leg], config: { ...CONFIG, hold: [{ id: r.id, reason: "x" }] } }).plan;
  assert.deepEqual(held.categorise, []);
  assert.match(held.held[0].held.join(), /price 90000 -> 60000/);
});

test("an older leg with no currency source reads as none, and legsOf reads the source Summ gives", () => {
  const detail = (identifier: unknown) =>
    legsOfDetail({
      action: { _id: "a", incoming: [{ _id: "l", quantity: 1, currencyIdentifier: identifier }] },
      history: [],
    })[0].currencySource;
  assert.equal(detail({ symbol: "X", source: "unknown" }), "unknown");
  assert.equal(detail({ symbol: "X" }), undefined);
  assert.equal(detail(undefined), undefined);
});

test("a delete names its legs' values, the legs beside them, and its row's txids; an edit its row's txids", () => {
  const r = row();
  const legs = legsOf(row({ feeCurrency: "RUNE", feeAmount: "0.02" }));
  const fee = legs.find((l) => l.side === "fees") as Leg;
  const other = legs.find((l) => l !== fee) as Leg;
  const d = plan({ rows: [r], legs }).plan.delete[0];
  assert.deepEqual(
    d.legs?.map((l) => [l.legId, l.currency, l.quantity, l.trade, l.source, l.importType, l.timestamp]),
    [[fee.legId, fee.currency, fee.quantity, fee.trade, fee.source, fee.importType, fee.timestamp]],
  );
  assert.deepEqual(
    d.others?.map((l) => l.legId),
    [other.legId],
  );
  assert.deepEqual(d.txids, r.txids);
});

test("legs with no row whose txid a manual entry names are held, as apply would stop on them", () => {
  const gone = legsOf(row());
  const named = { ...gone[0], description: `${TX1}` };
  const manual = ownLeg({ importType: "manual", source: "manual", id: "x-manual", comments: [`see ${TX1}`] });
  const { plan: p } = plan({ rows: [], legs: [named, manual] });
  assert.deepEqual(p.delete, []);
  assert.deepEqual(
    p.held.map((h) => h.kind),
    ["manual-pairing"],
  );
});

test("a manual entry linked only by its Tx Hash holds the row's event", () => {
  const r = row({ description: "changed" });
  const manual = ownLeg({ importType: "manual", source: "manual", id: `0x${TX1}` });
  const { plan: p } = plan({ rows: [{ ...r, txids: [TX1] }], legs: [manual] });
  assert.deepEqual([p.upload, p.report.map((x) => x.kind)], [[], ["manual-entry"]]);
  assert.equal(p.held[0].kind, "manual-pairing");
});

test("deleteManualEntries: a named entry is planned first, with its values, and no longer holds its event", () => {
  const r = btcRow({ type: "bridge-trade-in", feeCurrency: "", feeAmount: "" });
  const own = ownLeg({ legId: "own", quantity: 0.01, trade: "deposit", side: "incoming", actionId: "act" });
  const manual = ownLeg({
    legId: "man",
    quantity: 0.01,
    trade: "withdrawal",
    side: "outgoing",
    actionId: "act",
    importType: "manual",
    source: "manual",
    id: "hand",
  });
  const held = plan({ rows: [r], legs: [own, manual] }).plan;
  assert.equal(held.delete.length, 0);
  assert.equal(held.held[0].kind, "manual-pairing");
  const deleteManualEntries = [{ legId: "man", currency: "BTC", quantity: 0.01, reason: "stood in for the swap" }];
  const named = plan({ rows: [r], legs: [own, manual], config: { ...CONFIG, deleteManualEntries } }).plan;
  assert.deepEqual(named.held, []);
  assert.equal(named.delete[0].manual, true);
  assert.deepEqual(named.delete[0].legIds, ["man"]);
  assert.match(named.delete[0].reason, /manual entry: stood in for the swap/);
  assert.deepEqual(
    named.delete[0].others?.map((l) => l.legId),
    ["own"],
  );
  // Another manual entry in the action still holds it
  const other = { ...manual, legId: "man2", id: "hand2" };
  assert.equal(
    plan({ rows: [r], legs: [own, manual, other], config: { ...CONFIG, deleteManualEntries } }).plan.held[0].kind,
    "manual-pairing",
  );
});

test("deleteManualEntries: a wrong entry stops the plan, and one already gone is noted", () => {
  const manual = ownLeg({ legId: "man", quantity: 1, importType: "manual", source: "manual", id: "hand" });
  const entry = { legId: "man", currency: "BTC", quantity: 1, reason: "why" };
  const run = (legs: Leg[], over = {}) =>
    plan({ rows: [], legs, config: { ...CONFIG, deleteManualEntries: [{ ...entry, ...over }] } }).plan;
  assert.throws(() => run([manual], { quantity: 2 }), /config says 2/);
  assert.throws(() => run([manual], { currency: "ETH" }), /config says 1 ETH/);
  assert.throws(() => run([{ ...manual, importType: "wallet" }]), /not a manual entry/);
  assert.match(run([]).notes.join(), /leg man is not in the snapshot/);
});

test("deleteManualEntries: a scoped plan keeps a named entry whatever the scope says", () => {
  const manual = ownLeg({ legId: "man", quantity: 1, importType: "manual", source: "manual", id: "hand" });
  const deleteManualEntries = [{ legId: "man", currency: "BTC", quantity: 1, reason: "why" }];
  const p = plan({
    rows: [],
    legs: [manual],
    config: { ...CONFIG, deleteManualEntries },
    scope: ["nothing-like-it"],
  }).plan;
  assert.deepEqual(
    p.delete.map((d) => d.legIds),
    [["man"]],
  );
});

test("deleteManualEntries: an entry that cannot go excuses nothing: its event stays held, nothing is uploaded", () => {
  const r = row({ txids: [TX1] });
  const hand = (legId: string, id: string, over: Partial<Leg> = {}) =>
    ownLeg({ legId, quantity: 1, importType: "manual", source: "manual", id, actionId: "hand", ...over });
  const naming = { comments: [TX1] };
  const deleteManualEntries = [{ legId: "m1", currency: "BTC", quantity: 1, reason: "why" }];
  const config = { ...CONFIG, deleteManualEntries };
  // Another manual entry beside it
  const beside = plan({ rows: [r], legs: [hand("m1", "h1", naming), hand("m2", "h2")], config }).plan;
  assert.deepEqual(beside.delete, []);
  assert.deepEqual(beside.upload, []);
  assert.ok(beside.held.some((h) => h.id === null && /another manual entry/.test(h.reason)));
  assert.ok(beside.held.some((h) => h.id === r.id));
  // The control: with only the named entry, the event goes ahead
  const alone = plan({ rows: [r], legs: [hand("m1", "h1", naming)], config }).plan;
  assert.equal(alone.delete[0].manual, true);
  assert.equal(alone.upload.length, 1);
  // A hold on its txid
  const onHold = plan({
    rows: [r],
    legs: [hand("m1", "h1", naming)],
    config: { ...config, hold: [{ txid: TX1, reason: "pending" }] },
  }).plan;
  assert.deepEqual(onHold.delete, []);
  assert.deepEqual(onHold.upload, []);
});

test("deleteManualEntries: filed if any leg is, its comment's txid is checked, and no report repeats it", () => {
  const legs = [
    ownLeg({
      legId: "a",
      quantity: 1,
      importType: "manual",
      source: "manual",
      id: "h",
      actionId: "x",
      comments: [TX1],
    }),
    ownLeg({
      legId: "b",
      quantity: 1,
      importType: "manual",
      source: "manual",
      id: "h",
      actionId: "x",
      timestamp: "2019-01-01T00:00:00.000Z",
    }),
  ];
  const deleteManualEntries = ["a", "b"].map((legId) => ({ legId, currency: "BTC", quantity: 1, reason: "why" }));
  const p = plan({ legs, config: { ...CONFIG, filedBefore: "2020-01-01", deleteManualEntries } }).plan;
  assert.equal(p.delete[0].filed, true);
  assert.deepEqual(p.delete[0].txids, [TX1]);
  assert.deepEqual(p.report, []);
});

test("deleteManualEntries: another manual entry naming its tx holds it, as does a hold on a row of its tx", () => {
  const hand = (legId: string, actionId: string, comments: string[]) =>
    ownLeg({ legId, quantity: 1, importType: "manual", source: "manual", id: legId, actionId, comments });
  const one = row({ txids: [TX1] });
  const two = row({ txids: [TX2] });
  const config = {
    ...CONFIG,
    deleteManualEntries: [{ legId: "m1", currency: "BTC", quantity: 1, reason: "why" }],
  };
  const p = plan({
    rows: [one, two],
    legs: [hand("m1", "a", [TX1, TX2]), hand("m2", "b", [TX1])],
    config,
  }).plan;
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.upload, []);
  const held = plan({
    rows: [two],
    legs: [hand("m1", "a", [TX2])],
    config: { ...config, hold: [{ id: two.id, reason: "pending" }] },
  }).plan;
  assert.deepEqual(held.delete, []);
});

test("deleteManualEntries: filed and current-year entries are refused together, and named ones come first", () => {
  const hand = (legId: string, timestamp: string) =>
    ownLeg({ legId, quantity: 1, importType: "manual", source: "manual", id: legId, actionId: legId, timestamp });
  const entry = (legId: string) => ({ legId, currency: "BTC", quantity: 1, reason: "why" });
  const config = { ...CONFIG, filedBefore: "2020-01-01", deleteManualEntries: [entry("old"), entry("new")] };
  assert.throws(
    () =>
      plan({
        legs: [hand("old", "2019-01-01T00:00:00.000Z"), hand("new", "2024-03-01T00:00:00.000Z")],
        config,
      }),
    /both filed and current-year/,
  );
  const stable = "2024-03-01T10:00:00.000Z.out.abcdef012345";
  const p = plan({
    legs: [
      hand("new", "2024-03-01T00:00:00.000Z"),
      ownLeg({ legId: "gone", source: "csv-source", importType: "manual-csv", id: stable, actionId: "c" }),
    ],
    config: { ...config, deleteManualEntries: [entry("new")] },
  }).plan;
  assert.deepEqual(
    p.delete.map((d) => d.legIds[0]),
    ["new", "gone"],
  );
});

test("deleteManualEntries: the matcher's history warns, and a going entry repeats no report", () => {
  const r = row({ txids: [TX1] });
  const leg = ownLeg({
    legId: "m",
    quantity: 1,
    importType: "manual",
    source: "manual",
    id: "m",
    actionId: "a",
    comments: [TX1],
  });
  const config = {
    ...CONFIG,
    deleteManualEntries: [{ legId: "m", currency: "BTC", quantity: 1, reason: "why" }],
  };
  const p = plan({
    rows: [r],
    legs: [leg],
    config,
    history: new Map([["a", ["1 Jan 2024 00:00 · transactionMatching · Category: x"]]]),
  }).plan;
  assert.match(p.delete[0].reason, /may be guarding a pairing/);
  assert.deepEqual(
    p.report.filter((e) => e.kind === "manual-entry"),
    [],
  );
});

test("deleteManualEntries: one entry that cannot go keeps them all; two that share a tx and can go, go", () => {
  const hand = (legId: string, comments: string[]) =>
    ownLeg({ legId, quantity: 1, importType: "manual", source: "manual", id: legId, actionId: legId, comments });
  const entry = (legId: string) => ({ legId, currency: "BTC", quantity: 1, reason: "why" });
  const rows = [row({ txids: [TX1] }), row({ txids: [TX2] })];
  const named = { ...CONFIG, deleteManualEntries: [entry("m1"), entry("m2")] };
  const TX3 = "3".repeat(64);
  const blocked = plan({
    rows,
    legs: [hand("m1", [TX1]), hand("m2", [TX1, TX2]), hand("m3", [TX2])],
    config: named,
  }).plan;
  assert.deepEqual(blocked.delete, []);
  assert.deepEqual(blocked.upload, []);
  assert.ok(blocked.held.some((h) => h.legIds[0] === "m1" && /none goes until it can/.test(h.reason)));
  const going = plan({ rows, legs: [hand("m1", [TX1, TX3]), hand("m2", [TX1, TX2])], config: named }).plan;
  assert.deepEqual(
    going.delete.map((d) => d.legIds[0]),
    ["m1", "m2"],
  );
  assert.equal(going.upload.length, 1);
});

test("deleteManualEntries: a hold on an unmanaged row of its tx, or on its own ID, holds it", () => {
  const r = btcRow({ txids: [TX1] });
  const leg = ownLeg({
    legId: "m",
    quantity: 1,
    importType: "manual",
    source: "manual",
    id: "own",
    actionId: "a",
    comments: [TX1],
  });
  const deleteManualEntries = [{ legId: "m", currency: "BTC", quantity: 1, reason: "why" }];
  for (const id of [r.id, "own"]) {
    const p = plan({
      rows: [r],
      legs: [leg],
      config: { ...CONFIG, deleteManualEntries, hold: [{ id, reason: "pending" }] },
    }).plan;
    assert.deepEqual(p.delete, []);
  }
});
