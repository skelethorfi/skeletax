import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ActionTypeEnum } from "@xchainjs/xchain-midgard";
import { getInboundTxs, getThornodeTxIds, shouldIncludeAction } from "../src/sources/Source.ts";
import { renderUnmapped, unmappedRecords, unsupportedActionFile } from "../src/cli/Exporter.ts";
import type { BundleResult } from "../src/pipeline/run.ts";
import type { RawBundle } from "../src/sources/RawBundle.ts";

describe("Exporter thornode fetch wiring", () => {
  const inbound = (txID: string, asset?: string) => ({ txID, coins: asset ? [{ asset, amount: "1" }] : [] });
  const ids = (type: string, ins: any[]) => getThornodeTxIds({ type, in: ins } as any);

  test("fetches the inbound thornode transaction for swaps, switches and refunds", () => {
    assert.deepEqual(ids(ActionTypeEnum.Swap, [inbound("tx1", "THOR.RUNE")]), ["tx1"]);
    assert.deepEqual(ids(ActionTypeEnum.Switch, [inbound("tx1", "GAIA.KUJI")]), ["tx1"]);
    assert.deepEqual(ids(ActionTypeEnum.Refund, [inbound("tx1", "BTC.BTC")]), ["tx1"]);
  });

  test("fetches only the L1 deposits of an add liquidity", () => {
    assert.deepEqual(
      ids(ActionTypeEnum.AddLiquidity, [inbound("tx-rune", "THOR.RUNE"), inbound("tx-btc", "BTC.BTC")]),
      ["tx-btc"],
    );
    assert.deepEqual(ids(ActionTypeEnum.AddLiquidity, [inbound("tx-rune", "THOR.RUNE")]), []);
  });

  test("fetches a withdrawal request only when it was sent on an L1", () => {
    assert.deepEqual(ids(ActionTypeEnum.Withdraw, [inbound("tx-btc", "BTC.BTC")]), ["tx-btc"]);
    assert.deepEqual(ids(ActionTypeEnum.Withdraw, [inbound("tx-rune")]), []);
    assert.deepEqual(ids(ActionTypeEnum.Withdraw, [inbound("tx-rune", "THOR.RUNE")]), []);
  });

  test("does not fetch thornode transactions for unrelated action types", () => {
    assert.deepEqual(ids(ActionTypeEnum.Donate, [inbound("tx1", "BTC.BTC")]), []);
  });

  test("does not fetch thornode transactions when the inbound tx has no id", () => {
    // e.g. 2021 BNB.RUNE switches returned by Midgard with an empty txID
    assert.deepEqual(ids(ActionTypeEnum.Switch, [inbound("", "BNB.RUNE-B1A")]), []);
  });

  test("does not fetch the genesisTx placeholder", () => {
    // Old Midgard's LP positions from before its start (2022-03)
    assert.deepEqual(ids(ActionTypeEnum.AddLiquidity, [inbound("genesisTx", "BTC.BTC")]), []);
  });
});

describe("getInboundTxs", () => {
  test("a savers deposit from an L1 wallet sent the L1 asset, which Midgard names as the synth", () => {
    const action = {
      type: ActionTypeEnum.AddLiquidity,
      in: [{ txID: "tx-btc", address: "bc1q-wallet", coins: [{ asset: "BTC/BTC", amount: "1" }] }],
    } as any;
    assert.deepEqual(getInboundTxs(action), [{ txId: "tx-btc", asset: "BTC.BTC" }]);
  });

  test("a savers deposit of a synth from a THORChain wallet is not looked up", () => {
    const action = {
      type: ActionTypeEnum.AddLiquidity,
      in: [{ txID: "tx-synth", address: "thor1-wallet", coins: [{ asset: "BTC/BTC", amount: "1" }] }],
    } as any;
    assert.deepEqual(getInboundTxs(action), []);
  });

  test("a token deposit is sent on its L1", () => {
    const usdc = "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    const action = {
      type: ActionTypeEnum.AddLiquidity,
      in: [{ txID: "tx-usdc", address: "0xwallet", coins: [{ asset: usdc, amount: "1" }] }],
    } as any;
    assert.deepEqual(getInboundTxs(action), [{ txId: "tx-usdc", asset: usdc }]);
  });
});

describe("Exporter action status filter", () => {
  const action = (status: string, txType: string, outCoins: any[] = []) =>
    ({
      status,
      type: "swap",
      metadata: { swap: { txType } },
      out: outCoins.length ? [{ coins: outCoins }] : [],
    }) as any;
  const rune = { asset: "THOR.RUNE", amount: "130314435243" };

  test("includes successful actions", () => {
    assert.equal(shouldIncludeAction(action("success", "swap")), true);
  });

  test("excludes pending swaps", () => {
    assert.equal(shouldIncludeAction(action("pending", "swap", [rune])), false);
  });

  test("includes pending loan repayments (loan not closed)", () => {
    assert.equal(shouldIncludeAction(action("pending", "loanRepayment")), true);
  });

  test("includes a pending loan open with an output: it was paid out (docs/specs/loans.md)", () => {
    assert.equal(shouldIncludeAction(action("pending", "loanOpen", [rune])), true);
    assert.equal(shouldIncludeAction(action("pending", "loanOpen", [{ asset: "BTC.BTC", amount: "1000" }])), true);
  });

  test("excludes a pending loan open with no output", () => {
    assert.equal(shouldIncludeAction(action("pending", "loanOpen")), false);
  });
});

describe("unsupported action files", () => {
  const txId = "A".repeat(64);
  const contract = (contractType: string) => ({
    type: "contract",
    date: "1700000000000000000",
    pools: [],
    in: [{ txID: txId, address: "thor1-user-wallet-11111", coins: [] }],
    out: [],
    metadata: { contract: { contractType, funds: "", attributes: {} } },
  });
  const bundle = (data: any, protocol = "thorchain") =>
    ({ source: "midgard", protocol, wallet: "", data, thornodeTxs: [], cosmosTxs: [] }) as RawBundle;

  test("the contract actions of one tx each get their own file", () => {
    // a FIN trade's key ends with a hash of its attributes (here none)
    assert.match(
      unsupportedActionFile(bundle(contract("wasm-rujira-fin/trade"))),
      new RegExp(`^contract/contract\\.${txId}\\.wasm-rujira-fin_trade\\.[0-9a-f]{12}\\.json$`),
    );
    assert.equal(
      unsupportedActionFile(bundle(contract("wasm-rujira-merge/deposit"))),
      `contract/contract.${txId}.wasm-rujira-merge_deposit.json`,
    );
  });

  test("another protocol's actions go in its own folder", () => {
    assert.equal(
      unsupportedActionFile(bundle(contract("wasm-x/y"), "maya")),
      `maya/contract/contract.${txId}.wasm-x_y.json`,
    );
  });

  test("an action without a txid is named by its date", () => {
    const action = {
      type: "donate",
      date: "1700000000000000000",
      pools: [],
      in: [{ txID: "", address: "", coins: [] }],
      out: [],
      metadata: {},
    };
    assert.equal(unsupportedActionFile(bundle(action)), "donate/donate.date-1700000000000000000.json");
  });
});

describe("unmapped records", () => {
  const txId = "A".repeat(64);
  const action = (type: string) => ({
    type,
    date: "1700000000000000000",
    pools: [],
    in: [{ txID: txId, address: "thor1-user-wallet-11111", coins: [] }],
    out: [],
    metadata: {},
  });
  const result = (type: string, issues: BundleResult["issues"]): BundleResult => ({
    bundle: {
      source: "midgard",
      protocol: "thorchain",
      wallet: "thor1-user-wallet-11111",
      data: action(type),
      thornodeTxs: [],
      cosmosTxs: [],
    } as unknown as RawBundle,
    time: new Date(1700000000000),
    activities: [],
    rows: [],
    issues,
  });

  test("each unsupported or failed bundle, or one with no rows but a warning, is listed; the rest are not", () => {
    const withRow = { ...result("bond", [{ kind: "warning", message: "odd" }]), rows: [{} as never] };
    const results = [
      result("swap", [{ kind: "failed", message: "boom" }]),
      result("donate", [{ kind: "unsupported", message: "unsupported action: donate" }]),
      result("send", [{ kind: "ignored", message: "Midgard send with no coins" }]),
      withRow,
      result("withdraw", [{ kind: "warning", message: "no pending add" }]),
    ];
    assert.deepEqual(unmappedRecords(results), [
      {
        kind: "failed",
        record: `midgard/swap.${txId}`,
        wallet: "thor1-user-wallet-11111",
        time: "2023-11-14T22:13:20.000Z",
        times: ["2023-11-14T22:13:20.000Z"],
        txids: [txId.toLowerCase()],
        reason: "boom",
      },
      {
        kind: "unsupported",
        record: `midgard/donate.${txId}`,
        wallet: "thor1-user-wallet-11111",
        time: "2023-11-14T22:13:20.000Z",
        times: ["2023-11-14T22:13:20.000Z"],
        txids: [txId.toLowerCase()],
        reason: "unsupported action: donate",
      },
      {
        kind: "warning",
        record: `midgard/withdraw.${txId}`,
        wallet: "thor1-user-wallet-11111",
        time: "2023-11-14T22:13:20.000Z",
        times: ["2023-11-14T22:13:20.000Z"],
        txids: [txId.toLowerCase()],
        reason: "no pending add",
      },
    ]);
    assert.deepEqual(JSON.parse(renderUnmapped([])), { version: 1, records: [] });
  });

  test("an attached inbound's time and txid are the record's too (a liquidity auction's deposits)", () => {
    const sendTx = "B".repeat(64);
    const send = { ...action("send"), date: "1690000000000000000", in: [{ txID: sendTx, address: "x", coins: [] }] };
    const r = result("addLiquidity", [{ kind: "failed", message: "boom" }]);
    r.bundle = { ...r.bundle, inbounds: [send as never] };
    const [record] = unmappedRecords([r]);
    assert.deepEqual(record.times, ["2023-11-14T22:13:20.000Z", "2023-07-22T04:26:40.000Z"]);
    assert.deepEqual(record.txids, [txId.toLowerCase(), sendTx.toLowerCase()]);
  });

  test("a withdrawn pending add's time and txid are the record's too (its rows carry the add's)", () => {
    const addTx = "C".repeat(64);
    const r = result("withdraw", [{ kind: "failed", message: "boom" }]);
    r.bundle = { ...r.bundle, pendingAdd: { hash: addTx, timestamp: 1690000000000 } as never };
    const [record] = unmappedRecords([r]);
    assert.deepEqual(record.times, ["2023-11-14T22:13:20.000Z", "2023-07-22T04:26:40.000Z"]);
    assert.deepEqual(record.txids, [txId.toLowerCase(), addTx.toLowerCase()]);
  });
});
