import { runBundle } from "../src/pipeline/run.ts";
import type { Action, Transaction } from "@xchainjs/xchain-midgard";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SummRowType } from "../src/export/summ/csv/index.ts";
import { toMidgardNanoTimestamp } from "../src/sources/thorchain/MidgardUtils.ts";
import { MAYA, type Protocol, THORCHAIN } from "../src/domain/Protocol.ts";

describe("swap", () => {
  // A swap through the exporter's path: interpreted, then exported as rows. A failure throws.
  const swap = (action: Action, thornodeTxs: any[] = [], protocol: Protocol = THORCHAIN) => {
    const bundle = {
      source: "midgard" as const,
      protocol: protocol.id,
      wallet: "",
      data: action,
      thornodeTxs,
      cosmosTxs: [],
    };
    const { rows, issues } = runBundle(bundle, protocol);
    const failure = issues.find((issue) => issue.kind === "failed");

    if (failure) {
      throw new Error(failure.message);
    }

    return rows;
  };

  const createMockAction = ({
    inputAsset,
    inputAmount,
    outputAsset,
    outputAmount,
    inputAddress,
    outputAddress,
    txID,
  }: {
    inputAsset: string;
    inputAmount: number;
    outputAsset: string;
    outputAmount: number;
    inputAddress: string;
    outputAddress: string;
    txID: string;
  }): Action => ({
    date: toMidgardNanoTimestamp(new Date("2023-04-01T12:00:00Z")),
    height: "1000000",
    in: [
      {
        address: inputAddress,
        coins: [
          {
            asset: inputAsset,
            amount: "" + inputAmount * Math.pow(10, 8),
          },
        ],
        txID,
      } as Transaction,
    ],
    out: [
      {
        address: outputAddress,
        coins: [
          {
            asset: outputAsset,
            amount: "" + outputAmount * Math.pow(10, 8),
          },
        ],
        // The payout's own tx on the output chain
        txID: `out-${txID}`,
      } as Transaction,
    ],
    metadata: {
      swap: {
        memo: `=:${outputAsset}:${outputAddress}`,
        networkFees: [{ asset: "THOR.RUNE", amount: "1000000" }],
        affiliateAddress: "",
        affiliateFee: "0",
        isStreamingSwap: false,
        liquidityFee: "0",
        swapTarget: "0",
        swapSlip: "0",
        txType: "swap",
        inPriceUSD: "",
        outPriceUSD: "",
      },
    },
    pools: [],
    status: "success",
    type: "swap",
  });

  const createMockThornodeTx = ({
    txID,
    gasAsset,
    gasAmount,
  }: {
    txID: string;
    gasAsset: string;
    gasAmount: string;
  }) => ({
    tx: {
      id: txID,
      gas: [
        {
          asset: gasAsset,
          amount: gasAmount,
        },
      ],
    },
  });

  test("a stuck swap that paid nothing out is a failed-out with its gas and a lost row, like a stuck refund", () => {
    const action = {
      ...createMockAction({
        inputAsset: "BTC.BTC",
        inputAmount: 0.5,
        outputAsset: "ETH.ETH",
        outputAmount: 0,
        inputAddress: "btc1address",
        outputAddress: "eth1address",
        txID: "tx456",
      }),
      status: "pending",
      out: [],
    } as Action;
    const rows = swap(action, [createMockThornodeTx({ txID: "tx456", gasAsset: "BTC.BTC", gasAmount: "1000" })]);

    assert.deepEqual(
      rows.map((row) => [row.type, row.baseAmount, row.baseCurrency, row.feeAmount, row.description]),
      [
        [
          SummRowType.FailedOut,
          "0.5",
          "BTC",
          "0.00001",
          "swap (tx456): still pending past the cut-off, nothing paid out",
        ],
        [
          SummRowType.Lost,
          "0.5",
          "BTC",
          undefined,
          "swap (tx456): never paid out (still pending), 0.5 BTC sent, 0 BTC returned",
        ],
      ],
    );
  });

  test("a pending swap with coins paid out is not taken for a stuck one", () => {
    const action = {
      ...createMockAction({
        inputAsset: "BTC.BTC",
        inputAmount: 0.5,
        outputAsset: "ETH.ETH",
        outputAmount: 8,
        inputAddress: "btc1address",
        outputAddress: "eth1address",
        txID: "tx789",
      }),
      status: "pending",
    } as Action;

    assert.throws(() => swap(action), /still pending with coins paid out/);
  });

  test("should error on incorrect asset string", () => {
    const action = createMockAction({
      inputAsset: "BTCBTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx123",
    });

    assert.throws(() => swap(action), /Failed to parse asset string: "BTCBTC"/);
  });

  test("should correctly map a simple swap", () => {
    const action = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx123",
    });

    const result = swap(action);

    assert.equal(result.length, 2);
    assert.equal(result[0].type, SummRowType.BridgeTradeOut);
    assert.equal(result[1].type, SummRowType.BridgeTradeIn);

    assert.equal(result[0].description, "1/2 - Swap 1 BTC to 20 ETH; tx123");
    assert.equal(result[0].baseCurrency, "BTC");
    assert.equal(result[0].baseAmount, "1");
    assert.equal(result[1].description, "2/2 - Swap 1 BTC to 20 ETH; tx123; paid out in out-tx123");
    assert.equal(result[1].baseCurrency, "ETH");
    assert.equal(result[1].baseAmount, "20");
  });

  test("names no payout txid for a payout to a THORChain or Maya wallet, or one with an all-zero txid", () => {
    const toRune = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "THOR.RUNE",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "thor1address",
      txID: "tx123",
    });
    const toCacao = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "MAYA.CACAO",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "maya1address",
      txID: "tx123",
    });
    const zeroTxid = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx123",
    });
    zeroTxid.out[0].txID = "0".repeat(64);

    assert.equal(swap(toRune)[1].description, "2/2 - Swap 1 BTC to 20 RUNE; tx123");
    assert.equal(swap(toCacao, [], MAYA)[1].description, "2/2 - Swap 1 BTC to 0.2 CACAO; tx123");
    assert.equal(swap(zeroTxid)[1].description, "2/2 - Swap 1 BTC to 20 ETH; tx123");
  });

  test("should use inbound thornode gas instead of Midgard network fee for non-THOR swaps", () => {
    const action = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx-gas",
    });

    action.metadata.swap!.networkFees = [{ asset: "ETH.ETH", amount: "28423" }];

    const result = swap(action, [
      createMockThornodeTx({
        txID: "tx-gas",
        gasAsset: "BTC.BTC",
        gasAmount: "3672",
      }) as any,
    ]);

    assert.equal(result[0].feeCurrency, "BTC");
    assert.equal(result[0].feeAmount, "0.00003672");
  });

  test("should leave fee blank for non-THOR swaps when thornode gas is unavailable", () => {
    const action = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx-no-gas",
    });

    action.metadata.swap!.networkFees = [{ asset: "ETH.ETH", amount: "28423" }];

    const result = swap(action, []);

    assert.equal(result[0].feeCurrency, "");
    assert.equal(result[0].feeAmount, "");
  });

  test("should set USD reference prices when provided by Midgard", () => {
    const action = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx124",
    });

    action.metadata.swap!.inPriceUSD = "30000";
    action.metadata.swap!.outPriceUSD = "1500";

    const result = swap(action);

    assert.equal(result[0].referencePricePerUnit, "30000");
    assert.equal(result[0].referencePriceCurrency, "USD");
    assert.equal(result[1].referencePricePerUnit, "1500");
    assert.equal(result[1].referencePriceCurrency, "USD");
  });

  test("should handle synth swaps", () => {
    const action = createMockAction({
      inputAsset: "BTC/BTC",
      inputAmount: 1,
      outputAsset: "ETH/ETH",
      outputAmount: 20,
      inputAddress: "thor1address",
      outputAddress: "thor1address",
      txID: "tx456",
    });

    const result = swap(action);

    assert.equal(result.length, 2);
    assert.ok(result[0].description!.includes("Synth BTC/BTC"));
    assert.ok(result[1].description!.includes("Synth ETH/ETH"));
    assert.equal(result[0].baseCurrency, "ThorSynth.BTC.BTC");
    assert.equal(result[1].baseCurrency, "ThorSynth.ETH.ETH");
    assert.equal(result[0].blockchain, "THORChain");
    assert.equal(result[1].blockchain, "THORChain");
    assert.equal(result[0].feeCurrency, "RUNE");
    assert.equal(result[0].feeAmount, "0.02");
  });

  test("should fall back to default RUNE gas for THOR swaps when thornode gas is unavailable", () => {
    const action = createMockAction({
      inputAsset: "THOR.RUNE",
      inputAmount: 100,
      outputAsset: "BTC.BTC",
      outputAmount: 0.01,
      inputAddress: "thor1address",
      outputAddress: "bc1address",
      txID: "tx-thor",
    });

    action.metadata.swap!.networkFees = [{ asset: "BTC.BTC", amount: "5000" }];

    const result = swap(action, []);

    assert.equal(result[0].feeCurrency, "RUNE");
    assert.equal(result[0].feeAmount, "0.02");
  });

  test("should fall back to default RUNE gas for trade assets when thornode gas is unavailable", () => {
    const action = createMockAction({
      inputAsset: "BTC~BTC",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 20,
      inputAddress: "bc1address",
      outputAddress: "eth1address",
      txID: "tx-trade",
    });

    action.metadata.swap!.networkFees = [{ asset: "ETH.ETH", amount: "28423" }];

    const result = swap(action, []);

    assert.equal(result[0].feeCurrency, "RUNE");
    assert.equal(result[0].feeAmount, "0.02");
  });

  test("should not fall back to default RUNE gas for token assets when thornode gas is unavailable", () => {
    const action = createMockAction({
      inputAsset: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
      inputAmount: 100,
      outputAsset: "THOR.RUNE",
      outputAmount: 50,
      inputAddress: "0xuser",
      outputAddress: "thor1address",
      txID: "tx-token",
    });

    action.metadata.swap!.networkFees = [{ asset: "THOR.RUNE", amount: "2000000" }];

    const result = swap(action, []);

    assert.equal(result[0].feeCurrency, "");
    assert.equal(result[0].feeAmount, "");
  });

  test("should throw an error for invalid input", () => {
    const invalidAction: Action = {
      ...createMockAction({
        inputAsset: "BTC.BTC",
        inputAmount: 1,
        outputAsset: "ETH.ETH",
        outputAmount: 20,
        inputAddress: "btc1address",
        outputAddress: "eth1address",
        txID: "tx789",
      }),
      in: [],
    };

    assert.throws(() => swap(invalidAction), /swap: expected 1 input but there were 0/);
  });

  test("should ignore synth swaps from non-thor addresses", () => {
    const action = createMockAction({
      inputAsset: "BTC/BTC",
      inputAmount: 1,
      outputAsset: "ETH/ETH",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "eth1address",
      txID: "tx101112",
    });

    const result = swap(action);

    assert.equal(result.length, 0);
  });

  test("should throw an error for THOR.TOR swaps", () => {
    const action = createMockAction({
      inputAsset: "BTC.BTC",
      inputAmount: 1,
      outputAsset: "THOR.TOR",
      outputAmount: 20,
      inputAddress: "btc1address",
      outputAddress: "thor1address",
      txID: "tx131415",
    });

    assert.throws(() => swap(action), /swap: invalid swap - THOR\.TOR/);
  });

  test("should send to the sender when the memo destination is empty", () => {
    const action = createMockAction({
      inputAsset: "ETH.ETH",
      inputAmount: 1,
      outputAsset: "ARB.ETH",
      outputAmount: 0.99,
      inputAddress: "0xsameaddress",
      outputAddress: "0xSameAddress",
      txID: "tx-empty-dest",
    });
    action.metadata.swap!.memo = "=:ARB.ETH:::wr:0";

    const result = swap(action);

    assert.equal(result[1].to, "0xSameAddress");
    assert.equal(result[1].baseAmount, "0.99");
  });

  test("should not treat a same-asset return to the sender as the swap output when the destination is empty", () => {
    const action = createMockAction({
      inputAsset: "ETH.ETH",
      inputAmount: 1,
      outputAsset: "ETH.ETH",
      outputAmount: 0.99,
      inputAddress: "0xsameaddress",
      outputAddress: "0xsameaddress",
      txID: "tx-empty-dest-refund",
    });
    action.metadata.swap!.memo = "=:ARB.ETH:::wr:0";

    assert.throws(() => swap(action), /swap: no matching out tx/);
  });

  // A streaming swap of 0.5 BTC that filled 0.3 BTC: Midgard lists the 0.3 swapped as the input and the deposit as
  // streamingSwapMeta.depositedCoin ("blank": the all-zero meta Maya's Midgard can give); `returned` adds the unfilled part
  // paid back to the sender, net of its outbound fee `fee` (networkFees); `inbound` is THORNode's inbound coin
  const partialFill = ({
    deposited,
    returned,
    fee,
    inbound,
    asset = "BTC.BTC",
    toSender = false,
  }: {
    deposited?: number | "blank";
    returned?: number;
    fee?: number;
    inbound?: number;
    asset?: string;
    toSender?: boolean;
  }) => {
    const sender = asset.includes("~") ? "thor1sender" : "bc1sender";
    const action = createMockAction({
      inputAsset: asset,
      inputAmount: 0.3,
      outputAsset: "ETH.ETH",
      outputAmount: 4,
      inputAddress: sender,
      outputAddress: toSender ? sender : "0xreceiver",
      txID: "tx-partial",
    });
    const coin = (amount: number, coinAsset = asset) => ({ asset: coinAsset, amount: "" + Math.round(amount * 1e8) });

    if (deposited !== undefined) {
      action.metadata.swap!.streamingSwapMeta = {
        depositedCoin: deposited === "blank" ? { asset: "", amount: "0" } : coin(deposited),
        inCoin: deposited === "blank" ? { asset: "", amount: "0" } : coin(0.3),
      } as any;
    }

    if (fee !== undefined) {
      action.metadata.swap!.networkFees = [coin(fee, "ETH.ETH"), coin(fee)];
    }

    if (returned !== undefined) {
      action.out.unshift({ address: sender, coins: [coin(returned)], txID: "tx-return" } as Transaction);
    }

    const thornodeTxs: any[] = inbound !== undefined ? [{ tx: { id: "tx-partial", coins: [coin(inbound)] } }] : [];
    return runBundle(
      { source: "midgard", protocol: THORCHAIN.id, wallet: "", data: action, thornodeTxs, cosmosTxs: [] },
      THORCHAIN,
    );
  };

  test("a partly filled streaming swap sends its deposit and nets off the return, also when more is returned than swapped", () => {
    const [tradeOut] = partialFill({ deposited: 0.5, returned: 0.19999 }).rows;

    assert.equal(tradeOut.baseAmount, "0.30001");
    assert.equal(tradeOut.description, "1/2 - Swap 0.30001 BTC to 4 ETH (0.19999 BTC returned unfilled); tx-partial");

    // 0.3 swapped of 1.0: the old netting of the return off the input gave -0.39999
    assert.equal(partialFill({ deposited: 1, returned: 0.69999 }).rows[0].baseAmount, "0.30001");
  });

  test("a deposit in another asset, or not larger than the input, is not the amount sent", () => {
    assert.equal(partialFill({ deposited: 0.3, returned: 0.1 }).rows[0].baseAmount, "0.2");
    assert.equal(partialFill({ deposited: 0.2, returned: 0.1 }).rows[0].baseAmount, "0.2");
  });

  test("with the deposit blank, THORNode's inbound coin is the amount sent, else the input with the return and its outbound fee", () => {
    assert.equal(partialFill({ deposited: "blank", returned: 0.19999, inbound: 0.5 }).rows[0].baseAmount, "0.30001");
    // Maya's Midgard: no node data in the bundle; the refund's input is the return plus its fee
    const maya = partialFill({ deposited: "blank", returned: 0.19999, fee: 0.00001 });
    assert.equal(maya.rows[0].baseAmount, "0.30001");
    assert.deepEqual(maya.issues, []);
  });

  test("with the deposit blank and no fee to rebuild it, the return is netted off the input with a warning", () => {
    const { rows, issues } = partialFill({ deposited: "blank", returned: 0.1 });

    assert.equal(rows[0].baseAmount, "0.2");
    assert.deepEqual(issues, [
      {
        kind: "warning",
        message: "partly filled swap with no deposit listed: the return is netted off the input; check the amount sent",
      },
    ]);
  });

  test("a return with no meta at all is netted off the input, unless THORNode's inbound shows more was sent", () => {
    assert.equal(partialFill({ returned: 0.1 }).rows[0].baseAmount, "0.2");
    assert.equal(partialFill({ returned: 0.1, inbound: 0.5 }).rows[0].baseAmount, "0.4");
  });

  test("an L1 partial fill whose return is not paid yet exports the part swapped, with a warning", () => {
    const { rows, issues } = partialFill({ deposited: 0.5 });

    assert.equal(rows[0].baseAmount, "0.3");
    assert.deepEqual(issues, [
      {
        kind: "warning",
        message:
          "streaming swap filled only partly and its unfilled 0.2 BTC.BTC is not returned yet: only the part swapped is exported; if it is never returned, enter its loss by hand",
      },
    ]);
  });

  test("a trade asset's unfilled part is credited back on THORChain, never returned: the part swapped, with no warning", () => {
    const { rows, issues } = partialFill({ deposited: 0.5, asset: "BTC~BTC" });

    assert.equal(rows[0].baseAmount, "0.3");
    assert.deepEqual(issues, []);
  });

  test("a swap to the sender's own address takes its output, not the unfilled part, whichever is listed first", () => {
    const { rows } = partialFill({ deposited: 0.5, returned: 0.19999, asset: "BTC~BTC", toSender: true });

    assert.equal(rows[0].baseAmount, "0.30001");
    assert.equal(rows[0].quoteCurrency, "ETH");
    assert.equal(rows[1].baseCurrency, "ETH");
  });

  test("a swap that returned all it was sent is a failure, never a row of nothing or less", () => {
    const failed = (result: ReturnType<typeof partialFill>) =>
      result.issues.find((issue) => issue.kind === "failed")?.message;

    assert.match(
      failed(partialFill({ returned: 0.3 })) ?? "",
      /swap: returned 30000000 of 30000000 sent, so nothing was swapped/,
    );
    assert.match(
      failed(partialFill({ deposited: 0.5, returned: 0.5 })) ?? "",
      /swap: returned 50000000 of 50000000 sent/,
    );
  });

  test("Maya: a CACAO input without node data falls back to the 0.2 CACAO native fee", () => {
    const action = createMockAction({
      inputAsset: "MAYA.CACAO",
      inputAmount: 1,
      outputAsset: "THOR.RUNE",
      outputAmount: 1,
      inputAddress: "maya1-user",
      outputAddress: "thor1-user",
      txID: "tx-cacao",
    });

    const result = swap(action, [], MAYA);

    assert.equal(result[0].feeCurrency, "CACAO");
    assert.equal(result[0].feeAmount, "0.2");
    assert.equal(result[0].to, "mayaprotocol");
  });

  test("Maya: a synth swapped from a Maya wallet is the wallet's swap, not a savers withdrawal", () => {
    const action = createMockAction({
      inputAsset: "BTC/BTC",
      inputAmount: 1,
      outputAsset: "MAYA.CACAO",
      outputAmount: 1,
      inputAddress: "maya1-user",
      outputAddress: "maya1-user",
      txID: "tx-maya-synth",
    });

    const result = swap(action, [], MAYA);

    assert.equal(result.length, 2);
    assert.equal(result[0].blockchain, "Mayachain");
  });

  test("Maya: a RUNE input still pays THORChain gas", () => {
    const action = createMockAction({
      inputAsset: "THOR.RUNE",
      inputAmount: 1,
      outputAsset: "KUJI.KUJI",
      outputAmount: 1,
      inputAddress: "thor1-user",
      outputAddress: "kujira1-user",
      txID: "tx-rune",
    });

    const result = swap(action, [], MAYA);

    assert.equal(result[0].feeCurrency, "RUNE");
    assert.equal(result[0].feeAmount, "0.02");
  });
});
