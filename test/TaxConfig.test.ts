import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { TaxConfig } from "../src/config/TaxConfig.ts";
import fs from "fs-extra";
import os from "os";
import path from "path";

describe("TaxConfig", () => {
  test("applyDefaults with empty config", () => {
    const result = TaxConfig.applyDefaults({}, new Date("2026-06-30T23:30:00.000Z"));

    assert.deepEqual(result, {
      outputPath: "output",
      storePath: "store",
      pendingStuckDays: 30,
      pendingGraceDays: 3,
      toDate: "2026-06-30",
      referencePrices: "all",
    });
  });

  test("with a timezone, the default toDate is today's date there", () => {
    const result = TaxConfig.applyDefaults({ timezone: "Asia/Tokyo" }, new Date("2026-06-30T23:30:00.000Z"));

    assert.equal(result.toDate, "2026-07-01");
  });

  test("an unknown timezone is an error", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ timezone: "Nowhere/City" }, new Date()),
      /Unknown timezone: Nowhere\/City/,
    );
  });

  test("pendingStuckDays and pendingGraceDays must be a number of days, 0 or more", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ pendingStuckDays: -1 }, new Date()),
      /pendingStuckDays must be a number of days/,
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ pendingStuckDays: "30" as any }, new Date()),
      /pendingStuckDays must be a number of days/,
    );
    assert.equal(TaxConfig.applyDefaults({ pendingStuckDays: 0 }, new Date()).pendingStuckDays, 0);
    assert.throws(
      () => TaxConfig.applyDefaults({ pendingGraceDays: -2 }, new Date()),
      /pendingGraceDays must be a number of days/,
    );
  });

  test("incomeFrom is a list of addresses", () => {
    assert.deepEqual(TaxConfig.applyDefaults({ incomeFrom: ["maya1a"] }, new Date()).incomeFrom, ["maya1a"]);
    assert.throws(
      () => TaxConfig.applyDefaults({ incomeFrom: "maya1a" as any }, new Date()),
      /incomeFrom must be a list of addresses/,
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ incomeFrom: [""] as any }, new Date()),
      /incomeFrom must be a list of addresses/,
    );
  });

  test("mayaLiquidityAuction is income or pool-units, with no default; deposit is read as pool-units", () => {
    assert.equal(TaxConfig.applyDefaults({}, new Date()).mayaLiquidityAuction, undefined);
    assert.equal(
      TaxConfig.applyDefaults({ mayaLiquidityAuction: "pool-units" }, new Date()).mayaLiquidityAuction,
      "pool-units",
    );
    assert.equal(
      TaxConfig.applyDefaults({ mayaLiquidityAuction: "deposit" as any }, new Date()).mayaLiquidityAuction,
      "pool-units",
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ mayaLiquidityAuction: "gift" as any }, new Date()),
      /mayaLiquidityAuction must be "income" or "pool-units"/,
    );
  });

  test("applyDefaults with populated config", () => {
    const config = {
      fromDate: "2020-01-01",
      toDate: "2020-12-31",
      frequency: "monthly" as const,
      cacheDataSources: true,
      outputPath: "custom-output",
      unsupportedActionsPath: "custom-unsupported-actions",
      storePath: "custom-store",
      pendingStuckDays: 90,
      pendingGraceDays: 5,
      wallets: [],
    };

    const result = TaxConfig.applyDefaults(config, new Date());

    assert.deepEqual(result, {
      fromDate: "2020-01-01",
      toDate: "2020-12-31",
      frequency: "monthly",
      cacheDataSources: true,
      outputPath: "custom-output",
      unsupportedActionsPath: "custom-unsupported-actions",
      storePath: "custom-store",
      pendingStuckDays: 90,
      pendingGraceDays: 5,
      wallets: [],
      referencePrices: "all",
    });
  });
});

describe("TaxConfig paths", () => {
  test("resolves relative paths against the config file folder", () => {
    const config = TaxConfig.resolvePaths(
      TaxConfig.applyDefaults({ storePath: "FY/store" }, new Date()),
      "/private/tax",
    );

    assert.equal(config.outputPath, path.resolve("/private/tax/output"));
    assert.equal(config.storePath, path.resolve("/private/tax/FY/store"));
  });

  test("keeps absolute paths", () => {
    const config = TaxConfig.resolvePaths(
      TaxConfig.applyDefaults({ outputPath: "/elsewhere/output" }, new Date()),
      "/private/tax",
    );

    assert.equal(config.outputPath, path.resolve("/elsewhere/output"));
  });

  test("load resolves paths relative to the config file, not the working directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-config-"));
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, 'fromDate = "2024-07-01"\ncachePath = "FY/cache"\n');

    const config = TaxConfig.load(file, new Date());

    assert.equal(config.storePath, path.join(dir, "FY/cache"));
    assert.equal(config.outputPath, path.join(dir, "output"));
  });

  test("an old config with cachePath still works, as storePath", () => {
    mock.method(console, "warn", () => {});

    assert.deepEqual(TaxConfig.renameDeprecated({ cachePath: "FY/cache" }), { storePath: "FY/cache" });
    assert.throws(() => TaxConfig.renameDeprecated({ cachePath: "a", storePath: "b" }), /both storePath and/);
  });

  test("loads the optional [assets] table from TOML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tct-config-"));
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(
      file,
      [
        'fromDate = "2025-07-01"',
        'toDate = "2026-06-30"',
        'frequency = "yearly"',
        "cacheDataSources = true",
        "wallets = []",
        "",
        "[assets]",
        "prefixSecuredAssets = true",
      ].join("\n"),
    );

    // js-toml builds tables without Object's prototype; compare the values
    assert.deepEqual({ ...TaxConfig.load(file, new Date()).assets }, { prefixSecuredAssets: true });
  });
});
