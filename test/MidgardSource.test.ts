import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BUNDLE_CONCURRENCY, MidgardSource } from "../src/sources/Source.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";

describe("MidgardSource bundles", () => {
  const action = (txID: string) =>
    ({
      type: "swap",
      status: "success",
      date: (Date.UTC(2023, 0, 8) * 1e6).toString(),
      height: "1",
      pools: [],
      in: [{ address: "thor1wallet", txID, coins: [{ asset: "THOR.RUNE", amount: "100" }] }],
      out: [{ address: "thor1wallet", txID: "", coins: [{ asset: "BTC/BTC", amount: "1" }] }],
      metadata: { swap: {} },
    }) as any;

  test("are built a few at a time, and listed in Midgard's order", async () => {
    const txIds = ["A", "B", "C", "D", "E", "F", "G", "H"];
    let running = 0;
    let most = 0;
    const thornode = {
      // Later actions answer sooner, so the bundles finish out of order
      getTxStatus: async (txId: string) => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5 * (txIds.length - txIds.indexOf(txId))));
        running--;
        return { tx: { id: txId } };
      },
    };
    const source = new MidgardSource(
      THORCHAIN,
      { getActions: async () => txIds.map(action), getRunePrice: async () => ({ runePriceUSD: "1" }) } as any,
      thornode as any,
      { getTx: async () => ({}) } as any,
    );

    const bundles = await source.bundlesFor("thor1wallet");

    assert.deepEqual(
      bundles.map((bundle) => (bundle.data as any).in[0].txID),
      txIds,
    );
    assert.deepEqual(
      bundles.map((bundle) => (bundle.thornodeTxs[0] as any).tx.id),
      txIds,
    );
    assert.equal(most, BUNDLE_CONCURRENCY);
  });
});
