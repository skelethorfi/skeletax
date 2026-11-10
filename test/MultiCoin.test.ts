import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../src/interpret/registry.ts";
import { PROTOCOLS, THORCHAIN, type Protocol } from "../src/domain/Protocol.ts";
import { readCaseInput, toBundle } from "../src/fixtures/GoldenCase.ts";
import { oneCoin, onlyCoin } from "../src/sources/thorchain/MidgardUtils.ts";

// A tx can list several coins (a Cosmos MsgSend can carry several denoms). The send, withdrawal and loan
// interpreters map one coin per tx, so a second would be dropped: the action fails instead (#130, #140).
const EXTRA = { asset: "THOR.TCY", amount: "100000000" };

function withExtraCoin(dir: string, txOf: (data: any) => { coins: unknown[] }) {
  const bundle = toBundle(readCaseInput(dir));
  txOf(bundle.data).coins.push(EXTRA);
  return bundle;
}

function failure(bundle: ReturnType<typeof toBundle>, protocol: Protocol = THORCHAIN) {
  const { activities, issues } = interpret(bundle, protocol);
  assert.deepEqual(activities, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "failed");
  return issues[0].message;
}

describe("a tx with several coins", () => {
  test("onlyCoin gives the one coin, undefined for none, and throws for several", () => {
    assert.deepEqual(onlyCoin({ coins: [EXTRA] }, "send"), EXTRA);
    assert.equal(onlyCoin({ coins: [] }, "send"), undefined);
    assert.equal(onlyCoin(undefined, "send"), undefined);
    assert.throws(() => onlyCoin({ coins: [EXTRA, EXTRA] }, "send"), /send: expected 1 coin but there were 2/);
  });

  test("oneCoin gives the one coin and throws for none or several", () => {
    assert.deepEqual(oneCoin({ coins: [EXTRA] }, "bond"), EXTRA);
    assert.throws(() => oneCoin({ coins: [] }, "bond"), /bond: expected 1 coin but there were 0/);
    assert.throws(() => oneCoin(undefined, "bond"), /bond: expected 1 coin but there were 0/);
    assert.throws(() => oneCoin({ coins: [EXTRA, EXTRA] }, "bond"), /bond: expected 1 coin but there were 2/);
  });

  test("the unchanged cases still map", () => {
    for (const dir of [
      "test/cases/send/midgard-rune",
      "test/cases/liquidity/withdraw-btc-rune-symmetric",
      "test/cases/loan/open-btc-borrow-rune",
      "test/cases/loan/repay-btc-loan-with-rune-closed",
    ]) {
      const { activities, issues } = interpret(toBundle(readCaseInput(dir)), THORCHAIN);
      assert.equal(activities.length, 1, dir);
      assert.deepEqual(
        issues.filter((issue) => issue.kind === "failed"),
        [],
        dir,
      );
    }
  });

  test("a send fails", () => {
    const bundle = withExtraCoin("test/cases/send/midgard-rune", (data) => data.in[0]);
    assert.match(failure(bundle), /send: expected 1 coin but there were 2/);
  });

  test("a failed send still gives its fee: it moved no coin", () => {
    const bundle = withExtraCoin("test/cases/send/midgard-rune-failed", (data) => data.in[0]);
    const { activities, issues } = interpret(bundle, THORCHAIN);
    assert.deepEqual(issues, []);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].status, "failed");
  });

  test("a withdrawal fails when an output carries several", () => {
    const bundle = withExtraCoin("test/cases/liquidity/withdraw-btc-rune-symmetric", (data) => data.out[0]);
    assert.match(failure(bundle), /liquidity withdrawal: expected 1 coin but there were 2/);
  });

  test("a loan open fails when its collateral or its payout carries several", () => {
    const input = withExtraCoin("test/cases/loan/open-btc-borrow-rune", (data) => data.in[0]);
    assert.match(failure(input), /loan: expected 1 coin but there were 2/);

    // The payout is the output to the memo's destination; the other output is THORChain's own
    const output = withExtraCoin("test/cases/loan/open-btc-borrow-rune", (data) =>
      data.out.find((out: any) => out.address === "thor1-user-wallet-11111"),
    );
    assert.match(failure(output), /loan: expected 1 coin but there were 2/);
  });

  test("a loan repayment fails when its repayment or the returned collateral carries several", () => {
    const input = withExtraCoin("test/cases/loan/repay-btc-loan-with-rune-closed", (data) => data.in[0]);
    assert.match(failure(input), /loan: expected 1 coin but there were 2/);

    const output = withExtraCoin("test/cases/loan/repay-btc-loan-with-rune-closed", (data) => data.out[0]);
    assert.match(failure(output), /loan: expected 1 coin but there were 2/);
  });

  // Each case below maps today (GoldenCases); with a second coin on the tx it reads, the action fails
  const cases: [string, string, (data: any) => { coins: unknown[] }][] = [
    ["test/cases/swap/eth-to-btc", "swap", (data) => data.in[0]],
    ["test/cases/swap/eth-to-btc", "swap", (data) => data.out.find((out: any) => !out.affiliate)],
    [
      "test/cases/swap/btc-to-wbtc-partial-fill-more-returned",
      "swap return",
      (data) => data.out.find((out: any) => out.coins[0].asset === "BTC.BTC"),
    ],
    ["test/cases/refund/btc-price-limit", "refund", (data) => data.in[0]],
    ["test/cases/switch/bep2-rune", "switch", (data) => data.in[0]],
    ["test/cases/switch/bep2-rune", "switch", (data) => data.out[0]],
    ["test/cases/bond/bond", "bond", (data) => data.in[0]],
    ["test/cases/bond/unbond", "unbond", (data) => data.out[0]],
    ["test/cases/runepool/deposit", "RUNEPool deposit", (data) => data.in[0]],
    ["test/cases/runepool/withdraw", "RUNEPool withdrawal", (data) => data.out[0]],
    ["test/cases/tcy/claim", "TCY claim", (data) => data.out[0]],
    ["test/cases/tcy/stake", "TCY stake", (data) => data.in[0]],
    ["test/cases/tcy/unstake", "TCY unstake", (data) => data.out[0]],
    ["test/cases/thorname/register", "THORName", (data) => data.in[0]],
    ["test/cases/liquidity/add-btc-rune-symmetric", "liquidity add", (data) => data.in[1]],
    ["test/cases/maya/liquidity-auction-rune", "liquidity auction", (data) => data.in.find((tx: any) => !tx.txID)],
    ["test/cases/maya/liquidity-auction-rune", "liquidity auction", (data) => data.in.find((tx: any) => tx.txID)],
  ];

  for (const [dir, what, txOf] of cases) {
    test(`${what} fails (${dir.split("/").slice(-1)[0]})`, () => {
      const protocol = PROTOCOLS[readCaseInput(dir).protocol ?? "thorchain"];
      const message = failure(withExtraCoin(dir, txOf), protocol);
      assert.match(message, new RegExp(`${what}: expected 1 coin but there were 2`));
    });
  }

  test("a liquidity auction fails when a RUNE deposit it found carries several", () => {
    const dir = "test/cases/maya/liquidity-auction-rune";
    const bundle = toBundle(readCaseInput(dir));
    bundle.inbounds![0].in[0].coins.push(EXTRA);
    assert.match(failure(bundle, PROTOCOLS.maya), /liquidity auction deposit: expected 1 coin but there were 2/);
  });
});
