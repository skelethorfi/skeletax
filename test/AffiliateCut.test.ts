import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Action } from "@xchainjs/xchain-midgard";
import { affiliateCut, amountBeforeCut, depositBeforeCut } from "../src/interpret/midgard/affiliate.ts";
import {
  affiliateBps,
  isAddAfterCut,
  isSwapAfterCut,
  SWAP_CUT_BEFORE_HEIGHT,
} from "../src/sources/thorchain/MidgardUtils.ts";
import { MAYA, THORCHAIN } from "../src/domain/Protocol.ts";

describe("affiliateCut", () => {
  test("rounds half up, as THORNode's GetSafeShare", () => {
    assert.equal(affiliateCut(2500n, 30n), 8n); // 7.5
    assert.equal(affiliateCut(2499n, 30n), 7n); // 7.497
    assert.equal(affiliateCut(1000025578345n, 15n), 1500038368n);
  });
});

describe("amountBeforeCut", () => {
  test("the deposit that leaves what Midgard lists", () => {
    assert.equal(amountBeforeCut(998525539977n, [15n]), 1000025578345n);
    assert.equal(amountBeforeCut(3550554656240n, [30n]), 3561238371354n);
    assert.equal(amountBeforeCut(1759938896n, [30n]), 1765234600n);
  });

  test("each affiliate's cut is rounded on its own", () => {
    const deposit = 123456789n;
    const listed = deposit - affiliateCut(deposit, 10n) - affiliateCut(deposit, 25n);
    assert.equal(amountBeforeCut(listed, [10n, 25n]), deposit);
  });

  test("two deposits can leave the same amount: the smaller is given", () => {
    assert.equal(2500n - affiliateCut(2500n, 30n), 2492n);
    assert.equal(2499n - affiliateCut(2499n, 30n), 2492n);
    assert.equal(amountBeforeCut(2492n, [30n]), 2499n);
  });

  test("no fee, or fees of the whole deposit", () => {
    assert.equal(amountBeforeCut(1000n, []), undefined);
    assert.equal(amountBeforeCut(1000n, [10000n]), undefined);
  });
});

describe("depositBeforeCut", () => {
  const listed = { asset: "THOR.RUNE", amount: "998525539977" };

  test("THORNode's inbound coin when the bundle has it", () => {
    const result = depositBeforeCut(listed, [15n], { asset: "THOR.RUNE", amount: "1000025578345" }, "TX");
    assert.deepEqual(result, { coin: { asset: "THOR.RUNE", amount: "1000025578345" }, basis: "observed", issues: [] });
  });

  test("the inbound coin wins over the gross-up, with a warning when they differ", () => {
    const result = depositBeforeCut(listed, [15n], { asset: "THOR.RUNE", amount: "1000100000000" }, "TX");
    assert.equal(result.coin.amount, "1000100000000");
    assert.equal(result.issues.length, 1);
  });

  test("else Midgard's coin grossed up", () => {
    const result = depositBeforeCut(listed, [15n], undefined, "TX");
    assert.deepEqual(result, { coin: { asset: "THOR.RUNE", amount: "1000025578345" }, basis: "default", issues: [] });
  });

  test("an inbound coin of another asset, or below Midgard's, is not used", () => {
    assert.equal(depositBeforeCut(listed, [15n], { asset: "BTC.BTC", amount: "1" }, "TX").basis, "default");
    assert.equal(depositBeforeCut(listed, [15n], { asset: "THOR.RUNE", amount: "1" }, "TX").basis, "default");
  });
});

describe("which actions Midgard lists after the cut", () => {
  const swap = (height: number, affiliateFee: string, affiliateOut = false, address = "thor1wallet") =>
    ({
      type: "swap",
      height: String(height),
      in: [{ address, coins: [{ asset: "THOR.RUNE", amount: "1" }], txID: "TX" }],
      out: [
        { address: "0xdest", coins: [], txID: "" },
        ...(affiliateOut ? [{ address: "thor1aff", coins: [], txID: "", affiliate: true }] : []),
      ],
      metadata: { swap: { affiliateFee } },
    }) as unknown as Action;

  test("a native THORChain swap with a fee before v3.0.0, with no affiliate output", () => {
    assert.equal(isSwapAfterCut(swap(SWAP_CUT_BEFORE_HEIGHT - 1, "30"), THORCHAIN), true);
  });

  test("not from v3.0.0, nor with an affiliate output, a zero fee, an L1 deposit or on Maya", () => {
    assert.equal(isSwapAfterCut(swap(SWAP_CUT_BEFORE_HEIGHT, "30"), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(100, "30", true), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(100, "0"), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(100, "30", false, "bc1wallet"), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(100, "30", false, "maya1wallet"), MAYA), false);
  });

  test("an add with a fee, at any height", () => {
    const add = (affiliateFee: string) =>
      ({ type: "addLiquidity", metadata: { addLiquidity: { affiliateFee } } }) as unknown as Action;
    assert.equal(isAddAfterCut(add("100")), true);
    assert.equal(isAddAfterCut(add("0")), false);
    assert.equal(isAddAfterCut(add("")), false);
  });

  test("several affiliates' fees", () => {
    assert.deepEqual(affiliateBps(swap(100, "10/25")), [10n, 25n]);
  });
});
