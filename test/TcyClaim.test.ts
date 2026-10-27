import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../src/interpret/registry.ts";
import type { RawBundle } from "../src/sources/RawBundle.ts";
import type { TcyClaimData } from "../src/sources/tcy/TcyClaimService.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { readCaseInput, toBundle } from "../src/fixtures/GoldenCase.ts";
import { TcyClaimService } from "../src/sources/tcy/TcyClaimService.ts";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { http } from "../src/sources/http.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The savers claim case, with what the claim was for (claim list entries, savers positions, loans) replaced
function claimWith(tcyClaim: TcyClaimData | undefined): RawBundle {
  const { tcyClaim: _, ...bundle } = toBundle(readCaseInput("test/cases/tcy/claim-savers"));
  return tcyClaim ? { ...bundle, tcyClaim } : bundle;
}

const entry = { asset: "DOGE.DOGE", amount: "7047904076" };
const savers = [{ asset: "DOGE.DOGE", units: "17819458477" }];
const loan = { collateralAsset: "DOGE.DOGE", collateralDeposited: "500000000000", collateralWithdrawn: "0" };

function legsAndIssues(bundle: RawBundle) {
  const { activities, issues } = interpret(bundle, THORCHAIN);
  return {
    legs: activities[0].legs.map((leg) => `${leg.direction} ${leg.asset.notation}`),
    issues: issues.map((issue) => issue.kind),
  };
}

describe("TCY claim: what it was for (docs/specs/thorfi-collapse.md)", () => {
  test("a savers record of the entry's asset gives up the position for the TCY", () => {
    assert.deepEqual(legsAndIssues(claimWith({ claims: [entry], savers, loans: [] })), {
      legs: ["out DOGE/DOGE", "in THOR.TCY"],
      issues: [],
    });
  });

  test("a loan's claim is the TCY alone, with a warning", () => {
    const saversNone = [{ asset: "DOGE.DOGE", units: "0" }];
    assert.deepEqual(legsAndIssues(claimWith({ claims: [entry], savers: saversNone, loans: [loan] })), {
      legs: ["in THOR.TCY"],
      issues: ["warning"],
    });
  });

  test("a loan repaid in full is not a loan claim", () => {
    const repaid = { ...loan, collateralWithdrawn: loan.collateralDeposited };
    assert.deepEqual(legsAndIssues(claimWith({ claims: [entry], savers, loans: [repaid] })).legs, [
      "out DOGE/DOGE",
      "in THOR.TCY",
    ]);
  });

  test("savers and a loan in the same asset share one entry: the TCY alone, with a warning", () => {
    assert.deepEqual(legsAndIssues(claimWith({ claims: [entry], savers, loans: [loan] })), {
      legs: ["in THOR.TCY"],
      issues: ["warning"],
    });
  });

  test("no entry of the claim's amount: the TCY alone, with a warning", () => {
    const other = { ...entry, amount: "1" };
    assert.deepEqual(legsAndIssues(claimWith({ claims: [other], savers, loans: [] })), {
      legs: ["in THOR.TCY"],
      issues: ["warning"],
    });
  });

  test("a bundle without the claim's data (stored before it was fetched) is the TCY alone", () => {
    assert.deepEqual(legsAndIssues(claimWith(undefined)), { legs: ["in THOR.TCY"], issues: [] });
  });
});

describe("TCY claim list", () => {
  test("a failed fetch is not kept: the next call fetches again", async () => {
    const service = new TcyClaimService(new RecordStore(mkdtempSync(join(tmpdir(), "tc-ct-tcy-claim-"))));
    const get = http.get;
    let calls = 0;
    (http as any).get = async () => {
      calls += 1;
      throw new Error("gateway timeout");
    };

    try {
      await assert.rejects((service as any).loadClaimList(), /gateway timeout/);
      await assert.rejects((service as any).loadClaimList(), /gateway timeout/);
      assert.equal(calls, 2);
    } finally {
      (http as any).get = get;
    }
  });
});
