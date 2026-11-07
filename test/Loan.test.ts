import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, Leg } from "../src/domain/Activity.ts";
import { parseAmount } from "../src/domain/Amount.ts";
import { toAsset } from "../src/domain/Asset.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { loanOpenRows, loanRepayRows } from "../src/export/summ/loan.ts";
import { interpret } from "../src/interpret/registry.ts";
import { readCaseInput, toBundle } from "../src/fixtures/GoldenCase.ts";

describe("loan rows", () => {
  const IN = "a".repeat(64);
  const OUT = "b".repeat(64);
  const leg = (direction: Leg["direction"], wallet: string, notation: string, amount: string, txid: string): Leg => ({
    direction,
    wallet,
    asset: toAsset(notation),
    amount: parseAmount(amount, 8),
    role: "principal",
    basis: "observed",
    txid,
  });
  const activity = (kind: Activity["kind"], legs: Leg[], details: Record<string, string> = {}): Activity => ({
    id: `midgard/swap.${IN}`,
    protocol: "thorchain",
    kind,
    status: "success",
    time: new Date("2024-03-01T10:00:00Z"),
    legs,
    prices: [],
    details,
  });

  test("a loan paid out to an L1 wallet names its payout txid; one paid in RUNE does not", () => {
    const toBtc = loanOpenRows(
      activity("loan.open", [
        leg("out", "0xwallet", "ETH.ETH", "100000000", IN),
        leg("in", "bc1wallet", "BTC.BTC", "1000000", OUT),
      ]),
      THORCHAIN,
    );
    const toRune = loanOpenRows(
      activity("loan.open", [
        leg("out", "bc1wallet", "BTC.BTC", "100000000", IN),
        leg("in", "thor1wallet", "THOR.RUNE", "1000000", ""),
      ]),
      THORCHAIN,
    );

    assert.deepEqual(
      toBtc.map((row) => row.description),
      [
        `1/2 - LoanOpen deposit ETH to borrow BTC; ${IN}`,
        `2/2 - LoanOpen deposit ETH to borrow BTC; ${IN}; paid out in ${OUT}`,
      ],
    );
    assert.equal(toRune[1].description, `2/2 - LoanOpen deposit BTC to borrow RUNE; ${IN}`);
  });

  test("collateral paid back to an L1 wallet names its payout txid", () => {
    const rows = loanRepayRows(
      activity(
        "loan.repay",
        [leg("out", "thor1wallet", "THOR.RUNE", "100000000", IN), leg("in", "bc1wallet", "BTC.BTC", "1000000", OUT)],
        { collateral: "BTC.BTC" },
      ),
      THORCHAIN,
    );

    assert.deepEqual(
      rows.map((row) => row.description),
      [
        `1/2 - LoanRepayment deposit RUNE to repay BTC loan. Closed loan; ${IN}`,
        `2/2 - LoanRepayment deposit RUNE to repay BTC loan. Closed loan; ${IN}; paid out in ${OUT}`,
      ],
    );
  });
});

describe("loan repayment interpretation", () => {
  // A closed repayment: RUNE in, BTC collateral back to bc1-user-wallet-aaaaa
  const closedCase = () => toBundle(readCaseInput("test/cases/loan/repay-btc-loan-with-rune-closed"));
  const output = (address: string, asset: string, amount: string, txID: string) => ({
    address,
    coins: [{ asset, amount }],
    height: "10000000",
    txID,
  });
  const collateralLegs = (activity: Activity) =>
    activity.legs
      .filter((item) => item.direction === "in")
      .map((item) => [item.wallet, item.asset.notation, item.amount.base, item.txid]);

  test("an extra output does not hide the collateral; it is not exported and raises a warning", () => {
    const bundle = closedCase();
    const action = bundle.data as any;
    action.out = [output("thor1-user-wallet-11111", "THOR.RUNE", "1000000", ""), ...action.out];

    const { activities, issues } = interpret(bundle, THORCHAIN);

    assert.deepEqual(collateralLegs(activities[0]), [["bc1-user-wallet-aaaaa", "BTC.BTC", 123000000n, undefined]]);
    assert.deepEqual(issues, [
      {
        kind: "warning",
        message:
          "loan repayment: output of 0.01 THOR.RUNE to thor1-user-wallet-11111 is not the BTC.BTC collateral paid to the memo's destination; not exported",
      },
    ]);
  });

  test("an output to the destination in another asset is not the collateral", () => {
    const bundle = closedCase();
    (bundle.data as any).out = [output("bc1-user-wallet-aaaaa", "ETH.ETH", "5", "c".repeat(64))];

    const { activities, issues } = interpret(bundle, THORCHAIN);

    assert.deepEqual(collateralLegs(activities[0]), []);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "warning");
  });

  test("collateral paid back in two outputs is two legs and one row, their total, naming both txids", () => {
    const bundle = closedCase();
    (bundle.data as any).out = [
      output("bc1-user-wallet-aaaaa", "BTC.BTC", "100000000", "c".repeat(64)),
      output("BC1-USER-WALLET-AAAAA", "BTC.BTC", "23000000", "d".repeat(64)),
    ];

    const { activities, issues } = interpret(bundle, THORCHAIN);
    const rows = loanRepayRows(activities[0], THORCHAIN);

    assert.deepEqual(issues, []);
    assert.equal(collateralLegs(activities[0]).length, 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].baseAmount, "1.23");
    assert.match(rows[1].description ?? "", new RegExp(`; paid out in ${"c".repeat(64)}, ${"d".repeat(64)}$`));
  });

  test("a memo with no destination fails with a clear error", () => {
    const bundle = closedCase();
    (bundle.data as any).metadata.swap.memo = "loan-:BTC.BTC";

    assert.deepEqual(
      interpret(bundle, THORCHAIN).issues.map((issue) => [issue.kind, issue.message.split(". ")[0]]),
      [["failed", "[Midgard] loan: the memo names no destination (loan-:BTC.BTC)"]],
    );
  });
});
