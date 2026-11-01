import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, type Config } from "../src/config.ts";
import { makePlan, type PlanInput } from "../src/plan.ts";
import type { Row, RunFile } from "../src/run.ts";
import type { Leg } from "../src/snapshot.ts";
import { decisionLines } from "../src/decisions.ts";

// Every value below is made up. One swap: AAA -> BBB through a pool, ending in TKN, which an old CSV recorded as far as
// BBB, with the user's manual BBB -> TKN trade and a manual send paired with the wallet's TKN receive.
const PERIOD = { from: "2023-07-01", to: "2024-06-30" };
const THOR_FILE = "2023-07-01_2024-06-30_THOR_abcde_Example.csv";
const FILES: RunFile[] = [
  { name: THOR_FILE, chain: "THOR", period: PERIOD, header: "HEADER" },
  { name: "2023-07-01_2024-06-30_BTC_fghij_Example.csv", chain: "BTC", period: PERIOD, header: "HEADER" },
];
const CONFIG: Config = { ...DEFAULTS, managedSources: ["csv-source"] };
const IN_TX = "1".repeat(64);
const OUT_TX = "2".repeat(64);
const T = "2024-03-01T10:00:";

let next = 0;
const leg = (over: Partial<Leg>): Leg => ({
  legId: `leg${++next}`,
  actionId: `action${next}`,
  side: "outgoing",
  id: "",
  trade: "withdrawal",
  currency: "AAA",
  quantity: 100,
  timestamp: `${T}00.000Z`,
  from: "a",
  to: "b",
  blockchain: "thorchain",
  description: "",
  source: "csv-source",
  importType: "manual-csv",
  comments: [],
  ...over,
});

function oldLegs(): Leg[] {
  const swap = "action-old-swap";
  return [
    // The send adopts the run's row, as a wallet's old send does: the trade is left with no row
    leg({ id: "old.csv:1", timestamp: `${T}00.000Z` }),
    leg({ id: "old.csv:2", actionId: swap, trade: "sell", timestamp: `${T}10.000Z` }),
    leg({
      id: "old.csv:2",
      actionId: swap,
      side: "incoming",
      trade: "buy",
      currency: "BBB",
      quantity: 2,
      timestamp: `${T}10.000Z`,
    }),
    leg({ id: "old.csv:3", currency: "BBB", quantity: 2, timestamp: `${T}20.000Z` }),
  ];
}

function manualLegs(): { trade: Leg[]; send: Leg; receive: Leg } {
  const manual = { source: "manual", importType: "manual" };
  const trade = [
    leg({ ...manual, id: "m-trade", actionId: "action-m", trade: "sell", currency: "BBB", quantity: 2 }),
    leg({
      ...manual,
      id: "m-trade",
      actionId: "action-m",
      side: "incoming",
      trade: "buy",
      currency: "TKN",
      quantity: 50,
    }),
  ].map((l) => ({ ...l, timestamp: `${T}50.000Z` }));
  const paired = "action-pair";
  const send = leg({
    ...manual,
    id: "m-send",
    actionId: paired,
    currency: "TKN",
    quantity: 50,
    timestamp: `${T}51.000Z`,
    comments: [`the swap: ${OUT_TX}`],
  });
  const receive = leg({
    source: "wallet",
    importType: "wallet",
    id: OUT_TX,
    actionId: paired,
    side: "incoming",
    trade: "deposit",
    currency: "TKN",
    quantity: 50,
    timestamp: `${T}51.000Z`,
    blockchain: "btc",
  });
  return { trade, send, receive };
}

function rowOf(over: Partial<Row>): Row {
  const r: Row = {
    file: THOR_FILE,
    chain: "THOR",
    line: "",
    id: "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa",
    timestamp: `${T}00.000Z`,
    type: "bridge-trade-out",
    baseCurrency: "AAA",
    baseAmount: "100",
    quoteCurrency: "TKN",
    quoteAmount: "50",
    feeCurrency: "",
    feeAmount: "",
    from: "a",
    to: "b",
    blockchain: "THORChain",
    description: `Swap; ${IN_TX}`,
    txids: [IN_TX],
    ...over,
  };
  r.line = `${r.timestamp},${r.type},${r.id}`;
  return r;
}

const outRow = (over: Partial<Row> = {}) => rowOf(over);
const inRow = (over: Partial<Row> = {}) =>
  rowOf({
    file: FILES[1].name,
    chain: "BTC",
    id: "2024-03-01T10:00:00.000Z.in.bbbbbbbbbbbb",
    type: "bridge-trade-in",
    baseCurrency: "TKN",
    baseAmount: "50",
    quoteCurrency: "",
    quoteAmount: "",
    blockchain: "BTC",
    txids: [IN_TX, OUT_TX],
    ...over,
  });

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
  }).plan;
}

function swapChanged() {
  const m = manualLegs();
  return {
    rows: [outRow(), inRow()],
    legs: [...oldLegs(), ...m.trade, m.send, m.receive],
    m,
  };
}

test("a swap whose run asset changed: the plan names what its deletes leave, with what to do about it", () => {
  const { rows, legs, m } = swapChanged();
  const p = plan({ rows, legs });
  // The plan itself is as it was: rows held, old lines deleted
  assert.deepEqual(p.delete.map((d) => d.summId).sort(), ["old.csv:2", "old.csv:3"]);
  assert.deepEqual(p.upload, []);
  assert.equal(p.decisions?.length, 1);
  const d = p.decisions![0];
  assert.equal(d.kind, "swap-changed");
  assert.match(d.title, /2024-03-01: a swap changed from BBB to TKN/);
  const text = d.lines.join("\n");
  assert.match(text, /Summ: 100 AAA -> 2 BBB \(`old\.csv:2`\)\. The run: 100 AAA -> 50 TKN/);
  assert.match(text, /Disposal removed, nothing adds it back: sell 100 AAA/);
  assert.match(text, /Acquisition removed, nothing adds it back: buy 2 BBB/);
  assert.match(text, new RegExp(`Left behind: manual sell 2 BBB \\(leg \`${m.trade[0].legId}\`\\)`));
  assert.match(
    text,
    /Rows held, so not uploaded: .*These deletes still go: `old\.csv:2`, `old\.csv:3`|`old\.csv:3`, `old\.csv:2`/,
  );
  const [a, b] = d.options;
  assert.deepEqual(
    a.config.deleteManualEntries?.map((e) => e.legId).sort(),
    [m.trade[0].legId, m.trade[1].legId, m.send.legId].sort(),
  );
  assert.deepEqual(b.config.hold?.map((h) => h.id).sort(), ["old.csv:2", "old.csv:3"]);
});

test("option a: the entries go with the old lines, the rows go ahead, and nothing is left to decide", () => {
  const { rows, legs } = swapChanged();
  const first = plan({ rows, legs }).decisions![0].options[0].config;
  const p = plan({ rows, legs, config: { ...CONFIG, deleteManualEntries: first.deleteManualEntries! } });
  assert.equal(p.decisions, undefined);
  assert.equal(p.held.length, 0);
  assert.equal(p.delete.filter((d) => d.manual).length, 2);
  assert.deepEqual(
    p.delete
      .filter((d) => !d.manual)
      .map((d) => d.summId)
      .sort(),
    ["old.csv:2", "old.csv:3"],
  );
});

test("option b: the old lines stay, and nothing is left to decide", () => {
  const { rows, legs } = swapChanged();
  const hold = plan({ rows, legs }).decisions![0].options[1].config.hold!;
  const p = plan({ rows, legs, config: { ...CONFIG, hold } });
  assert.equal(p.decisions, undefined);
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.upload, []);
});

test("naming only the send leaves the trade: the row and the kept buy acquire the same thing", () => {
  const { rows, legs, m } = swapChanged();
  const deleteManualEntries = [{ legId: m.send.legId, currency: "TKN", quantity: 50, reason: "x" }];
  const p = plan({ rows, legs, config: { ...CONFIG, deleteManualEntries } });
  const d = p.decisions![0];
  assert.match(d.lines.join("\n"), /Acquired twice: row `.*\.in\.bbbbbbbbbbbb` adds 50 TKN, and manual buy 50 TKN/);
  assert.match(d.lines.join("\n"), /Left behind: manual sell 2 BBB/);
});

test("a run that keeps the asset but has no leg for it: a bridge's quote only names the asset, so it adds nothing back", () => {
  const manual = { source: "manual", importType: "manual" };
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: `${T}50.000Z`,
  });
  const r = outRow({ quoteCurrency: "BBB", quoteAmount: "2", description: "Swap", txids: ["3".repeat(64)] });
  const p = plan({ rows: [r], legs: [...oldLegs(), sell] });
  assert.equal(p.decisions?.length, 1);
  const d = p.decisions![0];
  assert.equal(d.kind, "lost-acquisition");
  assert.match(d.title, /an acquisition of BBB is removed and sent on/);
  assert.match(d.lines.join("\n"), /Left behind: manual sell 2 BBB/);
  assert.deepEqual(
    d.options[0].config.deleteManualEntries?.map((e) => e.legId),
    [sell.legId],
  );
});

test("an old trade the run replaces whole, or under another ticker, or a fee apart, asks nothing", () => {
  const buy = (over: Partial<Row>) =>
    rowOf({
      id: "2024-03-01T10:00:00.000Z.out.cccccccccccc",
      type: "sell",
      quoteCurrency: "BBB",
      quoteAmount: "2",
      ...over,
    });
  const sold = oldLegs()
    .slice(1, 3)
    .map((l) => ({ ...l, from: "another", to: "another" }));
  const later = { timestamp: "2024-03-01T10:04:00.000Z", id: "2024-03-01T10:04:00.000Z.out.cccccccccccc" };
  for (const r of [
    buy({ ...later }),
    buy({ ...later, quoteCurrency: "Renamed.BBB" }),
    buy({ ...later, baseAmount: "99.99" }),
  ]) {
    const p = plan({ rows: [r], legs: sold });
    assert.equal(p.delete.length, 1, r.quoteCurrency);
    assert.equal(p.decisions, undefined, `${r.quoteCurrency} ${r.baseAmount}: ${JSON.stringify(p.decisions)}`);
  }
});

test("a disposal removed with no row asks, and offers to go ahead when no manual entry is involved", () => {
  const p = plan({ legs: oldLegs().slice(1, 3) });
  const d = p.decisions![0];
  assert.equal(d.kind, "lost-disposal");
  assert.deepEqual(d.options[0].config, {});
  assert.deepEqual(
    d.options[1].config.hold?.map((h) => h.id),
    ["old.csv:2"],
  );
});

test("a plain transfer removed asks nothing; an ignored or made-up leg counts for nothing", () => {
  const legs = [
    leg({ id: "old.csv:5", actionId: "t", currency: "BBB", quantity: 2 }),
    leg({ id: "old.csv:5", actionId: "t", side: "incoming", trade: "deposit", currency: "BBB", quantity: 2 }),
  ];
  assert.equal(plan({ legs }).decisions, undefined);
  const manualIgnored = leg({
    source: "manual",
    importType: "manual",
    id: "m",
    trade: "ignoreOut",
    currency: "BBB",
    quantity: 2,
  });
  assert.equal(
    plan({ legs: [...oldLegs().slice(2, 3), manualIgnored] }).decisions?.[0]?.lines.some((l) =>
      l.includes("Left behind"),
    ),
    undefined,
  );
});

test("a receive beside a kept send is half of a transfer: it adds nothing back", () => {
  const manual = { source: "manual", importType: "manual" };
  const pair = "pair";
  const legs = [
    ...oldLegs().slice(1, 3),
    leg({
      source: "wallet",
      importType: "wallet",
      id: "w",
      actionId: pair,
      side: "incoming",
      trade: "deposit",
      currency: "BBB",
      quantity: 2,
      timestamp: `${T}30.000Z`,
    }),
    leg({ ...manual, id: "m", actionId: pair, currency: "BBB", quantity: 2, timestamp: `${T}30.000Z` }),
  ];
  const text = plan({ legs }).decisions![0].lines.join("\n");
  assert.match(text, /Acquisition removed, nothing adds it back: buy 2 BBB/);
  assert.match(text, /Left behind: manual withdrawal 2 BBB/);
});

test("a scoped plan counts only what it carries: a delete whose upload is outside the scope asks", () => {
  const r = rowOf({
    timestamp: "2024-03-01T10:04:00.000Z",
    id: "2024-03-01T10:04:00.000Z.out.cccccccccccc",
    type: "sell",
    quoteCurrency: "BBB",
    quoteAmount: "2",
    txids: ["4".repeat(64)],
  });
  const legs = oldLegs()
    .slice(1, 3)
    .map((l) => ({ ...l, from: "another", to: "another" }));
  const p = plan({ rows: [r], legs, scope: ["old.csv:2"] });
  assert.equal(p.delete.length, 1);
  assert.deepEqual(p.upload, []);
  assert.equal(p.decisions?.[0].kind, "lost-disposal");
});

test("what leaves after a removed acquisition is listed to check, when nothing links it but the asset", () => {
  const legs = [
    leg({ id: "old.csv:7", side: "incoming", trade: "buy", currency: "BBB", quantity: 2, actionId: "x" }),
    leg({
      source: "wallet",
      importType: "wallet",
      id: "w",
      actionId: "y",
      trade: "withdrawal",
      currency: "BBB",
      quantity: 1,
      timestamp: "2024-03-03T10:00:00.000Z",
    }),
    leg({
      source: "wallet",
      importType: "wallet",
      id: "w2",
      actionId: "z",
      trade: "withdrawal",
      currency: "BBB",
      quantity: 1,
      timestamp: "2024-03-20T10:00:00.000Z",
    }),
  ];
  const p = plan({ legs });
  const check = p.checks?.find((c) => c.summId === "old.csv:7");
  assert.equal(check?.removed, "buy 2 BBB");
  assert.equal(check?.kept.length, 1);
});

test("plan.md leads with the decisions, and says nothing with none", () => {
  const { rows, legs } = swapChanged();
  const p = plan({ rows, legs });
  const text = decisionLines(p.decisions!, p.checks ?? []).join("\n");
  assert.match(text, /^## Decisions \(1\)/);
  assert.match(text, /The plan does not stop on them/);
  assert.match(text, /### d1: 2024-03-01/);
  assert.match(text, /\*\*Option a: The run is right/);
  assert.match(text, /"deleteManualEntries"/);
  assert.match(text, /\*\*Option b: Keep what Summ has/);
  assert.match(text, /"hold"/);
  assert.deepEqual(decisionLines([], []), []);
  assert.equal(plan({ rows, legs }).counts.decisions, 1);
});
