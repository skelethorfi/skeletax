import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { isMemoName, memoDestination, memoRefundAddress } from "../src/sources/thorchain/MidgardUtils.ts";
import { runCaseLayers, type GoldenCaseInput } from "../src/fixtures/GoldenCase.ts";
import type { SummRow } from "../src/export/summ/csv/index.ts";

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

  test("gives the same rows as a return to the sender, with a warning to record the transfer", () => {
    const warnings = (input: GoldenCaseInput) =>
      runCaseLayers(input).issues.filter(
        (issue) => issue.kind === "warning" && issue.message.includes("refund address"),
      );

    assert.deepEqual(runCaseLayers(toRefund).rows, runCaseLayers(CASE).rows);
    assert.equal(warnings(CASE).length, 0);
    assert.equal(warnings(toRefund).length, 1);
    assert.match(warnings(toRefund)[0].message, new RegExp(`${REFUND}, not the sender`));
  });
});

describe("a refund paid to the memo's refund address", () => {
  const CASE: GoldenCaseInput = JSON.parse(fs.readFileSync("test/cases/refund/btc-price-limit/input.json", "utf8"));
  const REFUND = "bc1qrefundaddressnotthesender";
  const toRefund = structuredClone(CASE);
  const action = toRefund.data as any;
  action.metadata.refund.memo = action.metadata.refund.memo.replace(/^(=:[^:]*:[^:]*)/, `$1/${REFUND}`);
  action.out[0].address = REFUND;
  const legs = (input: GoldenCaseInput) =>
    runCaseLayers(input).activities.flatMap((activity) =>
      activity.legs.map((leg) => ({ role: leg.role, wallet: leg.wallet, amount: leg.amount })),
    );
  const warnings = (input: GoldenCaseInput) =>
    runCaseLayers(input).issues.filter((issue) => issue.kind === "warning" && issue.message.includes("returned"));

  test("puts the return in the wallet it was paid to", () => {
    const expected = legs(CASE).map((leg) => (leg.role === "returned" ? { ...leg, wallet: REFUND } : leg));

    assert.ok(expected.some((leg) => leg.role === "returned"));
    assert.deepEqual(legs(toRefund), expected);
  });

  test("keeps the sender's spelling when the output's address differs only in case", () => {
    const upper = structuredClone(CASE);
    (upper.data as any).out[0].address = (upper.data as any).out[0].address.toUpperCase();

    assert.deepEqual(legs(upper), legs(CASE));
    assert.equal(warnings(upper).length, 0);
  });

  test("gives the sender's rows unchanged and the return's failed-in on the wallet paid, with a warning", () => {
    const rows = runCaseLayers(toRefund).rows as SummRow[];
    const sender = runCaseLayers(CASE).rows as SummRow[];
    assert.deepEqual(
      rows.filter((row) => row.type !== "failed-in"),
      sender.filter((row) => row.type !== "failed-in"),
    );
    assert.deepEqual(
      rows.filter((row) => row.type === "failed-in").map((row) => [row.wallet, row.to]),
      [[REFUND, REFUND]],
    );
    assert.equal(warnings(CASE).length, 0);
    assert.equal(warnings(toRefund).length, 1);
    assert.match(warnings(toRefund)[0].message, new RegExp(`went to ${REFUND}, not the sender`));
  });

  test("paid to several addresses, stays with the sender and warns", () => {
    const split = structuredClone(CASE);
    const out = (split.data as any).out[0];
    const half = (BigInt(out.coins[0].amount) / 2n).toString();
    const rest = (BigInt(out.coins[0].amount) - BigInt(half)).toString();
    (split.data as any).out = [
      { ...out, coins: [{ ...out.coins[0], amount: half }] },
      { ...out, address: REFUND, coins: [{ ...out.coins[0], amount: rest }] },
    ];

    assert.deepEqual(legs(split), legs(CASE));
    assert.equal(warnings(split).length, 1);
    assert.match(warnings(split)[0].message, /several addresses/);
  });
});

describe("isMemoName", () => {
  test("a THORName, not an address", () => {
    for (const name of ["myname", "t", "My-Name_2+x", "a".repeat(30)]) {
      assert.equal(isMemoName(name), true, name);
    }

    for (const address of [
      "bc1q3n2x86ch2tadpuqv47txyvt868wy0kqtcjgedy",
      "0x34579bf6ce7a381d84002ca85a94b8915de6a004",
      "thor160yye65pf9rzwrgqmtgav69n6zlsyfpgm9a7xk",
      "TPKiLHN9k9Kg3ZMQrS26m4tbsdqPYK1xZF",
      "a".repeat(31),
    ]) {
      assert.equal(isMemoName(address), false, address);
    }
  });
});

describe("a swap whose memo names a THORName as its destination", () => {
  const load = (name: string): GoldenCaseInput =>
    JSON.parse(fs.readFileSync(`test/cases/swap/${name}/input.json`, "utf8"));
  // The same swap with the destination field's address replaced by a name, as THORChain would pay it
  const toName = (input: GoldenCaseInput, name = "myname"): GoldenCaseInput => {
    const named = structuredClone(input);
    const swap = (named.data as any).metadata.swap;
    swap.memo = swap.memo.replace(/^([^:]*:[^:]*:)[^:/]*/, `$1${name}`);
    return named;
  };

  for (const name of [
    "eth-to-btc", // an affiliate output in RUNE
    "tcy-to-rune-affiliate", // the affiliate output in the same asset as the swap's, listed first
    "bsc-usdt-to-ltc-refund-address", // a refund address after the name
    "btc-to-wbtc-partial-fill-more-returned", // the unfilled part returned to the sender
    "trade-partial-fill-credited", // two outputs to the destination
  ]) {
    test(`gives the rows of the swap to the address it resolved to: ${name}`, () => {
      const input = load(name);
      const named = toName(input);

      assert.notEqual((named.data as any).metadata.swap.memo, (input.data as any).metadata.swap.memo);
      assert.deepEqual(runCaseLayers(named).rows, runCaseLayers(input).rows);
      assert.deepEqual(
        runCaseLayers(named).activities,
        runCaseLayers(input).activities.map((a) => ({ ...a, memo: (named.data as any).metadata.swap.memo })),
      );
    });
  }

  test("fails, saying the destination is a name, when two addresses could be what it resolved to", () => {
    const named = toName(load("eth-to-btc"));
    const action = named.data as any;
    action.out.push({ ...structuredClone(action.out[0]), address: "bc1qanotheraddressthatwaspaidtoo" });

    assert.throws(() => runCaseLayers(named), /destination "myname" is a name, not an address, and 2 addresses/);
  });

  test("fails, saying the destination is a name, when only affiliates and returns were paid", () => {
    const named = toName(load("eth-to-btc"));
    const action = named.data as any;
    action.out = action.out.filter((out: any) => out.affiliate);

    assert.throws(() => runCaseLayers(named), /destination "myname" is a name, not an address, and 0 addresses/);
  });

  test("an address no output was paid to still fails as before", () => {
    const input = load("eth-to-btc");
    const action = structuredClone(input);
    (action.data as any).out[0].address = "bc1qsomeoneelsewaspaidinsteadofthememo";

    assert.throws(() => runCaseLayers(action), /swap: no matching out tx\. type/);
  });
});

describe("a loan whose memo names a THORName as its destination", () => {
  test("fails, saying the destination is a name", () => {
    const input: GoldenCaseInput = JSON.parse(
      fs.readFileSync("test/cases/loan/open-btc-borrow-rune/input.json", "utf8"),
    );
    const named = structuredClone(input);
    const swap = (named.data as any).metadata.swap;
    swap.memo = swap.memo.replace("thor1-user-wallet-11111", "myname");

    assert.throws(() => runCaseLayers(named), /loan: no matching out tx: the memo's destination "myname" is a name/);
  });

  test("a repayment to a name exports no collateral and its warning says why", () => {
    const input: GoldenCaseInput = JSON.parse(
      fs.readFileSync("test/cases/loan/repay-btc-loan-with-rune-closed/input.json", "utf8"),
    );
    const named = structuredClone(input);
    const swap = (named.data as any).metadata.swap;
    swap.memo = swap.memo.replace("bc1-user-wallet-aaaaa", "myname");

    const { issues } = runCaseLayers(named);
    assert.match(issues.map((i) => i.message).join("\n"), /"myname" is a name, which loans do not resolve/);
  });
});
