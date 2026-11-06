import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  attachAuctionDeposits,
  dedupeBundles,
  getBundleKey,
  type RawBundle,
  selectSends,
} from "../src/sources/RawBundle.ts";
import type { ProtocolId } from "../src/domain/Protocol.ts";

const action = (txID: string, type = "swap") => ({
  type,
  date: "1680350400000000000",
  in: [{ address: "thor1a", coins: [], txID }],
  out: [],
  pools: [],
  metadata: {},
});

const bundle = (
  source: RawBundle["source"],
  wallet: string,
  data: any,
  protocol: ProtocolId = "thorchain",
): RawBundle => ({ source, protocol, wallet, data, thornodeTxs: [], cosmosTxs: [] });

describe("getBundleKey", () => {
  test("is the store record a bundle was listed as", () => {
    assert.equal(getBundleKey(bundle("midgard", "thor1a", action("A"))), "midgard/swap.A");
    assert.equal(getBundleKey(bundle("midgard", "thor1a", action("A"), "maya")), "maya-midgard/swap.A");
    assert.equal(getBundleKey(bundle("viewblock", "thor1a", { hash: "H" })), "viewblock/H");
    assert.equal(getBundleKey(bundle("tcy", "thor1a", { date: "1700000000" })), "tcy/thor1a.1700000000");
  });
});

describe("dedupeBundles", () => {
  test("keeps a Midgard action listed for two wallets once, from the first wallet", () => {
    const first = bundle("midgard", "thor1a", action("A"));
    const second = bundle("midgard", "thor1b", action("A"));
    const other = bundle("midgard", "thor1b", action("B"));

    assert.deepEqual(dedupeBundles([first, second, other]), { bundles: [first, other], duplicates: 1 });
  });

  test("keeps the same txid on different protocols", () => {
    const bundles = [bundle("midgard", "thor1a", action("A")), bundle("midgard", "thor1a", action("A"), "maya")];

    assert.equal(dedupeBundles(bundles).duplicates, 0);
  });

  test("keeps every wallet's Viewblock send, which maps from that wallet's side", () => {
    const bundles = [bundle("viewblock", "thor1a", { hash: "H" }), bundle("viewblock", "thor1b", { hash: "H" })];

    assert.deepEqual(dedupeBundles(bundles), { bundles, duplicates: 0 });
  });
});

describe("selectSends", () => {
  const vbSend = (hash: string, date: string, types = ["network", "send", "main"]) => ({
    hash,
    timestamp: Date.parse(date),
    types,
  });

  test("keeps every wallet's Midgard send, which maps from that wallet's side", () => {
    const bundles = [
      bundle("midgard", "thor1a", action("S", "send")),
      bundle("midgard", "thor1b", action("S", "send")),
    ];

    assert.deepEqual(dedupeBundles(bundles), { bundles, duplicates: 0 });
  });

  test("drops a Midgard send that is another action's inbound, case ignored", () => {
    const swap = bundle("midgard", "thor1a", action("ab", "swap"));
    const inbound = bundle("midgard", "thor1a", action("AB", "send"));
    const plain = bundle("midgard", "thor1a", action("CD", "send"));

    assert.deepEqual(selectSends([swap, inbound, plain]), {
      bundles: [swap, plain],
      dropped: { inbound: 1, outbound: 0, viewblock: 0 },
    });
  });

  test("drops a THORChain send that is a Maya action's inbound (RUNE sent to a Maya vault)", () => {
    const mayaSwap = bundle("midgard", "thor1a", action("AB", "swap"), "maya");
    const send = bundle("midgard", "thor1a", action("AB", "send"));

    assert.deepEqual(selectSends([mayaSwap, send]), {
      bundles: [mayaSwap],
      dropped: { inbound: 1, outbound: 0, viewblock: 0 },
    });
  });

  test("drops the inbound send of a stuck Maya swap exported as lost, so the RUNE leaves the wallet once", () => {
    const stuck = bundle("midgard", "thor1a", { ...action("AB", "swap"), status: "pending" }, "maya");
    const send = bundle("midgard", "thor1a", action("AB", "send"));

    assert.deepEqual(selectSends([stuck, send]).bundles, [stuck]);
  });

  test("keeps only Viewblock sends from before 2022-04 that Midgard does not list", () => {
    const early = bundle("viewblock", "thor1a", vbSend("E1", "2022-03-31T23:59:59Z"));
    const listed = bundle("viewblock", "thor1a", vbSend("e2", "2021-07-01T00:00:00Z"));
    const late = bundle("viewblock", "thor1a", vbSend("L1", "2022-04-01T00:00:00Z"));
    const swap = bundle("viewblock", "thor1a", vbSend("W1", "2021-07-01T00:00:00Z", ["swap", "main"]));
    const midgard = bundle("midgard", "thor1a", action("E2", "send"));

    assert.deepEqual(selectSends([early, listed, late, swap, midgard]), {
      bundles: [early, midgard],
      dropped: { inbound: 0, outbound: 0, viewblock: 3 },
    });
  });

  test("keeps a Viewblock withdrawal of a pending add, with that add; an add alone, or listed, gives nothing", () => {
    const add = (hash: string, date: string, memo: string, amount: string, from = "bnb1x") => ({
      hash,
      timestamp: Date.parse(date),
      types: ["liquidity", "add", "main"],
      memo: { raw: memo },
      input: { chain: "BNB", asset: "BNB.BUSD-BD1", amount },
      observation: { from, to: "bnb1vault", chain: "BNB" },
    });
    const withdraw = (hash: string, date: string, pool: string, amount: string, signer = "thor1a") => ({
      hash,
      timestamp: Date.parse(date),
      types: ["liquidity", "withdraw", "main"],
      memo: { raw: `-:${pool}:10000` },
      signer,
      outbounds: [{ hash: "OUT1", chain: "BNB", from: "bnb1vault", to: "bnb1x", amount, asset: "BNB.BUSD-BD1" }],
    });
    const older = add("A0", "2020-12-01T09:00:00Z", "ADD:BNB.BUSD-BD1:thor1a", "500");
    const pending = add("A1", "2020-12-01T10:00:00Z", "ADD:BNB.BUSD-BD1:thor1a", "500");
    const other = add("A2", "2020-12-01T10:05:00Z", "ADD:BNB.BNB:thor1a", "500");
    const later = add("A3", "2020-12-01T11:00:00Z", "ADD:BNB.BUSD-BD1:thor1a", "500");
    const back = withdraw("W1", "2020-12-01T10:30:00Z", "BNB.BUSD-BD1", "490");
    const bundles = [older, pending, other, later, back].map((tx) => bundle("viewblock", "thor1a", tx));
    const back2 = () => bundle("viewblock", "thor1a", back);

    const kept = selectSends(bundles).bundles;
    assert.deepEqual(
      kept.map((b) => [(b.data as any).hash, b.pendingAdd?.hash]),
      [["W1", "A1"]],
    );
    // Midgard listing that add (it made a position after all): the latest add it does not list is the pending one
    assert.deepEqual(
      selectSends([...bundles, bundle("midgard", "thor1a", action("A1", "addLiquidity"))])
        .bundles.filter((b) => b.source === "viewblock")
        .map((b) => b.pendingAdd?.hash),
      ["A0"],
    );
    // Paid out more than any add: kept unpaired, so its mapping warns
    const more = bundle("viewblock", "thor1a", withdraw("W2", "2020-12-01T10:30:00Z", "BNB.BUSD-BD1", "501"));
    assert.deepEqual(
      selectSends([bundles[1], more]).bundles.map((b) => [(b.data as any).hash, b.pendingAdd?.hash]),
      [["W2", undefined]],
    );
    // One add pays back one withdrawal: the earlier withdrawal takes it
    const second = bundle("viewblock", "thor1a", withdraw("W4", "2020-12-01T10:40:00Z", "BNB.BUSD-BD1", "490"));
    assert.deepEqual(
      selectSends([bundles[1], back2(), second]).bundles.map((b) => [(b.data as any).hash, b.pendingAdd?.hash]),
      [
        ["W1", "A1"],
        ["W4", undefined],
      ],
    );
    // A pool named without a contract is not one named with it
    const bare = bundle("viewblock", "thor1a", withdraw("W6", "2020-12-01T10:30:00Z", "BNB.BUSD", "490"));
    assert.equal(selectSends([bundles[1], bare]).bundles[0].pendingAdd, undefined);
    // Signed by another wallet: not this wallet's
    const foreign = bundle(
      "viewblock",
      "thor1a",
      withdraw("W3", "2020-12-01T10:30:00Z", "BNB.BUSD-BD1", "490", "thor1b"),
    );
    assert.deepEqual(selectSends([bundles[1], foreign]).bundles, []);
  });

  test("drops a THORChain send that is a Maya action's outbound, by txid", () => {
    const swap = bundle(
      "midgard",
      "thor1a",
      { ...action("IN"), out: [{ address: "thor1a", txID: "OUTTX", coins: [] }] },
      "maya",
    );
    const payout = bundle("midgard", "thor1a", action("outtx", "send"));

    assert.deepEqual(selectSends([swap, payout]), {
      bundles: [swap],
      dropped: { inbound: 0, outbound: 1, viewblock: 0 },
    });
  });

  test("a send whose memo names a pending refund is its outbound: the refund is paid by it", () => {
    const txid = "ab".repeat(32);
    const refund = bundle("midgard", "thor1a", { ...action(txid, "refund"), status: "pending" }, "maya");
    const coins = [{ asset: "THOR.RUNE", amount: "9998000000" }];
    const payout = bundle("midgard", "thor1a", {
      ...action("PAYOUT", "send"),
      metadata: { send: { memo: `REFUND:${txid.toUpperCase()}` } },
      out: [{ address: "thor1a", txID: "", coins }],
    });

    const { bundles, dropped } = selectSends([refund, payout]);

    assert.equal(dropped.outbound, 1);
    assert.equal(bundles.length, 1);
    assert.partialDeepStrictEqual(bundles[0].data, {
      type: "refund",
      status: "success",
      out: [{ address: "thor1a", txID: "PAYOUT", coins }],
    });
  });

  test("a REFUND memo naming no listed action leaves the send a send", () => {
    const payout = bundle("midgard", "thor1a", {
      ...action("PAYOUT", "send"),
      metadata: { send: { memo: `REFUND:${"cd".repeat(32)}` } },
    });

    assert.deepEqual(selectSends([payout]).bundles, [payout]);
  });
});

describe("attachAuctionDeposits", () => {
  const MAYA = "maya1-member";
  const THOR = "thor1-member";
  const add = {
    type: "addLiquidity",
    status: "success",
    date: "2000",
    pools: ["THOR.RUNE"],
    in: [
      { address: MAYA, txID: "DONATE", coins: [{ asset: "MAYA.CACAO", amount: "1" }] },
      { address: THOR, txID: "", coins: [{ asset: "THOR.RUNE", amount: "1" }] },
    ],
    out: [],
    metadata: { addLiquidity: { memo: "donate:thor.rune", liquidityUnits: "1" } },
  };
  const send = (txID: string, memo: string, date = "1000", from = THOR) =>
    bundle("midgard", THOR, {
      type: "send",
      status: "success",
      date,
      in: [{ address: from, txID, coins: [{ asset: "THOR.RUNE", amount: "1" }] }],
      out: [],
      pools: [],
      metadata: { send: { memo } },
    });

  test("attaches the member's deposits to its donate add, and drops them as sends", () => {
    const auctionAdd = bundle("midgard", MAYA, add, "maya");
    const deposit = send("D1", `+:THOR.RUNE:${MAYA.toUpperCase()}:wr:100:TIER1`);
    const other = send("S1", "some memo");

    const { bundles, attached } = attachAuctionDeposits([auctionAdd, deposit, other]);

    assert.equal(attached, 1);
    assert.deepEqual(bundles, [{ ...auctionAdd, inbounds: [deposit.data] }, other]);
  });

  test("leaves a deposit after the add, from another address or to another member", () => {
    const auctionAdd = bundle("midgard", MAYA, add, "maya");
    const sends = [
      send("D1", `+:THOR.RUNE:${MAYA}`, "3000"),
      send("D2", `+:THOR.RUNE:${MAYA}`, "1000", "thor1-other"),
      send("D3", "+:THOR.RUNE:maya1-other"),
    ];

    assert.deepEqual(attachAuctionDeposits([auctionAdd, ...sends]), { bundles: [auctionAdd, ...sends], attached: 0 });
  });
});
