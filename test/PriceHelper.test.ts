import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, Leg } from "../src/domain/Activity.ts";
import { parseDecimal } from "../src/domain/Amount.ts";
import { toAsset, toPositionAsset } from "../src/domain/Asset.ts";
import { MAYA, THORCHAIN } from "../src/domain/Protocol.ts";
import { addLiquidityRows, auctionPositionRows, withdrawRows } from "../src/export/summ/liquidity.ts";

const leg = (direction: Leg["direction"], wallet: string, notation: string, base: bigint): Leg => ({
  direction,
  wallet,
  asset: toAsset(notation),
  amount: { base, decimals: 8 },
  role: "principal",
  basis: "observed",
  txid: "TX",
});

const position = (direction: Leg["direction"], pool: string): Leg => ({
  direction,
  wallet: "thor1user",
  asset: toPositionAsset(pool),
  amount: { base: 100000000n, decimals: 8 },
  role: "principal",
  basis: "observed",
  txid: "TX",
});

const activity = (kind: Activity["kind"], legs: Leg[], details: Record<string, string> = {}): Activity => ({
  id: `midgard/${kind}.TX`,
  protocol: "thorchain",
  kind,
  status: "success",
  time: new Date("2024-01-01T00:00:00Z"),
  legs,
  prices: [],
  details,
});

const helper = (rows: { trace?: { role: string }; baseAmount: string }[]) =>
  rows.find((row) => row.trace?.role === "price-helper")!.baseAmount;

// docs/specs/liquidity.md, Price helper: the first asset's amount times the number of assets, exact
describe("price helper amount", () => {
  test("a symmetric add of a tiny first side is written as a decimal, not 1e-7", () => {
    const rows = addLiquidityRows(
      activity("lp.add", [
        leg("out", "bc1quser", "BTC.BTC", 5n),
        leg("out", "thor1user", "THOR.RUNE", 300000000n),
        position("in", "BTC.BTC"),
      ]),
      THORCHAIN,
    );

    assert.equal(helper(rows), "0.0000001");
  });

  test("a symmetric withdrawal of a tiny first payout is written as a decimal, not 1e-7", () => {
    const rows = withdrawRows(
      activity("lp.withdraw", [
        position("out", "BTC.BTC"),
        leg("in", "thor1user", "THOR.RUNE", 5n),
        leg("in", "bc1quser", "BTC.BTC", 300000000n),
      ]),
      THORCHAIN,
    );

    assert.equal(helper(rows), "0.0000001");
  });

  test("a liquidity auction's side twice is exact", () => {
    const rows = auctionPositionRows(
      {
        ...activity("lp.auction.position", [position("in", "BTC.BTC")], {
          side: "0.00000005",
          sideAsset: "BTC.BTC",
        }),
        protocol: "maya",
      },
      MAYA,
      "pool-units",
    );

    assert.equal(helper(rows), "0.0000001");
  });
});

describe("parseDecimal", () => {
  test("reads a decimal string exactly, with as many decimals as it has", () => {
    assert.deepEqual(parseDecimal("0.1"), { base: 1n, decimals: 1 });
    assert.deepEqual(parseDecimal("12"), { base: 12n, decimals: 0 });
    assert.deepEqual(parseDecimal("-0.00000005"), { base: -5n, decimals: 8 });
    assert.throws(() => parseDecimal("1e-7"), /Invalid decimal amount/);
  });
});
