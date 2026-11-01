import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { memoDestination, memoRefundAddress } from "../src/sources/thorchain/MidgardUtils.ts";
import { runCaseLayers, type GoldenCaseInput } from "../src/fixtures/GoldenCase.ts";

describe("memoDestination", () => {
  test("the destination alone", () => {
    assert.equal(memoDestination("=:BTC.BTC:bc1dest:0/1/0", 2), "bc1dest");
  });

  test("a destination followed by a refund address", () => {
    assert.equal(memoDestination("=:l:ltc1dest/0xRefund:9256977/0/0:-_/t1:0/70", 2), "ltc1dest");
  });

  test("an empty or missing destination", () => {
    assert.equal(memoDestination("=:ARB.ETH:::wr:0", 2), undefined);
    assert.equal(memoDestination("=:ARB.ETH:/0xRefund", 2), undefined);
    assert.equal(memoDestination("=:ARB.ETH", 2), undefined);
  });
});

describe("memoRefundAddress", () => {
  test("the address after the destination, if any", () => {
    assert.equal(memoRefundAddress("=:l:ltc1dest/0xRefund:9256977/0/0", 2), "0xRefund");
    assert.equal(memoRefundAddress("=:l:ltc1dest:9256977/0/0", 2), undefined);
    assert.equal(memoRefundAddress("=:l:ltc1dest/:9256977/0/0", 2), undefined);
  });
});

describe("a partly filled swap whose unfilled part goes to the memo's refund address", () => {
  const CASE: GoldenCaseInput = JSON.parse(
    fs.readFileSync("test/cases/swap/btc-to-wbtc-partial-fill-more-returned/input.json", "utf8"),
  );
  const REFUND = "bc1qrefundaddressnotthesender";
  const toRefund = structuredClone(CASE);
  const action = toRefund.data as any;
  action.metadata.swap.memo = action.metadata.swap.memo.replace(/^(=:[^:]*:[^:]*)/, `$1/${REFUND}`);
  action.out.find((out: any) => out.coins[0].asset === "BTC.BTC").address = REFUND;

  test("is returned to that address, and the deposit is the whole amount sent", () => {
    const legs = (input: GoldenCaseInput) =>
      runCaseLayers(input).activities.flatMap((activity) =>
        activity.legs.map((leg) => ({ role: leg.role, wallet: leg.wallet, amount: leg.amount })),
      );
    const expected = legs(CASE).map((leg) => (leg.role === "returned" ? { ...leg, wallet: REFUND } : leg));

    assert.ok(expected.some((leg) => leg.role === "returned"));
    assert.deepEqual(legs(toRefund), expected);
  });
});
