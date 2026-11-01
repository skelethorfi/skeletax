import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, type Config } from "../src/config.ts";
import { makePlan, type PlanInput } from "../src/plan.ts";
import type { Row, RunFile } from "../src/run.ts";
import type { Leg } from "../src/snapshot.ts";
import { decisionLines } from "../src/decisions.ts";
import { renderPlan } from "../src/write-plan.ts";

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
  assert.match(d.key, /^2024-03-01-[0-9a-f]{6}$/);
  assert.equal(d.title, "a swap changed from BBB to TKN");
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
  assert.deepEqual(d.options[0].config, { accept: [{ key: d.key, reason: "<why>" }] });
  assert.deepEqual(d.options[2].config, {});
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

test("plan.md leads with the decisions, one entry a line, and says nothing with none", () => {
  const { rows, legs } = swapChanged();
  const p = plan({ rows, legs });
  const text = decisionLines(p.decisions!, p.checks ?? []).join("\n");
  assert.match(text, /^## Decisions \(1\)/);
  assert.match(text, /`apply --approve-deletes` refuses/);
  assert.match(text, /"accept": \[\{"key": "<its key>", "reason": "<why>"\}\]/);
  assert.match(text, /Legs are linked by currency, amount and time/);
  assert.match(text, /### 2024-03-01-[0-9a-f]{6}: a swap changed/);
  assert.match(text, /\*\*Option a: The run is right/);
  assert.match(text, /^"deleteManualEntries": \[$/m);
  assert.match(text, /^  \{"legId":"[^"]+","currency":"BBB","quantity":2,"reason":"<why>"\},$/m);
  assert.match(text, /\*\*Option b: Not yet: hold/);
  assert.match(text, /^"hold": \[$/m);
  assert.match(text, /\*\*Option c: Fix the run or Summ/);
  assert.deepEqual(decisionLines([], []), []);
  assert.equal(plan({ rows, legs }).counts.decisions, 1);
});

const manual = { source: "manual", importType: "manual" };
const at = (time: string) => `2024-03-01T${time}.000Z`;
const wallet = { from: "another", to: "another" };
const decided = (over: Partial<PlanInput>) => plan(over).decisions ?? [];
/** A removed trade selling AAA for BBB, in a wallet no row of these tests adopts. */
const oldTrade = () =>
  oldLegs()
    .slice(1, 3)
    .map((l) => ({ ...l, ...wallet }));
const soldBack = (over: Partial<Row>) =>
  rowOf({
    timestamp: at("10:04:00"),
    id: "2024-03-01T10:04:00.000Z.out.dddddddddddd",
    txids: ["5".repeat(64)],
    ...over,
  });

test("option a names a manual fee leg and an ignored leg of its action, or the plan would hold the entry", () => {
  const { rows, legs, m } = swapChanged();
  const fee = leg({
    ...manual,
    id: "m-trade",
    actionId: m.trade[0].actionId,
    side: "fees",
    trade: "fee",
    currency: "BBB",
    quantity: 0.1,
    timestamp: at("10:00:50"),
  });
  const ignored = leg({
    ...manual,
    id: "m-other",
    actionId: m.send.actionId,
    trade: "ignoreOut",
    currency: "TKN",
    quantity: 1,
    timestamp: at("10:00:51"),
  });
  const all = [...legs, fee, ignored];
  const entries = plan({ rows, legs: all }).decisions![0].options[0].config.deleteManualEntries!;
  assert.ok(entries.some((e) => e.legId === fee.legId));
  assert.ok(entries.some((e) => e.legId === ignored.legId));
  const next = plan({ rows, legs: all, config: { ...CONFIG, deleteManualEntries: entries } });
  assert.equal(next.decisions, undefined);
  assert.equal(next.held.length, 0);
});

test("a row adds back only what its type does: a send is no disposal, spam acquires nothing", () => {
  for (const r of [
    soldBack({ type: "send", quoteCurrency: "", quoteAmount: "" }),
    soldBack({ type: "failed-out", quoteCurrency: "", quoteAmount: "" }),
  ])
    assert.equal(decided({ rows: [r], legs: oldTrade() })[0]?.kind, "lost-disposal", r.type);
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const spam = soldBack({ type: "spam", baseCurrency: "BBB", baseAmount: "2", quoteCurrency: "", quoteAmount: "" });
  const fine = soldBack({ baseCurrency: "AAA", type: "sell", quoteCurrency: "CCC", quoteAmount: "7" });
  const d = decided({ rows: [spam, fine], legs: [...oldTrade(), sell] });
  assert.ok(d[0].lines.some((l) => l.startsWith("Left behind: manual sell 2 BBB")));
  const received = soldBack({
    type: "receive",
    baseCurrency: "BBB",
    baseAmount: "2",
    quoteCurrency: "",
    quoteAmount: "",
  });
  assert.ok(
    !decided({ rows: [received, fine], legs: [...oldTrade(), sell] }).some((x) =>
      x.lines.some((l) => l.includes("Left behind")),
    ),
  );
});

test("a kept leg adds back only what it counts as: lone spam no, a lone receive yes, a retained send no", () => {
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const lone = (trade: string) =>
    leg({
      source: "wallet",
      importType: "wallet",
      id: "w",
      actionId: "aw",
      side: "incoming",
      trade,
      currency: "BBB",
      quantity: 2,
      timestamp: at("10:00:30"),
    });
  const buy = oldTrade().find((l) => l.trade === "buy") as Leg;
  const only = [{ ...buy, actionId: "x" }];
  assert.ok(decided({ legs: [...only, sell, lone("spamIn")] })[0].lines.some((l) => l.includes("Left behind")));
  assert.equal(decided({ legs: [...only, sell, lone("deposit")] }).length, 0);
  assert.equal(decided({ legs: [...only, sell, lone("buy")] }).length, 0);
  // A made-up leg, or a fee, counts for nothing
  assert.ok(
    decided({ legs: [...only, sell, { ...lone("deposit"), importType: "soft-transfer" }] })[0].lines.some((l) =>
      l.includes("Left behind"),
    ),
  );
  const sold = oldTrade().filter((l) => l.trade === "sell");
  const keptSend = leg({
    source: "wallet",
    importType: "wallet",
    id: "s",
    actionId: "as",
    timestamp: at("10:00:30"),
    ...wallet,
  });
  assert.equal(decided({ legs: [...sold, keptSend] })[0]?.kind, "lost-disposal");
  const keptFee = { ...keptSend, side: "fees" as const, trade: "sell" };
  assert.equal(decided({ legs: [...sold, keptFee] })[0]?.kind, "lost-disposal");
  assert.equal(decided({ legs: [...sold, { ...keptSend, trade: "sell" }] }).length, 0);
});

test("the times: a removed acquisition is sent on from 5 minutes before to a day after", () => {
  const buy = {
    ...(oldTrade().find((l) => l.trade === "buy") as Leg),
    actionId: "x",
    timestamp: "2024-03-01T10:00:00.000Z",
  };
  const sell = (timestamp: string) =>
    leg({ ...manual, id: "m", actionId: "am", trade: "sell", currency: "BBB", quantity: 2, timestamp });
  const sent = (timestamp: string) =>
    decided({ legs: [buy, sell(timestamp)] }).some((d) => d.lines.some((l) => l.includes("Left behind")));
  assert.equal(sent("2024-03-01T09:55:00.000Z"), true);
  assert.equal(sent("2024-03-01T09:54:59.000Z"), false);
  assert.equal(sent("2024-03-02T10:00:00.000Z"), true);
  assert.equal(sent("2024-03-02T10:00:01.000Z"), false);
});

test("the amounts: a fee apart counts within 1% and 5 minutes, the same amount within a day", () => {
  const sold = oldTrade().filter((l) => l.trade === "sell");
  const row = (timestamp: string, baseAmount: string) =>
    soldBack({
      timestamp,
      id: `${timestamp}.out.eeeeeeeeeeee`,
      type: "sell",
      baseAmount,
      quoteCurrency: "CCC",
      quoteAmount: "7",
    });
  const asks = (r: Row) => decided({ rows: [r], legs: sold }).length > 0;
  assert.equal(asks(row(at("10:05:10"), "99")), false);
  assert.equal(asks(row(at("10:05:10"), "98.9")), true);
  assert.equal(asks(row(at("10:05:11"), "99")), true);
  assert.equal(asks(row("2024-03-02T10:00:10.000Z", "100")), false);
  assert.equal(asks(row("2024-03-02T10:00:11.000Z", "100")), true);
  // Another name counts only at the same amount and close by
  const named = (timestamp: string) => row(timestamp, "100");
  const renamed = (timestamp: string) => ({ ...named(timestamp), baseCurrency: "Renamed.AAA" });
  assert.equal(asks(renamed(at("10:05:10"))), false);
  assert.equal(asks(renamed(at("10:05:11"))), true);
});

test("option b also holds a row going ahead: else the old disposal stays and the row makes a second", () => {
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const r = soldBack({ timestamp: at("10:04:00"), type: "bridge-trade-out", quoteCurrency: "CCC", quoteAmount: "7" });
  const legs = [...oldTrade(), sell];
  const first = plan({ rows: [r], legs });
  assert.deepEqual(
    first.upload.flatMap((u) => u.ids),
    [r.id],
  );
  const hold = first.decisions![0].options[1].config.hold!;
  assert.ok(hold.some((h) => h.id === r.id));
  const next = plan({ rows: [r], legs, config: { ...CONFIG, hold } });
  assert.deepEqual(next.upload, []);
  assert.deepEqual(next.delete, []);
  assert.equal(next.decisions, undefined);
  assert.deepEqual(next.notes, []);
});

test("acquired twice needs a row that acquires, and a manual leg that does; its hold is the row", () => {
  const buy = leg({
    ...manual,
    id: "m",
    actionId: "am",
    side: "incoming",
    trade: "buy",
    currency: "TKN",
    quantity: 50,
    timestamp: at("10:01:00"),
  });
  const row = (type: string, timestamp = at("10:04:00")) =>
    soldBack({
      timestamp,
      type,
      baseCurrency: "TKN",
      baseAmount: "50",
      quoteCurrency: "",
      quoteAmount: "",
      id: `${timestamp}.in.ffffffffffff`,
    });
  assert.equal(decided({ rows: [row("receive")], legs: [buy] }).length, 0);
  const d = decided({ rows: [row("bridge-trade-in")], legs: [buy] })[0];
  assert.equal(d.kind, "acquired-twice");
  assert.equal(d.title, "TKN is acquired twice");
  assert.equal(d.options[1].config.hold?.length, 1);
  assert.equal(decided({ rows: [row("bridge-trade-in", "2024-03-02T10:01:00.000Z")], legs: [buy] }).length, 1);
  assert.equal(decided({ rows: [row("bridge-trade-in", "2024-03-02T10:01:01.000Z")], legs: [buy] }).length, 0);
  assert.equal(decided({ rows: [row("bridge-trade-in")], legs: [{ ...buy, trade: "deposit" }] }).length, 0);
});

test("a removed plain receive sent on is named as a receive", () => {
  const receive = leg({
    id: "old.csv:8",
    actionId: "x",
    side: "incoming",
    trade: "deposit",
    currency: "BBB",
    quantity: 2,
  });
  const send = leg({ ...manual, id: "m", actionId: "am", currency: "BBB", quantity: 2, timestamp: at("10:01:00") });
  const d = decided({ legs: [receive, send] })[0];
  assert.equal(d.kind, "lost-acquisition");
  assert.match(d.title, /a receive of BBB is removed and sent on/);
  assert.ok(d.lines.some((l) => l.startsWith("Receive removed")));
});

test("one amount does not swell a decision: a manual leg reaches no further by a day, and belongs to one decision", () => {
  const sold = oldTrade().filter((l) => l.trade === "sell");
  const buys = ["2024-03-01T20:00:00.000Z", "2024-03-02T16:00:00.000Z", "2024-03-03T12:00:00.000Z"].map(
    (timestamp, i) => leg({ ...manual, id: `m${i}`, actionId: `am${i}`, side: "incoming", trade: "buy", timestamp }),
  );
  const d = decided({ legs: [...sold, ...buys] });
  assert.deepEqual(
    d[0].options[0].config.deleteManualEntries?.map((e) => e.legId),
    [buys[0].legId],
  );
  // Two sells of one amount, far enough apart to be two decisions, and one manual leg between them
  const a = { ...sold[0], actionId: "a1", id: "old.csv:21", timestamp: "2024-03-01T10:00:00.000Z" };
  const b = { ...sold[0], legId: "other-leg", actionId: "a2", id: "old.csv:22", timestamp: "2024-03-01T20:00:00.000Z" };
  const shared = leg({
    ...manual,
    id: "s",
    actionId: "as",
    side: "incoming",
    trade: "buy",
    timestamp: "2024-03-01T15:00:00.000Z",
  });
  const both = decided({ legs: [a, b, shared] });
  const names = both.flatMap((x) => x.options[0].config.deleteManualEntries ?? []).map((e) => e.legId);
  assert.equal(names.length, new Set(names).size);
});

test("a retained type does not count as what the run has, and the decision says whose value it is", () => {
  const sold = oldTrade().filter((l) => l.trade === "sell");
  const r = rowOf({
    file: FILES[1].name,
    chain: "BTC",
    type: "bridge-trade-out",
    quoteCurrency: "",
    quoteAmount: "",
    timestamp: at("10:00:05"),
    id: "2024-03-01T10:00:05.000Z.out.abababababab",
    txids: [OUT_TX],
  });
  const walletSend = leg({
    source: "wallet",
    importType: "wallet",
    id: OUT_TX,
    actionId: "aw",
    timestamp: at("10:00:05"),
    blockchain: "btc",
  });
  const legs = [...sold, walletSend];
  // The categorise makes it a disposal, so the old sell has its replacement
  const ahead = plan({ rows: [r], legs });
  assert.ok(ahead.categorise.length);
  assert.equal(ahead.decisions, undefined);
  const overrides: PlanInput["overrides"] = [
    {
      id: r.id,
      leg: "base",
      field: "trade",
      run: "bridgeTradeOut",
      summ: "withdrawal",
      seenAt: "2024-07-01T00:00:00.000Z",
      reason: "x",
      retainUserEdit: "undecided",
    },
  ];
  const kept = plan({ rows: [r], legs, overrides });
  assert.equal(kept.categorise.length, 0);
  const text = kept.decisions![0].lines.join("\n");
  assert.match(text, /Your value stays on row `.*abababababab`: type withdrawal, where the run has bridgeTradeOut/);
});

test("filed: a decision is filed by the entries it names, and says when they span both", () => {
  const { rows, legs, m } = swapChanged();
  const filedBefore = "2024-03-01";
  const config = { ...CONFIG, filedBefore };
  assert.equal(plan({ rows, legs, config }).decisions![0].filed, false);
  assert.equal(plan({ rows, legs, config: { ...CONFIG, filedBefore: "2024-04-01" } }).decisions![0].filed, true);
  const earlier = { ...m.send, timestamp: "2024-02-29T23:00:00.000Z" };
  const spanning = plan({ rows, legs: legs.map((l) => (l === m.send ? earlier : l)), config }).decisions![0];
  assert.match(spanning.options[0].result, /span filed and current years/);
});

test("the checks: only what acquires, within a week after it, and not what a decision already covers", () => {
  const removed = (trade: string) =>
    leg({ id: "old.csv:7", side: "incoming", trade, currency: "BBB", quantity: 2, actionId: "x" });
  const out = (timestamp: string) =>
    leg({ source: "wallet", importType: "wallet", id: "w", actionId: "y", currency: "BBB", quantity: 1, timestamp });
  const has = (trade: string, timestamp: string) =>
    (plan({ legs: [removed(trade), out(timestamp)] }).checks ?? []).length === 1;
  assert.equal(has("buy", "2024-03-08T10:00:00.000Z"), true);
  assert.equal(has("buy", "2024-03-08T10:00:01.000Z"), false);
  assert.equal(has("buy", "2024-03-01T09:59:59.000Z"), false);
  assert.equal(has("deposit", "2024-03-02T10:00:00.000Z"), false);
  assert.equal(has("spamIn", "2024-03-02T10:00:00.000Z"), false);
});

test("the swap: another asset at another amount is a changed swap; the same amount or asset is not", () => {
  const { legs } = swapChanged();
  const kinds = (quoteCurrency: string, baseCurrency: string, baseAmount: string) =>
    plan({ rows: [outRow({ quoteCurrency }), inRow({ baseCurrency, baseAmount })], legs }).decisions?.[0]?.kind;
  assert.equal(kinds("TKN", "TKN", "50"), "swap-changed");
  assert.notEqual(kinds("BBB", "BBB", "3"), "swap-changed");
  assert.notEqual(kinds("TKN", "TKN", "2"), "swap-changed");
});

test("deletes naming a txid are not said to name none", () => {
  const { rows, legs } = swapChanged();
  assert.match(plan({ rows, legs }).decisions![0].lines.join("\n"), /they name no txid/);
  const named = legs.map((l) =>
    l.id === "old.csv:3" || l.id === "old.csv:2" ? { ...l, description: `${"6".repeat(64)}` } : l,
  );
  assert.doesNotMatch(plan({ rows, legs: named }).decisions![0].lines.join("\n"), /they name no txid/);
});

test("option b holds what a row a fee apart, under another ticker, or two txids away would add", () => {
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  for (const over of [{ baseAmount: "99.5" }, { baseCurrency: "Renamed.AAA" }]) {
    const r = soldBack({ type: "sell", quoteCurrency: "CCC", quoteAmount: "7", ...over });
    const legs = [...oldTrade(), sell];
    const hold = plan({ rows: [r], legs }).decisions![0].options[1].config.hold!;
    assert.ok(
      hold.some((h) => h.id === r.id),
      JSON.stringify(over),
    );
    assert.deepEqual(plan({ rows: [r], legs, config: { ...CONFIG, hold } }).upload, []);
  }
  const r1 = soldBack({ type: "bridge-trade-out", quoteCurrency: "CCC", quoteAmount: "7", txids: ["7".repeat(64)] });
  const r2 = soldBack({
    id: "2024-03-01T10:04:00.000Z.in.dddddddddd01",
    type: "receive",
    baseCurrency: "CCC",
    baseAmount: "7",
    quoteCurrency: "",
    quoteAmount: "",
    txids: ["7".repeat(64), "8".repeat(64)],
  });
  const r3 = soldBack({
    id: "2024-03-01T10:04:00.000Z.out.dddddddddd02",
    type: "sell",
    baseCurrency: "CCC",
    baseAmount: "7",
    quoteCurrency: "EEE",
    quoteAmount: "1",
    txids: ["8".repeat(64)],
  });
  const hold = plan({ rows: [r1, r2, r3], legs: [...oldTrade(), sell] }).decisions![0].options[1].config.hold!;
  for (const r of [r1, r2, r3])
    assert.ok(
      hold.some((h) => h.id === r.id),
      r.id,
    );
});

test("one row or kept leg adds back one removed leg", () => {
  const sold = oldTrade().filter((l) => l.trade === "sell");
  const twin = { ...sold[0], legId: "twin-leg", actionId: "twin", id: "old.csv:30" };
  const r = soldBack({ type: "sell", quoteCurrency: "CCC", quoteAmount: "7" });
  assert.equal(decided({ rows: [r], legs: sold }).length, 0);
  assert.equal(decided({ rows: [r], legs: [...sold, twin] }).length, 1);
  const keptSell = leg({
    source: "wallet",
    importType: "wallet",
    id: "k",
    actionId: "ak",
    trade: "sell",
    timestamp: at("10:00:30"),
    ...wallet,
  });
  assert.equal(decided({ legs: [...sold, keptSell] }).length, 0);
  assert.equal(decided({ legs: [...sold, twin, keptSell] }).length, 1);
});

test("what moves without being sold is no disposal, either way", () => {
  const sold = oldTrade().filter((l) => l.trade === "sell");
  for (const type of ["staking-deposit", "collateral-deposit", "open-position", "loan-repayment"]) {
    const r = soldBack({ type, quoteCurrency: "", quoteAmount: "" });
    assert.equal(decided({ rows: [r], legs: sold })[0]?.kind, "lost-disposal", type);
  }
  assert.equal(decided({ legs: [{ ...sold[0], trade: "stakingDeposit" }] }).length, 0);
});

test("a row's plain receive adds nothing back when a row going ahead sends the same", () => {
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const buy = { ...(oldTrade().find((l) => l.trade === "buy") as Leg), actionId: "x" };
  const received = soldBack({
    type: "receive",
    baseCurrency: "BBB",
    baseAmount: "2",
    quoteCurrency: "",
    quoteAmount: "",
  });
  const sent = soldBack({
    id: "2024-03-01T10:04:00.000Z.out.dddddddddd03",
    type: "send",
    baseCurrency: "BBB",
    baseAmount: "2",
    quoteCurrency: "",
    quoteAmount: "",
    txids: ["9".repeat(64)],
  });
  const leftBehind = (rows: Row[]) =>
    decided({ rows, legs: [buy, sell] }).some((d) => d.lines.some((l) => l.includes("Left behind")));
  assert.equal(leftBehind([received]), false);
  assert.equal(leftBehind([received, sent]), true);
});

test("a named manual buy with nothing to replace it is listed to check, and the text says what goes", () => {
  const buy = leg({
    ...manual,
    id: "m",
    actionId: "am",
    side: "incoming",
    trade: "buy",
    currency: "TKN",
    quantity: 50,
  });
  const sell = leg({
    source: "wallet",
    importType: "wallet",
    id: "w",
    actionId: "aw",
    trade: "sell",
    currency: "TKN",
    quantity: 50,
    timestamp: "2024-03-01T12:00:00.000Z",
  });
  const deleteManualEntries = [{ legId: buy.legId, currency: "TKN", quantity: 50, reason: "x" }];
  const p = plan({ legs: [buy, sell], config: { ...CONFIG, deleteManualEntries } });
  assert.equal(p.checks?.[0].removed, "buy 50 TKN");
  const m = leg({
    ...manual,
    id: "n",
    actionId: "an",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const d = plan({ legs: [...oldTrade(), m] }).decisions![0];
  assert.doesNotMatch(d.options[0].result, /goes ahead/);
  const named = plan({
    legs: [...oldTrade(), m],
    config: { ...CONFIG, deleteManualEntries: d.options[0].config.deleteManualEntries! },
  });
  assert.match(
    named.decisions![0].lines.join("\n"),
    /Already going, named in `deleteManualEntries`: manual sell 2 BBB/,
  );
});

test("acquired twice names what the row acquires, and a sell row's quote", () => {
  const buy = leg({
    ...manual,
    id: "m",
    actionId: "am",
    side: "incoming",
    trade: "buy",
    currency: "TKN",
    quantity: 50,
    timestamp: at("10:01:00"),
  });
  const r = soldBack({ type: "sell", quoteCurrency: "TKN", quoteAmount: "50" });
  assert.match(decided({ rows: [r], legs: [buy] })[0].lines.join("\n"), /adds 50 TKN, and manual buy 50 TKN/);
});

test("guards: a same-asset trade is no changed swap; a removed spam or ignored leg opens nothing; held rows' manual legs join", () => {
  const legs = oldTrade().map((l) => (l.trade === "buy" ? { ...l, currency: "AAA", quantity: 99 } : l));
  const r = outRow({ quoteCurrency: "ZZZ", txids: ["a".repeat(64)] });
  const z = inRow({ baseCurrency: "ZZZ", baseAmount: "5", txids: ["a".repeat(64)] });
  assert.notEqual(plan({ rows: [r, z], legs }).decisions?.[0]?.kind, "swap-changed");
  const out = leg({
    source: "wallet",
    importType: "wallet",
    id: "w",
    actionId: "aw",
    currency: "BBB",
    quantity: 1,
    timestamp: "2024-03-02T10:00:00.000Z",
  });
  for (const trade of ["spamIn", "ignoreIn"]) {
    const spam = leg({ id: "old.csv:40", actionId: "s", side: "incoming", trade, currency: "BBB", quantity: 2 });
    const sell = leg({
      ...manual,
      id: "m",
      actionId: "am",
      trade: "sell",
      currency: "BBB",
      quantity: 2,
      timestamp: at("10:00:50"),
    });
    assert.equal(plan({ legs: [spam, sell, out] }).decisions, undefined, trade);
  }
  const { rows, legs: all, m } = swapChanged();
  const names = plan({ rows, legs: all }).decisions![0].options[0].config.deleteManualEntries!.map((e) => e.legId);
  assert.ok(names.includes(m.send.legId));
});

test("a row's plain receive adds nothing back beside a kept send either, and what acquires claims first", () => {
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const buy = { ...(oldTrade().find((l) => l.trade === "buy") as Leg), actionId: "x" };
  const received = soldBack({
    type: "receive",
    baseCurrency: "BBB",
    baseAmount: "2",
    quoteCurrency: "",
    quoteAmount: "",
  });
  const keptSend = leg({
    source: "wallet",
    importType: "wallet",
    id: "w",
    actionId: "aw",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:03:00"),
  });
  const left = (legs: Leg[], rows: Row[]) =>
    decided({ rows, legs })
      .flatMap((d) => d.lines)
      .filter((l) => l.includes("Left behind"));
  assert.equal(left([buy, sell], [received]).length, 0);
  assert.equal(left([buy, sell, keptSend], [received]).length, 1);
  // One row, and a removed plain receive earlier than the buy: the buy takes the row
  const earlier = leg({
    id: "old.csv:50",
    actionId: "y",
    side: "incoming",
    trade: "deposit",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:01"),
  });
  const row = soldBack({ type: "sell", baseCurrency: "CCC", baseAmount: "7", quoteCurrency: "BBB", quoteAmount: "2" });
  const lines = decided({ rows: [row], legs: [earlier, buy] }).flatMap((d) => d.lines);
  assert.ok(!lines.some((l) => l.startsWith("Acquisition removed")));
});

test("a kept leg beside a row's receive goes by the type it ends up with", () => {
  const sell = leg({
    ...manual,
    id: "m",
    actionId: "am",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:00:50"),
  });
  const buy = { ...(oldTrade().find((l) => l.trade === "buy") as Leg), actionId: "x" };
  const received = soldBack({
    type: "receive",
    baseCurrency: "BBB",
    baseAmount: "2",
    quoteCurrency: "",
    quoteAmount: "",
  });
  const lost = leg({
    source: "wallet",
    importType: "wallet",
    id: OUT_TX,
    actionId: "aw",
    trade: "lost",
    currency: "BBB",
    quantity: 2,
    timestamp: at("10:03:00"),
    blockchain: "btc",
  });
  const r = rowOf({
    file: FILES[1].name,
    chain: "BTC",
    type: "send",
    baseCurrency: "BBB",
    baseAmount: "2",
    quoteCurrency: "",
    quoteAmount: "",
    timestamp: at("10:03:00"),
    id: "2024-03-01T10:03:00.000Z.out.acacacacacac",
    blockchain: "BTC",
    txids: [OUT_TX],
  });
  const p = plan({ rows: [received, r], legs: [buy, sell, lost] });
  assert.ok(p.categorise.length);
  assert.ok(p.decisions?.some((d) => d.lines.some((l) => l.includes("Left behind"))));
});

// A real config says why: what a test finishes before planning again
const finished = <T extends { reason: string }>(entries: T[]) => entries.map((e) => ({ ...e, reason: "checked" }));

test("a key stays with its event across plans, whatever else is decided and whatever else moves", () => {
  const first = swapChanged();
  const other = oldTrade()
    .filter((l) => l.trade === "sell")
    .map((l) => ({ ...l, id: "old.csv:60", actionId: "o", currency: "OTH", timestamp: "2024-02-01T10:00:00.000Z" }));
  const both = plan({ rows: first.rows, legs: [...first.legs, ...other] }).decisions!;
  assert.equal(both.length, 2);
  const swap = both.find((d) => d.kind === "swap-changed")!;
  const hold = both.find((d) => d.kind === "lost-disposal")!.options[1].config.hold!;
  // The earlier one closes; the later one keeps its key where a number would have moved
  const next = plan({ rows: first.rows, legs: [...first.legs, ...other], config: { ...CONFIG, hold } }).decisions!;
  assert.deepEqual(
    next.map((d) => d.key),
    [swap.key],
  );
  // The event changes: a new key
  const changed = first.legs.map((l) => (l.trade === "buy" && l.currency === "BBB" ? { ...l, quantity: 3 } : l));
  assert.notEqual(plan({ rows: first.rows, legs: changed }).decisions![0].key, swap.key);
});

test("accept closes a decision while its event is the same, lists it with the reason, and a stale one is noted", () => {
  const legs = oldLegs().slice(1, 3);
  const d = plan({ legs }).decisions![0];
  const accept = finished(d.options[0].config.accept!);
  const next = plan({ legs, config: { ...CONFIG, accept } });
  assert.equal(next.decisions, undefined);
  assert.equal(next.counts.decisions, undefined);
  assert.deepEqual(next.decided, [{ what: `accepted ${d.key}: ${d.title}`, reason: "checked" }]);
  assert.deepEqual(next.notes, []);
  assert.equal(next.delete.length, d.deletes.length ? next.delete.length : 0);
  const changed = legs.map((l) => (l.trade === "sell" ? { ...l, quantity: 101 } : l));
  const stale = plan({ legs: changed, config: { ...CONFIG, accept } });
  assert.equal(stale.decisions?.length, 1);
  assert.match(stale.notes.join(), new RegExp(`accept: ${d.key} matches no decision`));
  // A scope leaves other decisions out, so it says nothing of those
  assert.deepEqual(
    plan({ legs: changed, config: { ...CONFIG, accept }, scope: ["other.csv:1"] }).notes.filter((n) =>
      n.startsWith("accept"),
    ),
    [],
  );
});

test("what summ-sync.json has decided is listed with its reason, and shown after the decisions", () => {
  const { rows, legs, m } = swapChanged();
  const hold = [{ id: "kept.csv:1", reason: "not now" }];
  const deleteManualEntries = [{ legId: m.send.legId, currency: "TKN", quantity: 50, reason: "stood in" }];
  const p = plan({ rows, legs, config: { ...CONFIG, hold, deleteManualEntries } });
  assert.deepEqual(p.decided, [
    { what: `delete manual 50 TKN (leg ${m.send.legId})`, reason: "stood in" },
    { what: "hold kept.csv:1", reason: "not now" },
  ]);
  const text = decisionLines(p.decisions ?? [], p.checks ?? [], p.decided!).join("\n");
  assert.match(text, /## Decided \(2\)/);
  assert.match(text, /\| hold kept\.csv:1 \| not now \|/);
  assert.deepEqual(decisionLines([], [], p.decided!).slice(0, 1), ["## Decided (2)"]);
});

test("a decision shows its value, from what matters", () => {
  const legs = oldLegs()
    .slice(1, 3)
    .map((l) => ({ ...l, price: l.trade === "sell" ? 3 : 500 }));
  const d = plan({ legs }).decisions![0];
  assert.equal(d.value, 1000);
  assert.match(decisionLines([d], []).join("\n"), /, about 1,000 in Summ's currency/);
  assert.equal(plan({ legs: oldLegs().slice(1, 3) }).decisions![0].value, null);
});

test("a key changes with anything a row says, a leg's type, a fee leg, what is lost and what goes ahead", () => {
  const { rows, legs } = swapChanged();
  const key = (r: Row[], l: Leg[], config = CONFIG) => plan({ rows: r, legs: l, config }).decisions?.[0]?.key;
  const base = key(rows, legs);
  assert.equal(key([...rows].reverse(), [...legs].reverse()), base);
  const changed: [string, Row[]][] = [
    ["quote amount", [outRow({ quoteAmount: "51" }), inRow()]],
    ["quote currency", [outRow({ quoteCurrency: "OTH" }), inRow()]],
    ["base amount of the other row", [outRow(), inRow({ baseAmount: "51" })]],
    ["base currency", [outRow(), inRow({ baseCurrency: "OTH" })]],
    ["fee", [outRow({ feeCurrency: "AAA", feeAmount: "1" }), inRow()]],
    ["type", [outRow({ type: "sell" }), inRow()]],
  ];
  for (const [what, r] of changed) assert.notEqual(key(r, legs), base, what);
  assert.notEqual(
    key(
      rows,
      legs.map((l) => (l.id === "old.csv:3" ? { ...l, trade: "bridgeOut" } : l)),
    ),
    base,
    "trade",
  );
  const fee = leg({
    id: "old.csv:2",
    actionId: "action-old-swap",
    side: "fees",
    trade: "fee",
    currency: "BBB",
    quantity: 0.1,
    timestamp: `${T}10.000Z`,
  });
  assert.notEqual(key(rows, [...legs, fee]), base, "fee leg");
  // A row going ahead, then held: what it added back is lost, and what was read no longer holds
  const sold = oldLegs()
    .slice(1, 3)
    .map((l) => ({ ...l, from: "another", to: "another" }))
    .filter((l) => l.trade === "buy");
  const sell = leg({
    id: "old.csv:2",
    actionId: "action-old-swap",
    trade: "sell",
    from: "another",
    to: "another",
    timestamp: `${T}10.000Z`,
  });
  const r = soldBack({ type: "receive", baseCurrency: "BBB", baseAmount: "2", quoteCurrency: "", quoteAmount: "" });
  const going = plan({ rows: [r], legs: [...sold, sell] }).decisions![0].key;
  const heldRow = plan({
    rows: [r],
    legs: [...sold, sell],
    config: { ...CONFIG, hold: [{ id: r.id, reason: "held" }] },
  }).decisions![0].key;
  assert.notEqual(going, heldRow);
});

test("a key takes its event's first date, and option b's reason names it", () => {
  const legs = oldLegs().slice(1, 3);
  const later = leg({
    id: "old.csv:2",
    actionId: "action-old-swap",
    side: "incoming",
    trade: "buy",
    currency: "DDD",
    quantity: 1,
    timestamp: "2024-03-02T10:00:00.000Z",
  });
  const d = plan({ legs: [later, ...legs] }).decisions![0];
  assert.match(d.key, /^2024-03-01-/);
  assert.equal(d.options[1].config.hold?.[0].reason, `not yet: decision ${d.key}`);
});

test("a decision's value counts its manual legs, and plan.md lists what is decided", () => {
  const m = leg({
    ...manual,
    id: "n",
    actionId: "an",
    trade: "sell",
    currency: "BBB",
    quantity: 2,
    price: 900,
    timestamp: at("10:00:50"),
  });
  const legs = [...oldLegs().slice(1, 3), m];
  assert.equal(plan({ legs }).decisions![0].value, 1800);
  const p = plan({
    legs: oldLegs().slice(1, 3),
    config: { ...CONFIG, hold: [{ id: "kept.csv:1", reason: "not now" }] },
  });
  assert.match(renderPlan(p, "snap", "run"), /## Decided \(1\)/);
});
