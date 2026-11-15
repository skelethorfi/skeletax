import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../src/interpret/registry.ts";
import type { RawBundle } from "../src/sources/RawBundle.ts";
import type { TcyClaimData } from "../src/sources/tcy/TcyClaimService.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { readCaseInput, runCaseLayers, toBundle } from "../src/fixtures/GoldenCase.ts";
import { TcyClaimService } from "../src/sources/tcy/TcyClaimService.ts";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { MIDGARD_LIST, midgardActionBaseKey, midgardActionKey } from "../src/sources/store/Sources.ts";
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

// The synth claim case (a THORChain address that held synths), with what the claim was for replaced
function synthClaimWith(tcyClaim: TcyClaimData | undefined): RawBundle {
  const { tcyClaim: _, ...bundle } = toBundle(readCaseInput("test/cases/tcy/claim-synth"));
  return tcyClaim ? { ...bundle, tcyClaim } : bundle;
}

const vthor = { asset: "ETH.VTHOR-0X815C23ECA83261B6EC689B60CC4A58B54BC24D8D", amount: "3384014717" };
const heldVthor = { asset: "ETH/VTHOR-0X815C23ECA83261B6EC689B60CC4A58B54BC24D8D", amount: "15121614613" };
const avax = { asset: "AVAX.AVAX", amount: "26435473" };

describe("TCY claim for a synth the address held (docs/specs/thorfi-collapse.md, Synths)", () => {
  const claim = (tcyClaim: TcyClaimData | undefined) => interpret(synthClaimWith(tcyClaim), THORCHAIN);
  const legs = (tcyClaim: TcyClaimData | undefined) =>
    claim(tcyClaim).activities[0].legs.map((leg) => `${leg.direction} ${leg.role} ${leg.asset.notation}`);

  test("the whole holding of the entry's synth is given up for the TCY", () => {
    assert.deepEqual(legs({ claims: [vthor], savers: [], loans: [], synths: [heldVthor] }), [
      `out principal ${heldVthor.asset}`,
      "in principal THOR.TCY",
      "out gas THOR.RUNE",
    ]);
  });

  test("a synth of another asset, no synth record, or a savers position of the asset: not a synth claim", () => {
    const other = { asset: "BTC/BTC", amount: "5" };
    assert.deepEqual(legs({ claims: [vthor], savers: [], loans: [], synths: [other] }), [
      "in principal THOR.TCY",
      "out gas THOR.RUNE",
    ]);
    assert.deepEqual(legs({ claims: [vthor], savers: [], loans: [] }), ["in principal THOR.TCY", "out gas THOR.RUNE"]);
    const saversOfIt = [{ asset: "ETH.VTHOR-0X815C23ECA83261B6EC689B60CC4A58B54BC24D8D", units: "7" }];
    assert.equal(
      legs({ claims: [vthor], savers: saversOfIt, loans: [], synths: [heldVthor] })[0],
      "out principal ETH/VTHOR-0X815C23ECA83261B6EC689B60CC4A58B54BC24D8D",
    );
    assert.equal(
      claim({ claims: [vthor], savers: saversOfIt, loans: [], synths: [heldVthor] }).activities[0].legs[0].asset.kind,
      "position",
    );
  });

  test("of several entries, only the one whose asset sorts first pays the fee and keeps the key without its amount", () => {
    const entries = { claims: [vthor, avax], savers: [], loans: [], synths: [heldVthor] };
    const { activities } = claim(entries);
    assert.equal(
      activities[0].legs.some((leg) => leg.role === "gas"),
      false,
    );
    assert.match(activities[0].id, /\.3384014717$/);
    const firstOnly = claim({ ...entries, claims: [vthor, { ...avax, amount: "0" }] }).activities[0];
    assert.equal(
      firstOnly.legs.some((leg) => leg.role === "gas"),
      true,
    );
    assert.doesNotMatch(firstOnly.id, /\.3384014717$/);
  });

  test("two entries of the claim's amount: one action for both, receiving the TCY of both, with a warning", () => {
    const twin = { asset: "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", amount: vthor.amount };
    const { activities, issues } = claim({ claims: [vthor, twin], savers: [], loans: [], synths: [heldVthor] });
    const principal = activities[0].legs.filter((leg) => leg.role === "principal");
    assert.deepEqual(
      principal.map((leg) => leg.direction),
      ["in"],
    );
    assert.equal(principal[0].amount.base, 2n * BigInt(vthor.amount));
    assert.deepEqual(
      issues.map((issue) => issue.kind),
      ["warning"],
    );
  });

  test("with several entries, an action that matches none is not the first: no fee, its own key", () => {
    const { activities } = claim({ claims: [{ ...vthor, amount: "1" }, avax], savers: [], loans: [], synths: [] });
    assert.equal(
      activities[0].legs.some((leg) => leg.role === "gas"),
      false,
    );
    assert.match(activities[0].id, /\.3384014717$/);
  });
});

describe("the actions of one claim tx (docs/specs/thorfi-collapse.md)", () => {
  const action = synthClaimWith(undefined).data as any;
  const paying = (amount: string) => ({
    ...action,
    out: [{ ...action.out[0], coins: [{ ...action.out[0].coins[0], amount }] }],
  });

  test("each entry's action has its own key, by its TCY amount", () => {
    assert.notEqual(midgardActionKey(paying("1")), midgardActionKey(paying("2")));
    assert.match(midgardActionKey(paying("1")), /^tcy_claim\.[0-9A-F]{64}\.1$/);
  });

  test("a wallet's list stores each entry once, and two actions nothing tells apart as one", async () => {
    const store = new RecordStore(mkdtempSync(join(tmpdir(), "tc-ct-tcy-claim-")));
    const listed = await store.list(
      "midgard",
      "thor1-user-wallet-11111",
      async () => ({ data: [paying("99"), paying("99"), paying("100")], url: "" }),
      MIDGARD_LIST,
    );
    assert.equal(listed.length, 2);
  });
  test("a store whose list has a claim under its old key lists it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-ct-tcy-claim-"));
    const oldKey = (item: any) => midgardActionBaseKey(item);
    await new RecordStore(dir).list("midgard", "w", async () => ({ data: [paying("5")], url: "" }), {
      ...MIDGARD_LIST,
      keyOf: oldKey,
    });
    const listed = await new RecordStore(dir).list(
      "midgard",
      "w",
      async () => ({ data: [paying("5")], url: "" }),
      MIDGARD_LIST,
    );
    assert.equal(listed.length, 1);
  });

  test("other actions listed twice still stop the run", async () => {
    const store = new RecordStore(mkdtempSync(join(tmpdir(), "tc-ct-tcy-claim-")));
    const send = { ...paying("5"), type: "send" };
    await assert.rejects(
      store.list("midgard", "w", async () => ({ data: [send, send], url: "" }), MIDGARD_LIST),
      /two records with the key/,
    );
  });
});

describe("the claim tx's fee row (docs/specs/thorfi-collapse.md, The claim tx and its fee)", () => {
  const input = readCaseInput("test/cases/tcy/claim-synth");
  const rune = input.usdPrices?.["THOR.RUNE"];
  const rows = (tcyClaim: TcyClaimData) => runCaseLayers({ ...input, tcyClaim }).rows as Record<string, string>[];

  test("a receive claim from the THORChain wallet: the fee row first, at RUNE's price, and no fee on the claim's rows", () => {
    const out = rows({ claims: [vthor], savers: [], loans: [], synths: [] });
    assert.deepEqual(
      out.map((row) => row.type),
      ["fee", "receive", "staking-deposit"],
    );
    assert.deepEqual([out[0].baseCurrency, out[0].baseAmount, out[0].referencePricePerUnit], ["RUNE", "0.02", rune]);
    assert.equal(
      out.slice(1).some((row) => row.feeAmount),
      false,
    );
  });

  test("a synth claim: the synth valued at the TCY, the fee at RUNE", () => {
    const out = rows({ claims: [vthor], savers: [], loans: [], synths: [heldVthor] });
    assert.equal(out[0].referencePricePerUnit, rune);
    const tcyPrice = Number(input.usdPrices?.["THOR.TCY"]);
    const expected = (Number(vthor.amount) * tcyPrice) / Number(heldVthor.amount);
    const given = Number(out.find((row) => row.type === "bridge-trade-out")?.referencePricePerUnit);
    assert.ok(Math.abs(given - expected) < expected * 1e-9, `${given} ≈ ${expected}`);
  });
});
