import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { http } from "../src/sources/http.ts";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { MidgardService } from "../src/sources/thorchain/MidgardService.ts";
import { priceKey, PriceSource } from "../src/sources/Prices.ts";
import { toAsset, toPositionAsset } from "../src/domain/Asset.ts";
import { readCaseExpected, readCaseInput, runCase, toBundle } from "../src/fixtures/GoldenCase.ts";
import { formatPrice } from "../src/export/summ/prices.ts";
import { TaxConfig } from "../src/config/TaxConfig.ts";
import { Exporter } from "../src/cli/Exporter.ts";

// Answers every history request with one bucket: the one asked for
const historyGet = (fields: (url: string) => object) => async (url: string) => {
  const [startTime, endTime] = [/from=(\d+)/.exec(url)![1], /to=(\d+)/.exec(url)![1]];
  return { data: { intervals: [{ startTime, endTime, ...fields(url) }] } } as any;
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-prices-"));

describe("reference prices (docs/specs/prices.md)", () => {
  test("an asset is priced as RUNE, CACAO or its pool; a position is not priced from Midgard", () => {
    assert.equal(priceKey(toAsset("BTC.BTC")), "BTC.BTC");
    assert.equal(priceKey(toAsset("BTC/BTC")), "BTC.BTC");
    assert.equal(priceKey(toAsset("BTC~BTC")), "BTC.BTC");
    assert.equal(priceKey(toAsset("BTC-BTC")), "BTC.BTC");
    assert.equal(
      priceKey(toAsset("ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48")),
      "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
    );
    assert.equal(priceKey(toAsset("THOR.RUNE")), "THOR.RUNE");
    assert.equal(priceKey(toAsset("THOR.TCY")), "THOR.TCY");
    assert.equal(priceKey(toAsset("MAYA.CACAO")), "MAYA.CACAO");
    assert.equal(priceKey(toAsset("x/ruji")), "THOR.RUJI");
    assert.equal(priceKey(toAsset("x/staking-x/ruji")), undefined);
    assert.equal(priceKey({ notation: "ibc/ABCDEF", kind: "native" }), undefined);
    assert.equal(priceKey(toPositionAsset("BTC.BTC")), undefined);
    assert.equal(priceKey(toPositionAsset("BTC/BTC")), undefined);
  });

  test("a pool's price is stored per bucket; an unknown pool is stored with no price and not asked again", async () => {
    const get = mock.method(http, "get", async (url: string) => {
      if (url.includes("/depths/FOO.BAR")) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          response: { status: 400, data: "Bad Request: Unknown pool: FOO.BAR" },
        });
      }

      return {
        data: { intervals: [{ startTime: "1668470400", endTime: "1668470700", assetPriceUSD: "16647.47" }] },
      } as any;
    });
    const dir = tempDir();
    const run = (offline = false) =>
      new MidgardService(new RecordStore(dir, { offline }), "midgard", "https://midgard");
    const time = new Date(1668470500000);

    assert.equal((await run().getPoolPrice("BTC.BTC", time)).assetPriceUSD, "16647.47");
    assert.deepEqual(await run().getPoolPrice("FOO.BAR", time), {
      pool: "FOO.BAR",
      startTime: "1668470400",
      endTime: "1668470700",
      assetPriceUSD: "",
      final: true,
    });
    await run().getPoolPrice("FOO.BAR", time);
    assert.deepEqual(
      get.mock.calls.map((call) => call.arguments[0]),
      [
        "https://midgard/v2/history/depths/BTC.BTC?interval=5min&from=1668470400&to=1668470700",
        "https://midgard/v2/history/depths/FOO.BAR?interval=5min&from=1668470400&to=1668470700",
      ],
    );

    // Offline, a stored price is read and a missing one is an error
    assert.equal((await run(true).getPoolPrice("BTC.BTC", time)).assetPriceUSD, "16647.47");
    await assert.rejects(run(true).getPoolPrice("ETH.ETH", time), /Offline/);
    get.mock.restore();
  });

  test("a bundle gets the prices of its legs, without the ones Midgard has none for", async () => {
    const get = mock.method(http, "get", async (url: string) => {
      const [startTime, endTime] = [/from=(\d+)/.exec(url)![1], /to=(\d+)/.exec(url)![1]];
      const interval = url.includes("/history/rune")
        ? { startTime, endTime, runePriceUSD: "2.02" }
        : { startTime, endTime, assetPriceUSD: "0" };
      return { data: { intervals: [interval] } } as any;
    });
    const { usdPrices: _, ...input } = readCaseInput("test/cases/prices/lp-add-symmetric");
    const midgard = new MidgardService(new RecordStore(tempDir()), "midgard", "https://midgard");
    const bundle = await new PriceSource(new Map([["thorchain", midgard]])).add(toBundle(input));

    // RUNE has a price; BTC.BTC's '0' (no pool at that time) is no price
    assert.deepEqual(bundle.usdPrices, { "THOR.RUNE": "2.02" });
    assert.equal(get.mock.calls.length, 2);
    get.mock.restore();
  });

  test("a position token has no price when one of its assets has none; the price helper never has one", () => {
    const input = readCaseInput("test/cases/prices/lp-add-symmetric");
    const rows = runCase({ ...input, usdPrices: { "BTC.BTC": input.usdPrices!["BTC.BTC"] } }) as any[];
    const priced = Object.fromEntries(
      rows.map((row) => [row.type + " " + row.baseCurrency, row.referencePricePerUnit]),
    );

    assert.deepEqual(priced, {
      "spam RUNE": undefined,
      "receive-lp-token ThorLP.BTC.BTC": undefined,
      "add-liquidity BTC": input.usdPrices!["BTC.BTC"],
      "add-liquidity RUNE": undefined,
    });
  });

  test("a position token of an action that is not 'success' has no price", () => {
    const input = readCaseInput("test/cases/prices/savers-withdraw");
    const rows = runCase({ ...input, data: { ...(input.data as any), status: "pending" } }) as any[];
    const token = rows.find((row) => row.type === "return-lp-token");
    const payout = rows.find((row) => row.type === "remove-liquidity");

    assert.equal(token.referencePricePerUnit, undefined);
    assert.equal(payout.referencePricePerUnit, input.usdPrices!["BTC.BTC"]);
  });

  test("the default ('swaps') fills nothing new, even when the bundle carries prices", () => {
    const cases = {
      "prices/lp-add-symmetric": "liquidity/add-btc-rune-symmetric",
      "prices/savers-withdraw": "liquidity/withdraw-btc-savers",
      // The bRUNE sell price is RUNE's only for bRUNE: a RUJI sell does not take the RUNE price the bundle carries
      "prices/rujira-liquid-bond-ruji": "rujira/staking-liquid-bond-ruji",
    };

    for (const [priced, plain] of Object.entries(cases)) {
      const { treatment: _, ...input } = readCaseInput(`test/cases/${priced}`);
      assert.deepEqual(runCase(input), readCaseExpected(`test/cases/${plain}`));
    }
  });

  test("an open bucket is fetched again on the next run; CACAO comes from Maya's own history", async () => {
    const now = Math.floor(Date.now() / 1000 / 300) * 300;
    const get = mock.method(
      http,
      "get",
      historyGet((url) => (url.includes("/cacao") ? { cacaoPriceUSD: "0.1" } : { assetPriceUSD: "5" })),
    );
    const dir = tempDir();
    const run = (source: string) => new MidgardService(new RecordStore(dir), source, "https://midgard");
    const open = new Date(now * 1000);

    assert.equal((await run("midgard").getPoolPrice("BTC.BTC", open)).final, false);
    await run("midgard").getPoolPrice("BTC.BTC", open);
    assert.equal((await run("maya-midgard").getCacaoPrice(new Date(1690000300000))).cacaoPriceUSD, "0.1");
    assert.deepEqual(
      get.mock.calls.map((call) => call.arguments[0]),
      [
        `https://midgard/v2/history/depths/BTC.BTC?interval=5min&from=${now}&to=${now + 300}`,
        `https://midgard/v2/history/depths/BTC.BTC?interval=5min&from=${now}&to=${now + 300}`,
        "https://midgard/v2/history/cacao?interval=5min&from=1690000200&to=1690000500",
      ],
    );
    get.mock.restore();
  });

  test("a run prices only bundles that can give rows: inside its periods, one listing per action", async () => {
    const dir = tempDir();
    const config = path.join(dir, "config.toml");
    fs.writeFileSync(
      config,
      'fromDate = "2024-07-01"\ntoDate = "2025-06-30"\nfrequency = "yearly"\nreferencePrices = "all"\nwallets = []\n',
    );
    const get = mock.method(
      http,
      "get",
      historyGet((url) => (url.includes("/history/rune") ? { runePriceUSD: "2" } : { assetPriceUSD: "100000" })),
    );
    const inside = toBundle(readCaseInput("test/cases/liquidity/add-btc-rune-symmetric"));
    const before = toBundle(readCaseInput("test/cases/liquidity/add-btc-savers"));
    const again = { ...inside, wallet: "bc1-another-listing" };
    const bundles = await new Exporter(config, { today: new Date("2026-10-30T00:00:00Z") }).withPrices([
      inside,
      before,
      again,
    ]);

    assert.deepEqual(bundles[0].usdPrices, { "BTC.BTC": "100000", "THOR.RUNE": "2" });
    assert.equal(bundles[1].usdPrices, undefined);
    assert.equal(bundles[2].usdPrices, undefined);
    assert.equal(get.mock.calls.length, 2);
    get.mock.restore();
  });

  test("a derived price is a plain decimal", () => {
    assert.equal(formatPrice(6.070787274132481), "6.07078727413248");
    assert.equal(formatPrice(16555.740027200513), "16555.7400272005");
    assert.equal(formatPrice(0.0000012345), "0.0000012345");
    assert.equal(formatPrice(12), "12");
  });

  test("the config takes 'swaps' or 'all'", () => {
    const today = new Date("2026-10-30T00:00:00Z");
    const config = { fromDate: "2025-07-01", frequency: "none" as const, wallets: [] };
    assert.equal(TaxConfig.applyDefaults({ ...config, referencePrices: "all" }, today).referencePrices, "all");
    assert.equal(TaxConfig.applyDefaults(config, today).referencePrices, undefined);
    assert.throws(
      () => TaxConfig.applyDefaults({ ...config, referencePrices: "every" as any }, today),
      /referencePrices must be "swaps" or "all"/,
    );
  });
});
