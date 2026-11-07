import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../src/interpret/registry.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { readCaseInput, toBundle } from "../src/fixtures/GoldenCase.ts";
import { onlyCoin } from "../src/sources/thorchain/MidgardUtils.ts";

// A tx can list several coins (a Cosmos MsgSend can carry several denoms). The send, withdrawal and loan
// interpreters map one coin per tx, so a second would be dropped: the action fails instead (#130).
const EXTRA = { asset: "THOR.TCY", amount: "100000000" };

function withExtraCoin(dir: string, txOf: (data: any) => { coins: unknown[] }) {
  const bundle = toBundle(readCaseInput(dir));
  txOf(bundle.data).coins.push(EXTRA);
  return bundle;
}

function failure(bundle: ReturnType<typeof toBundle>) {
  const { activities, issues } = interpret(bundle, THORCHAIN);
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
});
