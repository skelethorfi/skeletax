import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { memoDestination } from "../src/sources/thorchain/MidgardUtils.ts";

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
