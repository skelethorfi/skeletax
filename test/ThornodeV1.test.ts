import { afterEach, describe, mock, test } from "node:test";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { http } from "../src/sources/http.ts";
import { RecordStore, StoreMissError } from "../src/sources/store/RecordStore.ts";
import { SnapshotManifest } from "../src/sources/store/SnapshotManifest.ts";
import assert from "node:assert/strict";
import { atBlockTime, isNoopDeposit, ThornodeV1, toV1Tx, toViewblockTx } from "../src/sources/thorchain/ThornodeV1.ts";
import { type RawBundle, selectSends, v1TxsToTime } from "../src/sources/RawBundle.ts";
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

// What a RUNE add that waits for its other side emits
const pending = {
  type: "pending_liquidity",
  attributes: attributes({ pool: "BTC.BTC", type: "add", rune_amount: "5000000000" }),
};

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

  test("reads a send's sender and coins; a send is typed as one", () => {
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
    assert.deepEqual([tx.type, tx.signer, tx.coins], ["MsgSend", SIGNER, [{ asset: "RUNE", amount: "500" }]]);
    assert.deepEqual(toViewblockTx(tx).types, ["send"]);
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
      toViewblockTx(
        toV1Tx(deposit("A1", "+:BTC.BTC", [...feeEvents(), pending], [{ asset: "THOR.RUNE", amount: "5000000000" }])),
      ).types,
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
        toV1Tx(
          deposit(
            "A1",
            `+:BTC.BTC:bc1-pair`,
            [...feeEvents(), pending],
            [{ asset: "THOR.RUNE", amount: "5000000000" }],
          ),
        ),
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
        toV1Tx(
          deposit(
            "A1",
            "+:BTC.BTC:bc1-pair",
            [...feeEvents(), pending],
            [{ asset: "THOR.RUNE", amount: "5000000000" }],
          ),
        ),
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

describe("THORChain v1 and Viewblock over a period that spans the cutoff", () => {
  test("a tx both list from the cutoff on is kept once, from v1, paired with v1's add", () => {
    const outbound = {
      type: "outbound",
      attributes: attributes({ chain: "THOR", to: SIGNER, coin: "4998000000 THOR.RUNE" }),
    };
    const add = () => ({
      ...toViewblockTx(
        toV1Tx(
          deposit(
            "A1",
            "+:BTC.BTC:bc1-pair",
            [...feeEvents(), pending],
            [{ asset: "THOR.RUNE", amount: "5000000000" }],
          ),
        ),
      ),
      timestamp: Date.parse("2023-09-01T10:00:00Z"),
    });
    const withdraw = () => ({
      ...toViewblockTx(toV1Tx(deposit("W1", "-:BTC.BTC:10000", [...feeEvents(), outbound]))),
      timestamp: Date.parse("2023-09-02T10:00:00Z"),
    });
    const noop = () => toViewblockTx(toV1Tx(deposit("N1", "UNBOND:thor1-node:100", feeEvents())));
    const of = (source: RawBundle["source"], data: ViewblockTx): RawBundle => ({
      source,
      protocol: "thorchain",
      wallet: SIGNER,
      data,
      thornodeTxs: [],
      cosmosTxs: [],
    });
    const v1Add = of("thornode-v1", add());
    const kept = selectSends([
      of("viewblock", add()),
      of("viewblock", withdraw()),
      of("viewblock", noop()),
      v1Add,
      of("thornode-v1", withdraw()),
      of("thornode-v1", noop()),
    ]).bundles;
    assert.deepEqual(
      kept.map((b) => [b.source, (b.data as ViewblockTx).hash, b.pendingAdd?.hash]),
      [
        ["thornode-v1", "W1", "A1"],
        ["thornode-v1", "N1", undefined],
      ],
    );
    assert.equal(kept[0].pendingAdd, v1Add.data);
  });
});

describe("an add or a withdrawal that did nothing", () => {
  test("is a deposit that did nothing: one fee row", () => {
    for (const memo of ["-:BTC.BTC:10000", "WITHDRAW:BTC.BTC:10000", "+:BTC.BTC"]) {
      const data = toViewblockTx(toV1Tx(deposit("N1", memo, feeEvents())));
      assert.deepEqual(data.types, ["deposit", "noop"], memo);
      const [kept] = selectSends([
        { source: "thornode-v1", protocol: "thorchain", wallet: SIGNER, data, thornodeTxs: [], cosmosTxs: [] },
      ]).bundles;
      assert.deepEqual(
        runBundle(kept, THORCHAIN).rows.map((row) => [row.type, row.baseAmount]),
        [["fee", "0.02"]],
        memo,
      );
    }
  });
});

describe("a v1 add before the cutoff", () => {
  test("is not read: a v1 withdrawal after it finds no add (Viewblock gives it in a run that reads it); a deposit that did nothing before it gives nothing", () => {
    const of = (data: ViewblockTx): RawBundle => ({
      source: "thornode-v1",
      protocol: "thorchain",
      wallet: SIGNER,
      data,
      thornodeTxs: [],
      cosmosTxs: [],
    });
    const add = {
      ...toViewblockTx(
        toV1Tx(
          deposit(
            "A1",
            "+:BTC.BTC:bc1-pair",
            [...feeEvents(), pending],
            [{ asset: "THOR.RUNE", amount: "5000000000" }],
          ),
        ),
      ),
      timestamp: Date.parse("2022-03-28T10:00:00Z"),
    };
    const outbound = {
      type: "outbound",
      attributes: attributes({ chain: "THOR", to: SIGNER, coin: "4998000000 THOR.RUNE" }),
    };
    const withdraw = {
      ...toViewblockTx(toV1Tx(deposit("W1", "-:BTC.BTC:10000", [...feeEvents(), outbound]))),
      timestamp: Date.parse("2022-04-05T10:00:00Z"),
    };
    const noop = {
      ...toViewblockTx(toV1Tx(deposit("N0", "UNBOND:thor1-node:100", feeEvents()))),
      timestamp: Date.parse("2022-03-30T10:00:00Z"),
    };
    assert.deepEqual(
      selectSends([of(add), of(noop), of(withdraw)]).bundles.map((b) => [
        (b.data as ViewblockTx).hash,
        b.pendingAdd?.hash,
      ]),
      [["W1", undefined]],
    );
  });
});

describe("ThornodeV1.getSends", () => {
  afterEach(() => mock.restoreAll());
  const store = () => new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-")));
  const listed = (hash: string) => ({ ...deposit(hash, "UNBOND:thor1-node:100", feeEvents()), tx: undefined });
  const page = (hashes: string[], total: number) => ({
    data: {
      tx_responses: hashes.map(listed),
      txs: hashes.map((hash) => deposit(hash, "UNBOND:thor1-node:100", feeEvents()).tx),
      pagination: { total: String(total) },
    },
  });

  test("pages 100 at a time until the total", async () => {
    const first = Array.from({ length: 100 }, (_, i) => `H${i}`);
    const get = mock.method(http, "get", async (_url: string, config: any) =>
      config.params["pagination.offset"] === 0 ? page(first, 101) : page(["H100"], 101),
    );
    const v1 = new ThornodeV1(store());
    assert.equal((await v1.getSends(SIGNER)).length, 101);
    assert.equal(get.mock.callCount(), 2);
    assert.deepEqual(v1.warnings(), []);
  });

  test("keeps a list short of its total, with a warning, and fetches it again next run", async () => {
    mock.method(http, "get", async () => page(["H1", "H2"], 5));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-"));
    const v1 = new ThornodeV1(new RecordStore(dir));
    assert.equal((await v1.getSends(SIGNER)).length, 2);
    assert.match(v1.warnings()[0], /is short \(2 of 5 txs\)/);
    const again = mock.method(http, "get", async () => page(["H1", "H2", "H3", "H4", "H5"], 5));
    assert.equal((await new ThornodeV1(new RecordStore(dir)).getSends(SIGNER)).length, 5);
    assert.equal(again.mock.callCount(), 1);
  });

  test("a list that cannot be fetched is a warning, not an error", async () => {
    mock.method(http, "get", async () => {
      throw Object.assign(new Error("Bad Gateway"), { response: { status: 400 } });
    });
    const v1 = new ThornodeV1(store());
    assert.deepEqual(await v1.getSends(SIGNER), []);
    assert.match(v1.warnings()[0], /could not list the txs thor1-v1-signer signed \(400\).*are missing/);
  });
});

describe("ThornodeV1.getBlockTime", () => {
  afterEach(() => mock.restoreAll());

  test("a block time that cannot be fetched is a warning; a replay of the run skips it too", async () => {
    mock.method(http, "get", async (url: string) => {
      if (url.endsWith("/2")) {
        throw Object.assign(new Error("Bad Request"), { response: { status: 400 } });
      }
      return { data: { block: { header: { time: "2023-09-01T10:00:00.123456789Z" } } } };
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-"));
    const manifest = new SnapshotManifest();
    const v1 = new ThornodeV1(new RecordStore(dir, { manifest }));
    assert.equal((await v1.getBlockTime(1))?.time, "2023-09-01T10:00:00.123456789Z");
    assert.equal(await v1.getBlockTime(2), undefined);
    assert.match(v1.warnings().join("\n"), /could not fetch the time of 1 blocks.*2 \(400\)/);
    manifest.write(path.join(dir, "run"));

    const replay = new ThornodeV1(new RecordStore(dir, { replay: SnapshotManifest.load(path.join(dir, "run")) }));
    assert.equal((await replay.getBlockTime(1))?.time, "2023-09-01T10:00:00.123456789Z");
    assert.equal(await replay.getBlockTime(2), undefined);
    assert.match(replay.warnings().join("\n"), /2 \(skipped by the replayed run\)/);
  });

  test("offline, a block time not stored is an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-"));
    await assert.rejects(new ThornodeV1(new RecordStore(dir, { offline: true })).getBlockTime(3), StoreMissError);
  });

  test("a block that failed is skipped for the rest of the run, and warned about once", async () => {
    const get = mock.method(http, "get", async () => {
      throw Object.assign(new Error("Bad Request"), { response: { status: 400 } });
    });
    const v1 = new ThornodeV1(new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-"))));
    assert.deepEqual(await Promise.all([v1.getBlockTime(8), v1.getBlockTime(8)]), [undefined, undefined]);
    assert.equal(await v1.getBlockTime(8), undefined);
    assert.equal(get.mock.callCount(), 1);
    assert.match(v1.warnings().join("\n"), /time of 1 blocks.*: 8 \(400\)$/);
  });

  test("a refetch that fails uses the stored block time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-"));
    mock.method(http, "get", async () => ({ data: { block: { header: { time: "2023-09-01T10:00:00.5Z" } } } }));
    await new ThornodeV1(new RecordStore(dir)).getBlockTime(9);
    mock.restoreAll();
    mock.method(http, "get", async () => {
      throw Object.assign(new Error("Bad Request"), { response: { status: 400 } });
    });
    const v1 = new ThornodeV1(new RecordStore(dir, { fetch: "all" }));
    assert.equal((await v1.getBlockTime(9))?.time, "2023-09-01T10:00:00.5Z");
    assert.deepEqual(v1.warnings(), []);
  });
});

describe("v1TxsToTime", () => {
  test("takes each row-giving v1 tx by its own time: an add in the periods whose withdrawal is after them", () => {
    const of = (data: ViewblockTx): RawBundle => ({
      source: "thornode-v1",
      protocol: "thorchain",
      wallet: SIGNER,
      data,
      thornodeTxs: [],
      cosmosTxs: [],
    });
    const add = {
      ...toViewblockTx(
        toV1Tx(
          deposit(
            "A1",
            "+:BTC.BTC:bc1-pair",
            [...feeEvents(), pending],
            [{ asset: "THOR.RUNE", amount: "5000000000" }],
          ),
        ),
      ),
      timestamp: Date.parse("2023-06-29T10:00:00Z"),
    };
    const outbound = {
      type: "outbound",
      attributes: attributes({ chain: "THOR", to: SIGNER, coin: "4998000000 THOR.RUNE" }),
    };
    const withdraw = {
      ...toViewblockTx(toV1Tx(deposit("W1", "-:BTC.BTC:10000", [...feeEvents(), outbound]))),
      timestamp: Date.parse("2023-07-05T10:00:00Z"),
    };
    const noop = {
      ...toViewblockTx(toV1Tx(deposit("N1", "UNBOND:thor1-node:100", feeEvents()))),
      timestamp: Date.parse("2023-07-10T10:00:00Z"),
    };
    const other = {
      ...toViewblockTx(toV1Tx(deposit("D1", "BOND:thor1-node", [...feeEvents(), { type: "bond", attributes: [] }]))),
      timestamp: Date.parse("2023-06-10T10:00:00Z"),
    };
    const bundles = [of(add), of(withdraw), of(noop), of(other)];
    const hashes = (from: string, to: string) =>
      v1TxsToTime(bundles, Date.parse(from), Date.parse(to)).map((tx) => tx.hash);
    assert.deepEqual(hashes("2023-06-01T00:00:00Z", "2023-07-02T00:00:00Z"), ["A1"]);
    assert.deepEqual(hashes("2023-07-01T00:00:00Z", "2023-08-01T00:00:00Z"), ["W1", "N1"]);
  });
});
