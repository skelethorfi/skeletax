import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { Anonymiser, findSurvivors } from "../src/fixtures/Anonymise.ts";
import { PrivateData } from "../src/fixtures/PrivateData.ts";
import { getActionShape, sameShape } from "../src/fixtures/Shape.ts";
import { findCaseDirs, readCaseInput, runCase } from "../src/fixtures/GoldenCase.ts";

const TXID = "1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF";
const THOR = "thor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const BTC = "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

const swap = (overrides: any = {}) => ({
  date: "1700000000000000000",
  height: "1",
  status: "success",
  type: "swap",
  pools: ["BTC.BTC"],
  in: [{ address: BTC, txID: TXID, coins: [{ asset: "BTC.BTC", amount: "100000000" }] }],
  out: [{ address: THOR, txID: "", coins: [{ asset: "THOR.RUNE", amount: "5000000000" }] }],
  metadata: {
    swap: {
      txType: "swap",
      memo: `=:THOR.RUNE:${THOR}`,
      liquidityFee: "1000",
      networkFees: [{ asset: "THOR.RUNE", amount: "2000000" }],
    },
  },
  ...overrides,
});

describe("PrivateData", () => {
  test("loads addresses, txids and denylist entries from a private folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-private-"));
    fs.outputFileSync(path.join(dir, "a.toml"), `address = "${THOR}"\n`);
    fs.outputJsonSync(path.join(dir, "cache/x.json"), { txID: TXID.toLowerCase(), zero: "0".repeat(64) });
    fs.outputFileSync(path.join(dir, "private-denylist.txt"), "# note\nsecret-label\n");

    const data = PrivateData.load(dir);

    assert.equal(data.isPrivate(THOR.toUpperCase()), true);
    assert.equal(data.isPrivate(TXID), true);
    assert.equal(data.isPrivate("0".repeat(64)), false);
    assert.equal(data.findIn(`hello secret-label ${TXID}`).length, 2);
  });

  test("is empty when the private folder does not exist", () => {
    assert.equal(PrivateData.load("/nonexistent/tc-ct").patterns.size, 0);
  });
});

describe("Shape", () => {
  test("same type, subtype and assets have the same shape regardless of addresses and amounts", () => {
    const other = swap({ in: [{ address: "bc1qother", txID: "X", coins: [{ asset: "BTC.BTC", amount: "1" }] }] });

    assert.equal(sameShape(getActionShape(swap() as any), getActionShape(other as any)), true);
  });

  test("contract shape includes the contract type and the denoms in funds", () => {
    const bond = (funds: string) => ({
      type: "contract",
      status: "success",
      in: [{ coins: [] }],
      out: [{ coins: [] }],
      metadata: { contract: { contractType: "wasm-rujira-staking/liquid.bond", funds } },
    });

    assert.partialDeepStrictEqual(getActionShape(bond("100x/ruji") as any), {
      subtype: "wasm-rujira-staking/liquid.bond",
      funds: ["x/ruji"],
    });
    assert.equal(sameShape(getActionShape(bond("100x/ruji") as any), getActionShape(bond("5x/ruji") as any)), true);
    assert.equal(sameShape(getActionShape(bond("100x/ruji") as any), getActionShape(bond("5rune") as any)), false);
  });

  test("a protocol-initiated swap is a different shape from a user swap", () => {
    const preferred = swap({ metadata: { swap: { txType: "swap", memo: "MAYA-PREFERRED-ASSET-dx" } } });
    const shortForm = swap({ metadata: { swap: { txType: "swap", memo: `s:THOR.RUNE:${THOR}` } } });

    assert.equal(getActionShape(preferred as any).memoAction, "maya-preferred-asset");
    assert.equal(sameShape(getActionShape(swap() as any), getActionShape(preferred as any)), false);
    assert.equal(sameShape(getActionShape(swap() as any), getActionShape(shortForm as any)), true);
  });

  test("different assets or subtype are a different shape", () => {
    const eth = swap({ in: [{ address: "0x1", txID: "X", coins: [{ asset: "ETH.ETH", amount: "1" }] }] });
    const loan = swap({ metadata: { swap: { txType: "loanOpen" } } });

    assert.equal(sameShape(getActionShape(swap() as any), getActionShape(eth as any)), false);
    assert.equal(sameShape(getActionShape(swap() as any), getActionShape(loan as any)), false);
  });
});

describe("Anonymiser", () => {
  const anon = new Anonymiser().anonymise(swap());
  const text = JSON.stringify(anon);

  test("replaces addresses and txids everywhere, including inside memos", () => {
    assert.ok(!text.includes(THOR));
    assert.ok(!text.includes(BTC));
    assert.ok(!text.includes(TXID));
    assert.equal(anon.in[0].address, "bc1-anon-wallet-1");
    assert.equal(anon.out[0].address, "thor1-anon-wallet-2");
    assert.equal(anon.metadata.swap.memo, "=:THOR.RUNE:thor1-anon-wallet-2");
  });

  test("fixes an EVM receipt's block, ranks its fee as one amount, and keeps its hash matching the txid", () => {
    // Fee 0x7a12 × 0x2540be400 wei = 0.0003125 ETH: between the 0.0001 and 1 amounts
    const input = {
      data: { in: [{ txID: TXID.toUpperCase(), coins: [{ amount: "100000000" }] }], fees: ["10000"] },
      evmReceipts: [
        {
          chain: "ETH",
          transactionHash: `0x${TXID.toLowerCase()}`,
          blockNumber: "0xabc123",
          status: "0x1",
          gasUsed: "0x7a12",
          effectiveGasPrice: "0x2540be400",
          l1Fee: "0x0",
        },
      ],
    };
    const out = new Anonymiser().anonymise(input);
    const receipt = out.evmReceipts[0];
    const fee = (receipt: any) => BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    const toWei = (baseUnits: string) => BigInt(baseUnits) * 10n ** 10n;

    assert.equal(receipt.blockNumber, `0x${BigInt(10000000).toString(16)}`);
    assert.equal(receipt.status, "0x1");
    assert.equal(receipt.l1Fee, undefined);
    assert.ok(
      fee(receipt) > toWei(out.data.fees[0]) && fee(receipt) < toWei(out.data.in[0].coins[0].amount),
      "ranked among the amounts",
    );
    assert.equal(receipt.transactionHash.toLowerCase(), `0x${out.data.in[0].txID.toLowerCase()}`);
  });

  test("maps the same value to the same placeholder", () => {
    const again = new Anonymiser().anonymise({ a: THOR, b: THOR.toUpperCase(), t1: TXID, t2: TXID.toLowerCase() });

    assert.equal(again.a, again.b);
    assert.equal(again.t1, again.t2);
    assert.match(again.t1, /^[0-9A-F]{64}$/);
  });

  test("ranks amounts and sets every date and block height to one fixed value", () => {
    assert.ok(BigInt(anon.in[0].coins[0].amount) > BigInt(anon.metadata.swap.networkFees[0].amount));
    assert.equal(BigInt(anon.metadata.swap.networkFees[0].amount) % 1_000_000_000n, 0n);
    // A real date or height would point straight at the original block
    assert.equal(anon.date, "1609419600000000000");
    assert.equal(anon.height, "10000000");
  });

  test("ranks contract funds and attribute amounts", () => {
    const contract = new Anonymiser().anonymise({
      funds: "100x/ruji,20rune",
      attributes: { amount: "100", shares: "80", owner: THOR },
    });

    assert.deepEqual(contract, {
      funds: "3000000000x/ruji,1000000000rune",
      attributes: { amount: "3000000000", shares: "2000000000", owner: "thor1-anon-wallet-1" },
    });
  });

  test("ranks Cosmos event amounts and keeps contract addresses", () => {
    const contract = "thor13g83nn5ef4qzqeafp0508dnvkvm0zqr3sj7eefcn5umu65gqluusrml5cr";
    const event = new Anonymiser().anonymise({
      type: "transfer",
      attributes: [
        { key: "recipient", value: contract },
        { key: "sender", value: THOR },
        { key: "amount", value: "100x/ruji" },
      ],
    });

    assert.deepEqual(event.attributes, [
      { key: "recipient", value: contract },
      { key: "sender", value: "thor1-anon-wallet-1" },
      { key: "amount", value: "1000000000x/ruji" },
    ]);
  });

  test("fixes every height, time and price, and replaces affiliates", () => {
    const out = new Anonymiser().anonymise({
      height: "12345678",
      metadata: {
        swap: {
          affiliateAddress: "xx/yy",
          memo: `=:ETH.ETH:${THOR}:1000/1/0:xx/yy:15/25`,
          inPriceUSD: "1.5",
          streamingSwapMeta: { lastHeight: "12345681" },
        },
      },
      stages: { inbound_finalised: { completed: true }, outbound_signed: { scheduled_outbound_height: 12345690 } },
      timestamp: "2025-08-16T22:34:43Z",
      distribution: { date: "1700000000" },
      usdPrices: { "BTC.BTC": "16647.47", "THOR.RUNE": "1.19" },
    });

    assert.equal(out.height, "10000000");
    assert.equal(out.metadata.swap.streamingSwapMeta.lastHeight, "10000000");
    assert.equal(out.stages.outbound_signed.scheduled_outbound_height, 10000000);
    assert.equal(out.metadata.swap.affiliateAddress, "name1/name2");
    // Ranks: 1 < 15 < 25 < 1000
    assert.equal(
      out.metadata.swap.memo,
      "=:ETH.ETH:thor1-anon-wallet-1:4000000000/1000000000/0:name1/name2:2000000000/3000000000",
    );
    assert.equal(
      new Anonymiser().anonymise({ memo: "=:ETH.ETH:x:1000:t:10:20:ab:12345678901234567890123" }).memo,
      "=:ETH.ETH:name1:3000000000:name2:1000000000:2000000000:name3:4000000000",
    );
    assert.equal(out.metadata.swap.inPriceUSD, "1");
    assert.deepEqual(out.usdPrices, { "BTC.BTC": "1", "THOR.RUNE": "1" });
    assert.equal(out.timestamp, "2020-12-31T13:00:00Z");
    assert.equal(out.distribution.date, "1609419600");
    assert.equal(new Anonymiser().anonymise({ timestamp: 1714000000000 }).timestamp, 1609419600000);
  });

  test("replaces every amount by its rank: equal amounts stay equal and order is kept, nothing else", () => {
    const out = new Anonymiser().anonymise({
      a: "500",
      b: "100",
      c: "500",
      zero: "0",
      negative: "-100",
      price: "1.25",
      other: "0.5",
      funds: "100x/ruji,20rune",
      memo: "=:ETH.ETH:x:500/1/0",
    });

    // 1 (the memo's streaming interval) < 20 < 100 < 500
    assert.deepEqual(out, {
      a: "4000000000",
      b: "3000000000",
      c: "4000000000",
      zero: "0",
      negative: "-3000000000",
      price: "20.5",
      other: "10.5",
      funds: "3000000000x/ruji,2000000000rune",
      memo: "=:ETH.ETH:name1:4000000000/1000000000/0",
    });
  });

  test("finds what survives anonymising and is not already public", () => {
    const original = { memo: "=:ETH.ETH:secretname:1000", note: "Rarely", pool: "BTC.BTC" };

    assert.deepEqual(
      findSurvivors(
        original,
        { memo: "=:ETH.ETH:name1:1000000000", note: "Rarely", pool: "BTC.BTC" },
        new Set(["btc"]),
      ),
      ["rarely"],
    );
    assert.deepEqual(findSurvivors(original, new Anonymiser().anonymise(original), new Set()), ["rarely"]);
  });

  test("replaces signatures, account sequences, fee coins, refund reasons and JSON inside strings", () => {
    const signature = "MEUCIQD8mY0mQ0b3a5xq1yJt2w7vE9r5mP3+ZkLx1u7QpWlqAiBq/Zx9w==";
    const out = new Anonymiser().anonymise({
      events: [
        {
          type: "tx",
          attributes: [
            { key: "signature", value: signature },
            { key: "acc_seq", value: `${THOR}/1234` },
            { key: "fee", value: "2000000rune" },
          ],
        },
      ],
      fee: [{ denom: "rune", amount: "2000000" }],
      reason: `emit asset 12345 less than price limit 67890 for ${THOR}`,
      msg: '{"swap":{"min_return":"987654321","to":"' + THOR + '"}}',
    });

    assert.equal(out.events[0].attributes[0].value, "anon-blob-1");
    assert.equal(out.events[0].attributes[1].value, "thor1-anon-wallet-1/1");
    // The fee attribute and the fee amount are the same coin, so they get the same rank
    assert.equal(out.events[0].attributes[2].value, `${out.fee[0].amount}rune`);
    assert.equal(out.reason, "anonymised");
    assert.deepEqual(JSON.parse(out.msg), { swap: { min_return: "2000000000", to: "thor1-anon-wallet-1" } });
  });

  test("anonymises every memo kind: numbers ranked, names replaced, actions and assets kept", () => {
    const out = new Anonymiser().anonymise({
      memos: [
        `UNBOND:${THOR}:500000000000`,
        `-:BTC/BTC:10000`,
        `+:BTC.BTC:${BTC}:myname:30`,
        `=:BTC.BTC:myname`,
        `$+:BTC.BTC:${BTC}:123456`,
      ].map((memo) => ({ memo })),
    });

    assert.deepEqual(
      out.memos.map((item: any) => item.memo),
      [
        "UNBOND:thor1-anon-wallet-1:4000000000",
        "-:BTC/BTC:2000000000",
        "+:BTC.BTC:bc1-anon-wallet-2:name1:1000000000",
        "=:BTC.BTC:name1",
        "$+:BTC.BTC:bc1-anon-wallet-2:3000000000",
      ],
    );
  });

  test("keeps token contracts in asset names, ranks equal decimals alike, and handles large and ISO values", () => {
    const usdc = "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    const out = new Anonymiser().anonymise({
      asset: usdc,
      a: "1.50",
      b: "1.5",
      big: 1e21,
      time: "2025-08-16T22:34:43.123Z",
    });

    assert.equal(out.asset, usdc);
    assert.equal(out.a, out.b);
    assert.equal(out.big, 1000000000);
    assert.equal(out.time, "2020-12-31T13:00:00Z");
  });

  test("keeps the all-zero placeholder txid", () => {
    assert.equal(new Anonymiser().anonymise({ txID: "0".repeat(64) }).txID, "0".repeat(64));
  });

  test("anonymised existing cases still map without errors", () => {
    for (const dir of findCaseDirs(path.join(import.meta.dirname, "cases"))) {
      const input = readCaseInput(dir);
      assert.doesNotThrow(() => runCase(new Anonymiser().anonymise(input)));
    }
  });
});
