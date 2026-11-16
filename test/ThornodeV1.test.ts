import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { atBlockTime, isNoopDeposit, toV1Tx, toViewblockTx } from "../src/sources/thorchain/ThornodeV1.ts";
import { type RawBundle, selectSends } from "../src/sources/RawBundle.ts";
import { runBundle } from "../src/pipeline/run.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import type { ViewblockTx } from "../src/sources/viewblock/index.ts";

const SIGNER = "thor1-v1-signer";
const RESERVE = "thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt";
const b64 = (text: string) => Buffer.from(text).toString("base64");
const attributes = (pairs: Record<string, string>, encode = false) =>
  Object.entries(pairs).map(([key, value]) => (encode ? { key: b64(key), value: b64(value) } : { key, value }));
const feeEvents = (encode = false) => [
  { type: "coin_spent", attributes: attributes({ spender: SIGNER, amount: "2000000rune" }, encode) },
  { type: "coin_received", attributes: attributes({ receiver: RESERVE, amount: "2000000rune" }, encode) },
  { type: "transfer", attributes: attributes({ recipient: RESERVE, sender: SIGNER, amount: "2000000rune" }, encode) },
  { type: "message", attributes: attributes({ sender: SIGNER }, encode) },
];

// The archive's answer for a MsgDeposit, as /cosmos/tx/v1beta1/txs lists it
const deposit = (hash: string, memo: string, events: any[], coins = [{ asset: "THOR.RUNE", amount: "0" }]) => ({
  txhash: hash,
  height: "12000000",
  timestamp: "2023-09-01T10:00:00Z",
  code: 0,
  tx: { body: { messages: [{ "@type": "/types.MsgDeposit", signer: SIGNER, memo, coins }] } },
  events: [{ type: "tx", attributes: [] }, ...events],
});

describe("toV1Tx", () => {
  test("reads the first message and decodes base64 events; drops the tx event", () => {
    const tx = toV1Tx(deposit("H1", "UNBOND:thor1-node:100", feeEvents(true)));
    assert.equal(tx.type, "MsgDeposit");
    assert.equal(tx.signer, SIGNER);
    assert.equal(tx.memo, "UNBOND:thor1-node:100");
    assert.equal(tx.height, 12000000);
    assert.deepEqual(
      tx.events.map((e) => e.type),
      ["coin_spent", "coin_received", "transfer", "message"],
    );
    assert.equal(tx.events[2].attributes.recipient, RESERVE);
  });

  test("reads a send's sender, recipient and coins", () => {
    const tx = toV1Tx({
      txhash: "H2",
      height: "12000000",
      timestamp: "2023-09-01T10:00:00Z",
      code: 0,
      tx: {
        body: {
          messages: [
            {
              "@type": "/cosmos.bank.v1beta1.MsgSend",
              from_address: SIGNER,
              to_address: "thor1-other",
              amount: [{ denom: "rune", amount: "500" }],
            },
          ],
        },
      },
      events: [],
    });
    assert.deepEqual(
      [tx.type, tx.signer, tx.to, tx.coins],
      ["MsgSend", SIGNER, "thor1-other", [{ asset: "RUNE", amount: "500" }]],
    );
    assert.deepEqual(toViewblockTx(tx).msgs[0].amount, [{ denom: "rune", amount: "500" }]);
  });
});

describe("isNoopDeposit", () => {
  test("a deposit whose only transfer is the native fee to the Reserve did nothing", () => {
    assert.equal(isNoopDeposit(toV1Tx(deposit("H1", "UNBOND:thor1-node:100", feeEvents()))), true);
  });

  test("a deposit with a THORChain event, another transfer or another fee did something", () => {
    const bond = { type: "bond", attributes: attributes({ amount: "100", bond_type: "bond_returned" }) };
    assert.equal(isNoopDeposit(toV1Tx(deposit("H1", "UNBOND:thor1-node:100", [...feeEvents(), bond]))), false);
    const payout = {
      type: "transfer",
      attributes: attributes({ recipient: SIGNER, sender: "thor1-module", amount: "100rune" }),
    };
    assert.equal(isNoopDeposit(toV1Tx(deposit("H1", "UNBOND:thor1-node:100", [...feeEvents(), payout]))), false);
    const higherFee = feeEvents().map((e) =>
      e.type === "transfer"
        ? { ...e, attributes: attributes({ recipient: RESERVE, sender: SIGNER, amount: "4000000rune" }) }
        : e,
    );
    assert.equal(isNoopDeposit(toV1Tx(deposit("H1", "UNBOND:thor1-node:100", higherFee))), false);
    assert.equal(isNoopDeposit({ ...toV1Tx(deposit("H1", "UNBOND", feeEvents())), code: 5 }), false);
  });
});

describe("toViewblockTx", () => {
  test("types a tx from its message and memo, and reads its outbounds", () => {
    const outbound = {
      type: "outbound",
      attributes: attributes({
        id: "0000000000000000000000000000000000000000000000000000000000000000",
        chain: "THOR",
        from: "thor1-module",
        to: SIGNER,
        coin: "4998000000 THOR.RUNE",
      }),
    };
    const withdraw = toViewblockTx(toV1Tx(deposit("W1", "-:BTC.BTC:10000", [...feeEvents(), outbound])));
    assert.deepEqual(withdraw.types, ["liquidity", "withdraw"]);
    assert.deepEqual(withdraw.outbounds, [
      {
        chain: "THOR",
        from: "thor1-module",
        to: SIGNER,
        amount: "4998000000",
        asset: "THOR.RUNE",
        timestamp: withdraw.timestamp,
      },
    ]);
    assert.deepEqual(
      toViewblockTx(toV1Tx(deposit("A1", "+:BTC.BTC", feeEvents(), [{ asset: "THOR.RUNE", amount: "5000000000" }])))
        .types,
      ["liquidity", "add"],
    );
    assert.deepEqual(toViewblockTx(toV1Tx(deposit("N1", "UNBOND:thor1-node:100", feeEvents()))).types, [
      "deposit",
      "noop",
    ]);
  });

  test("atBlockTime moves the tx and its outbounds to the block's time, to the millisecond", () => {
    const tx = toViewblockTx(
      toV1Tx(deposit("W1", "-:BTC.BTC:10000", [{ type: "outbound", attributes: attributes({ coin: "1 THOR.RUNE" }) }])),
    );
    atBlockTime(tx, Date.parse("2023-09-01T10:00:00.123456789Z"));
    assert.deepEqual([tx.timestamp, tx.outbounds?.[0].timestamp], [1693562400123, 1693562400123]);
  });
});

describe("selectSends with THORChain v1 txs", () => {
  const v1 = (data: any): RawBundle => ({
    source: "thornode-v1",
    protocol: "thorchain",
    wallet: SIGNER,
    data,
    thornodeTxs: [],
    cosmosTxs: [],
  });
  const noop = (hash: string, timestamp: string) => ({
    ...toViewblockTx(toV1Tx(deposit(hash, "UNBOND:thor1-node:100", feeEvents()))),
    timestamp: Date.parse(timestamp),
  });

  test("keeps a deposit Midgard does not list from the cutoff on, and none before it or that Midgard lists", () => {
    const listed = {
      source: "midgard",
      protocol: "thorchain",
      wallet: SIGNER,
      data: {
        type: "bond",
        date: "1693562400000000000",
        in: [{ address: SIGNER, coins: [], txID: "L1" }],
        out: [],
        pools: [],
        metadata: {},
        status: "success",
      },
      thornodeTxs: [],
      cosmosTxs: [],
    } as unknown as RawBundle;
    const kept = selectSends([
      v1(noop("N1", "2023-09-01T10:00:00Z")),
      v1(noop("N0", "2022-03-31T23:59:59Z")),
      v1(noop("L1", "2023-09-01T10:00:00Z")),
      listed,
    ]).bundles;
    assert.deepEqual(
      kept.map((b) => (b.source === "midgard" ? "midgard" : (b.data as ViewblockTx).hash)),
      ["N1", "midgard"],
    );
  });

  test("keeps a withdrawal of a pending add with that add, and no add alone; a deposit another wallet signed gives nothing", () => {
    const add = {
      ...toViewblockTx(
        toV1Tx(deposit("A1", `+:BTC.BTC:bc1-pair`, feeEvents(), [{ asset: "THOR.RUNE", amount: "5000000000" }])),
      ),
      timestamp: Date.parse("2023-09-01T10:00:00Z"),
    };
    const withdraw = {
      ...toViewblockTx(
        toV1Tx(
          deposit("W1", "-:BTC.BTC:10000", [
            ...feeEvents(),
            { type: "outbound", attributes: attributes({ chain: "THOR", to: SIGNER, coin: "5000000000 THOR.RUNE" }) },
          ]),
        ),
      ),
      timestamp: Date.parse("2023-09-02T10:00:00Z"),
    };
    const kept = selectSends([
      v1(add),
      v1(withdraw),
      { ...v1(noop("N2", "2023-09-03T10:00:00Z")), wallet: "thor1-x" },
    ]).bundles;
    assert.deepEqual(
      kept.map((b) => [(b.data as ViewblockTx).hash, b.pendingAdd?.hash]),
      [["W1", "A1"]],
    );
  });
});

describe("a deposit that did nothing", () => {
  test("gives its native fee as one fee row", () => {
    const data = toViewblockTx(toV1Tx(deposit("N1", "UNBOND:thor1-node:100", feeEvents())));
    const { rows, issues } = runBundle(
      { source: "thornode-v1", protocol: "thorchain", wallet: SIGNER, data, thornodeTxs: [], cosmosTxs: [] },
      THORCHAIN,
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(
      rows.map((row) => [row.type, row.baseCurrency, row.baseAmount, row.wallet, row.description]),
      [["fee", "RUNE", "0.02", SIGNER, "Fee: unbond that did nothing (UNBOND:thor1-node:100); N1"]],
    );
  });

  test("any other v1 deposit Midgard does not list gives a warning and no row", () => {
    const bond = { type: "bond", attributes: attributes({ amount: "100" }) };
    const data = toViewblockTx(toV1Tx(deposit("D1", "BOND:thor1-node", [...feeEvents(), bond])));
    const { rows, issues } = runBundle(
      { source: "thornode-v1", protocol: "thorchain", wallet: SIGNER, data, thornodeTxs: [], cosmosTxs: [] },
      THORCHAIN,
    );
    assert.deepEqual(rows, []);
    assert.match(issues[0].message, /a THORChain tx Midgard does not list \(D1, deposit, memo BOND:thor1-node\)/);
  });
});

describe("a withdrawn pending add on THORChain v1", () => {
  test("gives the refund rows, as Viewblock's does", () => {
    const add = {
      ...toViewblockTx(
        toV1Tx(deposit("A1", "+:BTC.BTC:bc1-pair", feeEvents(), [{ asset: "THOR.RUNE", amount: "5000000000" }])),
      ),
      timestamp: Date.parse("2023-09-01T10:00:00Z"),
    };
    const outbound = {
      type: "outbound",
      attributes: attributes({ chain: "THOR", to: SIGNER, coin: "4998000000 THOR.RUNE" }),
    };
    const withdraw = {
      ...toViewblockTx(toV1Tx(deposit("W1", "-:BTC.BTC:10000", [...feeEvents(), outbound]))),
      timestamp: Date.parse("2023-09-02T10:00:00Z"),
    };
    const v1 = (data: ViewblockTx): RawBundle => ({
      source: "thornode-v1",
      protocol: "thorchain",
      wallet: SIGNER,
      data,
      thornodeTxs: [],
      cosmosTxs: [],
    });
    const [kept] = selectSends([v1(add), v1(withdraw)]).bundles;
    const { rows, issues } = runBundle(kept, THORCHAIN);
    assert.deepEqual(issues, []);
    assert.deepEqual(
      rows.map((row) => [row.type, row.baseCurrency, row.baseAmount, row.feeAmount ?? ""]),
      [
        ["failed-out", "RUNE", "50", "0.02"],
        ["fee", "RUNE", "0.02", ""],
        ["fee", "RUNE", "0.02", ""],
      ],
    );
  });
});
