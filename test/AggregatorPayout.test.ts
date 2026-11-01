import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { decodeSymbol, EvmReceipts, findTokenTransfer } from "../src/sources/evm/EvmReceipts.ts";
import { http } from "../src/sources/http.ts";
import { getActionShape } from "../src/fixtures/Shape.ts";
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

  test("skips an NFT's transfer, and a zero amount is no payout", () => {
    const nft = { ...log(token, WALLET, 5n), topics: [...log(token, WALLET, 5n).topics, padded(WALLET)], data: "0x" };
    assert.equal(findTokenTransfer([nft], WALLET, "2a6f"), undefined);
    assert.equal(findTokenTransfer([log(token, WALLET, 0n)], WALLET, "2a6f"), undefined);
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

  test("a destination followed by a refund address", () => {
    assert.equal(getAggregatorOutbound(swap(`=:ETH.ETH:${WALLET}/bc1refund:1:t:15:f2:2a6F:4`))?.to, WALLET);
  });

  test("not a loan", () => {
    const memo = `=:ETH.ETH:${WALLET}:1:t:15:f2:2a6F:4`;
    const loan = (txType: string, asset = "THOR.RUNE") => ({
      ...swap(memo),
      in: [{ coins: [{ asset }] }],
      metadata: { swap: { memo, txType } },
    });
    assert.equal(getAggregatorOutbound(loan("loanOpen")), undefined);
    assert.equal(getAggregatorOutbound(loan("loanRepayment")), undefined);
    assert.equal(getAggregatorOutbound(loan("noOp", "THOR.TOR")), undefined);
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

  test("a warning when the memo names a token and none arrived", async () => {
    const { runBundle } = await import("../src/pipeline/run.ts");
    const { getProtocol } = await import("../src/domain/Protocol.ts");
    const failed = { ...CASE, tokenPayout: { ...CASE.tokenPayout!, token: null } };
    const { issues } = runBundle(toBundle(failed), getProtocol(undefined));
    assert.ok(issues.some((issue) => issue.kind === "warning" && issue.message.includes("final token")));
  });

  test("the symbol is upper case, and one that reads as another currency fails", () => {
    const withSymbol = (symbol: string) => ({
      ...CASE,
      tokenPayout: { ...CASE.tokenPayout!, token: { ...CASE.tokenPayout!.token!, symbol } },
    });
    assert.equal((runCase(withSymbol("snx")) as any[])[1].baseCurrency, "SNX");
    assert.throws(() => runCase(withSymbol("UNI-V2")), /does not fit/);
    assert.throws(() => runCase(withSymbol("LUNA")), /does not fit/);
    assert.throws(() => runCase(withSymbol("A/B")), /does not fit/);
  });
});

describe("the shape of a swap", () => {
  test("an aggregator swap is not the same shape as a plain one", () => {
    const plain = (CASE.data as any).metadata.swap.memo.split(":").slice(0, 6).join(":");
    const data = { ...(CASE.data as any), metadata: { swap: { ...(CASE.data as any).metadata.swap, memo: plain } } };
    assert.equal(getActionShape(CASE.data as any).finalToken, true);
    assert.equal(getActionShape(data).finalToken, undefined);
  });
});

describe("getTokenPayout", () => {
  const token = "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f";
  const store = {
    addedSinceReplay: () => false,
    record: (_source: string, _key: string, fetch: () => Promise<{ data: unknown }>) =>
      fetch().then((fetched) => fetched.data),
  } as any;
  const answer = (receipt: object) => async (_url: string, body: any) => ({
    data: {
      result:
        body.method === "eth_getTransactionReceipt"
          ? { transactionHash: "0xab", ...receipt }
          : body.params[0].data === "0x95d89b41"
            ? `0x${"534e58".padEnd(64, "0")}`
            : "0x12",
    },
  });
  const fetchWith = (receipt: object) => {
    mock.method(http, "post", answer(receipt));
    return new EvmReceipts(store, { ETH: "https://rpc.test" }).getTokenPayout("ETH", "AB", WALLET, "2a6f");
  };

  test("reads the token, its symbol and decimals", async (t) => {
    t.after(() => mock.restoreAll());
    assert.deepEqual(await fetchWith({ status: "0x1", logs: [log(token, WALLET, 5n)] }), {
      chain: "ETH",
      transactionHash: "0xab",
      token: { contract: token, amount: "5", symbol: "SNX", decimals: 18 },
    });
  });

  test("no token when none reached the wallet", async (t) => {
    t.after(() => mock.restoreAll());
    const payout = await fetchWith({ status: "0x1", logs: [] });
    assert.equal(payout?.token, null);
  });

  test("stops on a reverted tx or a receipt with no logs, so nothing is stored", async (t) => {
    t.after(() => mock.restoreAll());
    await assert.rejects(fetchWith({ status: "0x0", logs: [] }), /not a successful tx/);
    await assert.rejects(fetchWith({ status: "0x1" }), /not a successful tx/);
  });

  test("names the token when it answers nothing or an error", async (t) => {
    t.after(() => mock.restoreAll());
    const reply = (result: unknown, error?: object) => async (_url: string, body: any) => ({
      data:
        body.method === "eth_getTransactionReceipt"
          ? { result: { transactionHash: "0xab", status: "0x1", logs: [log(token, WALLET, 5n)] } }
          : { result, error },
    });
    const run = () => new EvmReceipts(store, { ETH: "https://rpc.test" }).getTokenPayout("ETH", "AB", WALLET, "2a6f");
    mock.method(http, "post", reply("0x"));
    await assert.rejects(run(), new RegExp(`${token}: no symbol`));
    mock.restoreAll();
    mock.method(http, "post", reply(undefined, { code: 3, message: "execution reverted" }));
    await assert.rejects(run(), new RegExp(`${token} symbol`));
  });

  test("a replay of a run from before this source keeps the pool asset", async () => {
    const replay = { ...store, addedSinceReplay: () => true };
    assert.equal(await new EvmReceipts(replay, { ETH: "x" }).getTokenPayout("ETH", "AB", WALLET, "2a6f"), undefined);
  });
});
