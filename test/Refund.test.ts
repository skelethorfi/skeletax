import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runBundle } from "../src/pipeline/run.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { toMidgardNanoTimestamp } from "../src/sources/thorchain/MidgardUtils.ts";

const refund = (networkFees: { asset: string; amount: string }[]) =>
  ({
    date: toMidgardNanoTimestamp(new Date("2023-03-22T00:00:00Z")),
    height: "1",
    status: "success",
    type: "refund",
    pools: [],
    in: [
      { address: "thor1-user-wallet-11111", txID: "tx-refund", coins: [{ asset: "THOR.RUNE", amount: "100000000" }] },
    ],
    out: [{ address: "thor1-user-wallet-11111", txID: "", coins: [{ asset: "THOR.RUNE", amount: "98000000" }] }],
    metadata: { refund: { networkFees, reason: "bad memo", memo: "" } },
  }) as any;

// A refund through the exporter's path: interpreted, then exported as rows
const refundRows = (action: any, thornodeTxs: any[] = []) =>
  runBundle(
    { source: "midgard", protocol: "thorchain", wallet: "", data: action, thornodeTxs, cosmosTxs: [] },
    THORCHAIN,
  ).rows;

describe("refund", () => {
  test("the send is one failed-out row with the native fee, whatever Midgard lists as network fees", () => {
    const action = refund([
      { asset: "ETH.ETH", amount: "4929" },
      { asset: "THOR.RUNE", amount: "2000000" },
    ]);
    action.out[0].coins[0].amount = "100000000";
    const rows = refundRows(action);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "failed-out");
    assert.equal(rows[0].baseAmount, "1");
    assert.equal(rows[0].feeCurrency, "RUNE");
    assert.equal(rows[0].feeAmount, "0.02");
    assert.equal(rows[0].to, "thorchain");
  });

  // Midgard returns both the inbound and the outbound. The outbound is not a row; what was kept is.
  test("when less comes back than was sent, the difference is a fee row", () => {
    const [send, kept] = refundRows(refund([]));

    assert.equal(send.type, "failed-out");
    assert.equal(send.baseAmount, "1");
    assert.equal(kept.type, "fee");
    assert.equal(kept.baseCurrency, "RUNE");
    assert.equal(kept.baseAmount, "0.02");
    assert.equal(kept.feeAmount, undefined);
  });

  test("an L1 refund uses the inbound gas THORNode observed, and the amounts for what was kept", () => {
    // Midgard's network fee (3735) differs from sent - returned (2000000): the amounts win
    const action = refund([{ asset: "BTC.BTC", amount: "3735" }]);
    action.in[0].coins[0].asset = "BTC.BTC";
    action.out[0] = {
      address: "thor1-user-wallet-11111",
      txID: "tx-return",
      coins: [{ asset: "BTC.BTC", amount: "98000000" }],
    };
    const thornodeTx = {
      tx: {
        id: "tx-refund",
        coins: [{ asset: "BTC.BTC", amount: "100000000" }],
        gas: [{ asset: "BTC.BTC", amount: "1660" }],
      },
    } as any;
    const [send, kept] = refundRows(action, [thornodeTx]);

    assert.equal(send.feeCurrency, "BTC");
    assert.equal(send.feeAmount, "0.0000166");
    assert.equal(kept.baseAmount, "0.02");
    assert.ok(kept.description!.includes("0.98 BTC returned in tx-return"));
  });

  test("an L1 refund has a blank fee when THORNode has no record of the inbound", () => {
    const action = refund([{ asset: "BTC.BTC", amount: "3735" }]);
    action.in[0].coins[0].asset = "BTC.BTC";
    action.out[0].coins[0].asset = "BTC.BTC";
    const [send] = refundRows(action);

    assert.equal(send.feeCurrency, "");
    assert.equal(send.feeAmount, "");
  });

  test("the refund of a partially filled swap, whose outputs include the swap output, has no row", () => {
    const action = refund([{ asset: "ETH.ETH", amount: "4929" }]);
    action.out.push({
      address: "0x-destination",
      txID: "tx-swap-out",
      coins: [{ asset: "ETH.ETH", amount: "5000000" }],
    });

    assert.deepEqual(refundRows(action), []);
  });

  test("a refunded affiliate-fee swap, which the wallet did not send, has no row", () => {
    const action = refund([]);
    action.in[0].coins[0] = { asset: "ETH-USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", amount: "99900026" };
    const thornodeTx = {
      tx: {
        id: "tx-refund",
        coins: [{ asset: "ETH.ETH", amount: "800000" }],
        gas: [{ asset: "ETH.ETH", amount: "4138" }],
      },
    } as any;

    assert.deepEqual(refundRows(action, [thornodeTx]), []);
  });

  test("a refund of what the wallet sent keeps its row when THORNode lists the same asset in another case", () => {
    const action = refund([]);
    action.in[0].coins[0].asset = "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    action.out[0].coins[0].asset = "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    const thornodeTx = {
      tx: {
        id: "tx-refund",
        coins: [{ asset: "ETH.USDC-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: "1" }],
        gas: [{ asset: "ETH.ETH", amount: "4138" }],
      },
    } as any;

    assert.equal(refundRows(action, [thornodeTx])[0].type, "failed-out");
  });
});

describe("pending add withdrawn (Viewblock)", () => {
  const add = {
    hash: "tx-add",
    timestamp: Date.parse("2020-12-01T10:00:00Z"),
    height: 1,
    blockIndex: 0,
    code: 0,
    status: "success",
    types: ["liquidity", "add", "main"],
    memo: { raw: "ADD:ETH.TKN-0XABC:0x-user-eth-wallet" },
    signer: "thor1-user-wallet-11111",
    input: { chain: "THOR", asset: "THOR.RUNE", amount: "5000000000" },
    msgs: [],
  };
  const withdraw = {
    hash: "tx-withdraw",
    timestamp: Date.parse("2020-12-02T10:00:00Z"),
    height: 2,
    blockIndex: 0,
    code: 0,
    status: "success",
    types: ["liquidity", "withdraw", "main"],
    memo: { raw: "-:ETH.TKN-ABC:10000" },
    signer: "thor1-user-wallet-11111",
    msgs: [],
    outbounds: [
      {
        chain: "THOR",
        from: "thor1-module",
        to: "thor1-user-wallet-11111",
        amount: "4998000000",
        asset: "THOR.RUNE",
        timestamp: Date.parse("2020-12-02T10:00:00Z"),
      },
    ],
  };
  const rows = runBundle(
    {
      source: "viewblock",
      protocol: "thorchain",
      wallet: "thor1-user-wallet-11111",
      data: withdraw as any,
      pendingAdd: add as any,
      thornodeTxs: [],
      cosmosTxs: [],
    },
    THORCHAIN,
  ).rows;

  test("a RUNE side gives the refund rows and the request's fee, on the one wallet, and no return row", () => {
    assert.deepEqual(
      rows.map((row) => [row.type, row.baseCurrency, row.baseAmount, row.feeAmount ?? ""]),
      [
        ["failed-out", "RUNE", "50", "0.02"],
        ["fee", "RUNE", "0.02", ""],
        ["fee", "RUNE", "0.02", ""],
      ],
    );
    assert.equal(rows[2].timestamp.toISOString(), "2020-12-02T10:00:00.000Z");
    assert.match(rows[2].description ?? "", /withdrawal request tx-withdraw/);
  });
});

test("an L1 pending add with no gas recorded takes no fee from the withdrawal request", () => {
  const add = {
    hash: "tx-add-l1",
    timestamp: Date.parse("2020-12-01T10:00:00Z"),
    height: 1,
    types: ["liquidity", "add", "main"],
    memo: { raw: "ADD:BNB.BNB:thor1-user-wallet-11111" },
    input: { chain: "BNB", asset: "BNB.BNB", amount: "100000000" },
    observation: { from: "bnb1-user-wallet", to: "bnb1-vault", chain: "BNB" },
    msgs: [],
  };
  const withdraw = {
    hash: "tx-withdraw-l1",
    timestamp: Date.parse("2020-12-02T10:00:00Z"),
    height: 2,
    types: ["liquidity", "withdraw", "main"],
    memo: { raw: "-:BNB.BNB:10000" },
    signer: "thor1-user-wallet-11111",
    msgs: [],
    outbounds: [
      {
        hash: "tx-out-l1",
        chain: "BNB",
        from: "bnb1-vault",
        to: "bnb1-user-wallet",
        amount: "99000000",
        asset: "BNB.BNB",
        timestamp: Date.parse("2020-12-02T10:00:10Z"),
      },
    ],
  };
  const rows = runBundle(
    {
      source: "viewblock",
      protocol: "thorchain",
      wallet: "thor1-user-wallet-11111",
      data: withdraw as any,
      pendingAdd: add as any,
      thornodeTxs: [],
      cosmosTxs: [],
    },
    THORCHAIN,
  ).rows;
  assert.deepEqual(
    rows.map((row) => [row.type, row.baseCurrency, row.baseAmount, row.feeCurrency ?? "", row.feeAmount ?? ""]),
    [
      ["failed-out", "BNB", "1", "", ""],
      ["fee", "BNB", "0.01", "", ""],
      ["failed-in", "BNB", "0.99", "", ""],
      ["fee", "RUNE", "0.02", "", ""],
    ],
  );
});

test("a withdrawal with no pending add gives no rows, and a warning", () => {
  const result = runBundle(
    {
      source: "viewblock",
      protocol: "thorchain",
      wallet: "thor1-user-wallet-11111",
      data: { hash: "tx-w", timestamp: 0, types: ["liquidity", "withdraw", "main"], msgs: [] } as any,
      thornodeTxs: [],
      cosmosTxs: [],
    },
    THORCHAIN,
  );
  assert.deepEqual(result.rows, []);
  assert.ok(result.issues.some((issue) => issue.kind === "warning" && /no pending add/.test(issue.message)));
});

test("an L1 refund paid to a refund address named in the memo has its failed-in on that wallet", () => {
  const action = refund([]);
  action.in[0].coins[0].asset = "BTC.BTC";
  action.in[0].address = "bc1-user-sender";
  action.out = [{ address: "bc1-user-refund", txID: "tx-return", coins: [{ asset: "BTC.BTC", amount: "98000000" }] }];
  const rows = refundRows(action);
  const back = rows.find((row) => row.type === "failed-in");
  assert.equal(back?.wallet, "bc1-user-refund");
  assert.equal(back?.to, "bc1-user-refund");
  assert.equal(rows.find((row) => row.type === "failed-out")?.wallet, "bc1-user-sender");
});
