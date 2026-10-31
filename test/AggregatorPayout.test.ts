import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { decodeSymbol, findTokenTransfer } from "../src/sources/evm/EvmReceipts.ts";
import { getAggregatorOutbound } from "../src/sources/Source.ts";
import { runCase, toBundle, type GoldenCaseInput } from "../src/fixtures/GoldenCase.ts";
import { PriceSource } from "../src/sources/Prices.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WALLET = "0x5225c3548a8d143d68c4b266218c1f92add08ac4";
const padded = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const log = (address: string, to: string, amount: bigint) => ({
  address,
  topics: [TRANSFER, padded("0x0000000000000000000000000000000000000001"), padded(to)],
  data: `0x${amount.toString(16)}`,
});
const CASE: GoldenCaseInput = JSON.parse(
  fs.readFileSync("test/cases/swap/rune-to-token-aggregator/input.json", "utf8"),
);

describe("findTokenTransfer", () => {
  const token = "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F";

  test("takes the final token's transfers to the wallet, summed, in any case", () => {
    const logs = [
      log(token, WALLET, 5n),
      log(token, WALLET.replace("5225", "9999"), 7n),
      log("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", WALLET, 9n),
      log(token, WALLET, 6n),
    ];
    assert.deepEqual(findTokenTransfer(logs, WALLET.toUpperCase().replace("0X", "0x"), "2A6f"), {
      contract: token.toLowerCase(),
      amount: "11",
    });
  });

  test("none when the wallet got no such token", () => {
    assert.equal(findTokenTransfer([log(token, WALLET, 5n)], WALLET, "ffff"), undefined);
  });

  test("stops when two tokens fit the memo's tail", () => {
    const other = "0x1111111111111111111111111111111111112a6f";
    assert.throws(() => findTokenTransfer([log(token, WALLET, 5n), log(other, WALLET, 5n)], WALLET, "2a6f"));
  });
});

describe("decodeSymbol", () => {
  test("reads an ABI string and a bytes32", () => {
    const word = (hex: string) => hex.padEnd(64, "0");
    const abi = `0x${(32).toString(16).padStart(64, "0")}${(3).toString(16).padStart(64, "0")}${word("534e58")}`;
    assert.equal(decodeSymbol(abi), "SNX");
    assert.equal(decodeSymbol(`0x${word("4d4b52")}`), "MKR");
  });
});

describe("getAggregatorOutbound", () => {
  const swap = (memo: string, asset = "ETH.ETH") =>
    ({
      type: "swap",
      metadata: { swap: { memo } },
      out: [{ address: WALLET, txID: "AB", coins: [{ asset, amount: "1" }] }],
    }) as any;

  test("a memo with a final token, paid out on an EVM chain", () => {
    assert.deepEqual(getAggregatorOutbound(swap(`=:ETH.ETH:${WALLET}:1:t:15:f2:2a6F:4`)), {
      chain: "ETH",
      txId: "AB",
      to: WALLET,
      tail: "2a6F",
    });
  });

  test("not a plain memo, nor another chain", () => {
    assert.equal(getAggregatorOutbound(swap(`=:ETH.ETH:${WALLET}:1:t:15`)), undefined);
    assert.equal(getAggregatorOutbound(swap(`=:BTC.BTC:${WALLET}:1:t:15:f2:2a6F:4`, "BTC.BTC")), undefined);
  });
});

describe("a swap paid through an aggregator", () => {
  test("the rows name the token delivered, valued at what was given up", () => {
    const [out, into] = runCase(CASE) as any[];
    assert.equal(into.baseCurrency, "SNX");
    assert.equal(out.quoteCurrency, "SNX");
    assert.ok(
      Math.abs(into.baseAmount * into.referencePricePerUnit - out.baseAmount * out.referencePricePerUnit) < 1e-6,
    );
  });

  test("the pool asset when the aggregator delivered no token", () => {
    const failed = { ...CASE, tokenPayout: { ...CASE.tokenPayout!, token: null } };
    const [out, into] = runCase(failed) as any[];
    assert.equal(into.baseCurrency, "ETH");
    assert.equal(into.baseAmount, "6.10188379");
    assert.equal(out.quoteCurrency, "ETH");
    assert.equal(into.referencePricePerUnit, "1822.2074678384636");
  });

  test("no pool price is asked for the token delivered", async () => {
    const asked: string[] = [];
    const midgard = {
      getRunePrice: async () => ({ runePriceUSD: "1" }),
      getPoolPrice: async (key: string) => (asked.push(key), { assetPriceUSD: "" }),
    } as any;
    await new PriceSource(new Map([["thorchain", midgard]])).add(toBundle(CASE));
    assert.deepEqual(asked, []);
  });
});
