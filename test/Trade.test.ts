import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import type { Action } from "@xchainjs/xchain-midgard";
import type { RawBundle } from "../src/sources/RawBundle.ts";
import { readCaseInput, toBundle } from "../src/fixtures/GoldenCase.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { runBundle } from "../src/pipeline/run.ts";
import { getInboundTxs } from "../src/sources/Source.ts";

const caseInput = (name: string): RawBundle =>
  toBundle(readCaseInput(path.join(import.meta.dirname, "cases/trade", name)));

const withAction = (bundle: RawBundle, change: (action: Action) => void): RawBundle => {
  const copy = structuredClone(bundle);
  change(copy.data as Action);
  return copy;
};

describe("trade account deposits and withdrawals (docs/specs/trade.md)", () => {
  test("a deposit is a bridge from the L1 wallet to the THORChain wallet, with the L1 gas as fee", () => {
    const { rows, issues } = runBundle(caseInput("bch-deposit"), THORCHAIN);
    assert.deepEqual(issues, []);
    assert.deepEqual(
      rows.map((row) => [row.type, row.baseCurrency, row.baseAmount, row.blockchain, row.feeCurrency ?? ""]),
      [
        ["bridge-out", "BCH", "38.11880243", "BCH", "BCH"],
        ["bridge-in", "BCH", "38.11880243", "THORChain", ""],
      ],
    );
  });

  test("a withdrawal bridges what was paid out, and the outbound fee kept is a fee row", () => {
    const { rows } = runBundle(caseInput("btc-withdraw"), THORCHAIN);
    assert.deepEqual(
      rows.map((row) => [row.type, row.baseCurrency, row.baseAmount, row.blockchain, row.feeAmount ?? ""]),
      [
        ["bridge-out", "BTC", "0.81586418", "THORChain", "0.02"],
        ["bridge-in", "BTC", "0.81586418", "BTC", ""],
        ["fee", "BTC", "0.00002641", "THORChain", ""],
      ],
    );
  });

  test("a withdrawal that pays out all it was sent has no fee row", () => {
    const bundle = withAction(caseInput("btc-withdraw"), (action) => {
      action.out[0].coins[0].amount = action.in[0].coins[0].amount;
    });
    assert.deepEqual(
      runBundle(bundle, THORCHAIN).rows.map((row) => row.type),
      ["bridge-out", "bridge-in"],
    );
  });

  test("with prefixTradeAssets, the trade asset side is named ThorTrade and keeps its row IDs", () => {
    const plain = runBundle(caseInput("bch-deposit"), THORCHAIN).rows;
    const prefixed = runBundle(caseInput("bch-deposit"), THORCHAIN, { assets: { prefixTradeAssets: true } }).rows;
    assert.deepEqual(
      prefixed.map((row) => row.baseCurrency),
      ["BCH", "ThorTrade.BCH.BCH"],
    );
    assert.deepEqual(
      prefixed.map((row) => row.id),
      plain.map((row) => row.id),
    );
  });

  test("an action that is neither a deposit nor a withdrawal fails rather than export a guess", () => {
    const bundle = withAction(caseInput("bch-deposit"), (action) => {
      action.out[0].coins[0].asset = "BCH.BCH";
    });
    const { rows, issues } = runBundle(bundle, THORCHAIN);
    assert.deepEqual(rows, []);
    assert.equal(issues[0]?.kind, "failed");
    assert.match(issues[0].message, /neither a deposit nor a withdrawal/);
  });

  test("a payout larger than what was sent fails", () => {
    const bundle = withAction(caseInput("btc-withdraw"), (action) => {
      action.out[0].coins[0].amount = "999999999";
    });
    const { rows, issues } = runBundle(bundle, THORCHAIN);
    assert.deepEqual(rows, []);
    assert.match(issues[0]?.message ?? "", /more than the .* sent/);
  });

  test("a deposit not credited in full, or an action with a second coin, fails", () => {
    const short = withAction(caseInput("bch-deposit"), (action) => {
      action.out[0].coins[0].amount = String(BigInt(action.out[0].coins[0].amount) - 1n);
    });
    assert.match(runBundle(short, THORCHAIN).issues[0]?.message ?? "", /deposit of .* credited/);
    const two = withAction(caseInput("btc-withdraw"), (action) => {
      action.in[0].coins.push({ ...action.in[0].coins[0] });
    });
    assert.match(runBundle(two, THORCHAIN).issues[0]?.message ?? "", /expected one coin in and one out, got 2 in/);
  });

  test("the L1 inbound of a deposit is looked up for its gas; a withdrawal, sent on THORChain, is not", () => {
    assert.deepEqual(getInboundTxs(caseInput("bch-deposit").data as Action), [
      { txId: "313FEF87E25E1D14E7CE35EC13B8D6AE2D2654158FF59B317768769883D67A54", asset: "BCH.BCH" },
    ]);
    assert.deepEqual(getInboundTxs(caseInput("btc-withdraw").data as Action), []);
  });
});
