import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Action } from "@xchainjs/xchain-midgard";
import { affiliateCut, amountBeforeCut, depositBeforeCut } from "../src/interpret/midgard/affiliate.ts";
import {
  affiliateBps,
  isAddAfterCut,
  isSwapAfterCut,
  isSwapCutUnknown,
  SWAP_CUT_BEFORE_HEIGHT,
} from "../src/sources/thorchain/MidgardUtils.ts";
import { MAYA, THORCHAIN } from "../src/domain/Protocol.ts";

describe("affiliateCut", () => {
  test("rounds half up, as THORNode's GetSafeShare", () => {
    assert.equal(affiliateCut(2500n, 30n), 8n); // 7.5
    assert.equal(affiliateCut(2499n, 30n), 7n); // 7.497
    assert.equal(affiliateCut(1000025578345n, 15n), 1500038368n);
  });

  test("or half to even, as older versions did", () => {
    assert.equal(affiliateCut(2500n, 30n, true), 8n); // 7.5 → 8
    assert.equal(affiliateCut(500n, 30n, true), 2n); // 1.5 → 2
    assert.equal(affiliateCut(2500n, 10n, true), 2n); // 2.5 → 2
    assert.equal(amountBeforeCut(2498n, [10n]), 2500n);
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

  test("no warning when the inbound coin less the cut is Midgard's amount, or is Midgard's amount itself", () => {
    const tie = depositBeforeCut(
      { asset: "THOR.RUNE", amount: "2492" },
      [30n],
      { asset: "THOR.RUNE", amount: "2500" },
      "TX",
    );
    assert.deepEqual(tie.issues, []);
    assert.equal(tie.coin.amount, "2500");
    const whole = depositBeforeCut(listed, [15n], { asset: "THOR.RUNE", amount: listed.amount }, "TX");
    assert.deepEqual(whole.issues, []);
    assert.equal(whole.coin.amount, listed.amount);
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

  test("an inbound coin below Midgard's is not used, and says so", () => {
    const result = depositBeforeCut(listed, [15n], { asset: "THOR.RUNE", amount: "1" }, "TX");
    assert.equal(result.coin.amount, "1000025578345");
    assert.equal(result.issues.length, 1);
  });

  test("an inbound coin of another asset, or below Midgard's, is not used", () => {
    assert.equal(depositBeforeCut(listed, [15n], { asset: "BTC.BTC", amount: "1" }, "TX").basis, "default");
    assert.equal(depositBeforeCut(listed, [15n], { asset: "THOR.RUNE", amount: "1" }, "TX").basis, "default");
  });
});

describe("which actions Midgard lists after the cut", () => {
  const swap = (
    height: number,
    memo: string,
    opts: { affiliateOut?: boolean; address?: string; asset?: string } = {},
  ) =>
    ({
      type: "swap",
      height: String(height),
      in: [
        {
          address: opts.address ?? "thor1wallet",
          coins: [{ asset: opts.asset ?? "THOR.RUNE", amount: "1" }],
          txID: "TX",
        },
      ],
      out: [
        { address: "0xdest", coins: [], txID: "" },
        ...(opts.affiliateOut ? [{ address: "thor1aff", coins: [], txID: "", affiliate: true }] : []),
      ],
      metadata: { swap: { memo, affiliateFee: memo.split(":")[5] ?? "" } },
    }) as unknown as Action;
  const thor = SWAP_CUT_BEFORE_HEIGHT[THORCHAIN.id];
  const maya = SWAP_CUT_BEFORE_HEIGHT[MAYA.id];
  const memo = "=:ETH.ETH:0xdest:0:t:30";
  const cacao = { address: "maya1wallet", asset: "MAYA.CACAO" };

  test("RUNE or CACAO swapped before the cut became part of the outbound", () => {
    assert.equal(isSwapAfterCut(swap(thor.nativeAsset - 1, memo), THORCHAIN), true);
    assert.equal(isSwapAfterCut(swap(thor.nativeAsset, memo), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(maya.nativeAsset - 1, memo, cacao), MAYA), true);
    assert.equal(isSwapAfterCut(swap(maya.nativeAsset, memo, cacao), MAYA), false);
  });

  test("a synth swapped before the cut became a swap of its own", () => {
    assert.equal(isSwapAfterCut(swap(thor.otherAsset - 1, memo, { asset: "BTC/BTC" }), THORCHAIN), true);
    assert.equal(isSwapAfterCut(swap(thor.otherAsset, memo, { asset: "BTC/BTC" }), THORCHAIN), false);
    assert.equal(
      isSwapAfterCut(swap(maya.otherAsset, memo, { address: "maya1wallet", asset: "BTC/BTC" }), MAYA),
      false,
    );
  });

  test("never a trade asset, a zero fee or an L1 deposit", () => {
    assert.equal(isSwapAfterCut(swap(100, memo, { asset: "BTC~BTC" }), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(100, "=:ETH.ETH:0xdest:0:t:0"), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(100, memo, { address: "bc1wallet", asset: "BTC.BTC" }), THORCHAIN), false);
  });

  test("Midgard's affiliate flag is not read: it can mark a partial fill's return", () => {
    assert.equal(isSwapAfterCut(swap(100, memo, { affiliateOut: true }), THORCHAIN), true);
  });

  test("the refund of such a swap", () => {
    const refund = swap(100, memo);
    (refund as any).type = "refund";
    (refund as any).metadata = { refund: { memo } };
    assert.equal(isSwapAfterCut(refund, THORCHAIN), true);
  });

  test("an add with a fee, at any height", () => {
    const add = (memo: string) =>
      ({ type: "addLiquidity", metadata: { addLiquidity: { memo, affiliateFee: "" } } }) as unknown as Action;
    assert.equal(isAddAfterCut(add("+:BTC.BTC:bc1paired:wr:100")), true);
    assert.equal(isAddAfterCut(add("+:BTC.BTC:bc1paired:wr:0")), false);
    assert.equal(isAddAfterCut(add("+:BTC.BTC:bc1paired")), false);
  });

  test("several affiliates' fees, read from the memo (Midgard's affiliateFee holds one fee only)", () => {
    const action = swap(100, "=:ETH.ETH:0xdest:0:a/b:10/25");
    (action.metadata as any).swap.affiliateFee = "";
    assert.deepEqual(affiliateBps(action), [10n, 25n]);
  });

  test("a fee with no affiliate named is no cut; Midgard's affiliateFee when the memo has none", () => {
    assert.deepEqual(affiliateBps(swap(100, "=:ETH.ETH:0xdest:0::30")), []);
    const action = swap(100, "");
    (action.metadata as any).swap.affiliateFee = "20";
    assert.deepEqual(affiliateBps(action), [20n]);
  });
  test("one fee for several affiliates applies to each of them", () => {
    assert.deepEqual(affiliateBps(swap(100, "=:ETH.ETH:0xdest:0:a/b:10")), [10n, 10n]);
  });

  test("a Maya name with no fee: its default fee may be cut, from Mayanode v1.112.0", () => {
    const noFee = "=:ETH.ETH:0xdest:0:wr";
    assert.equal(isSwapCutUnknown(swap(maya.otherAsset, noFee, cacao), MAYA), true);
    assert.equal(isSwapCutUnknown(swap(maya.otherAsset - 1, noFee, cacao), MAYA), false);
    assert.equal(isSwapCutUnknown(swap(100, noFee), THORCHAIN), false);
    assert.equal(isSwapAfterCut(swap(maya.otherAsset, noFee, cacao), MAYA), false);
  });

  test("only the refund of a swap memo", () => {
    const refund = (memo: string) =>
      ({ ...swap(100, memo), type: "refund", metadata: { refund: { memo } } }) as unknown as Action;
    assert.equal(isSwapAfterCut(refund("s:ETH.ETH:0xdest:0:t:30"), THORCHAIN), true);
    assert.equal(isSwapAfterCut(refund("+:ETH.ETH:0xpaired:t:30:x"), THORCHAIN), false);
  });
});
