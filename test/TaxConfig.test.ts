import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { TaxConfig } from "../src/config/TaxConfig.ts";
import fs from "fs-extra";
import os from "os";
import path from "path";

// The keys a config must have
const base = { fromDate: "2025-07-01", frequency: "yearly" as const, wallets: [] };

describe("TaxConfig", () => {
  test("applyDefaults with a minimal config", () => {
    const result = TaxConfig.applyDefaults(base, new Date("2026-06-30T23:30:00.000Z"));

    assert.deepEqual(result, {
      ...base,
      outputPath: "output",
      storePath: "store",
      pendingStuckDays: 30,
      pendingGraceDays: 3,
      toDate: "2026-06-30",
      referencePrices: "all",
    });
  });

  test("with a timezone, the default toDate is today's date there", () => {
    const result = TaxConfig.applyDefaults({ ...base, timezone: "Asia/Tokyo" }, new Date("2026-06-30T23:30:00.000Z"));

    assert.equal(result.toDate, "2026-07-01");
  });

  test("a wallet's blockchain is written in upper case, letters and digits only; one with neither is an error", () => {
    let n = 0;
    const wallet = (blockchain: unknown) => ({ name: "Example", address: `thor1example${n++}`, blockchain }) as any;
    const result = TaxConfig.applyDefaults(
      { ...base, wallets: [wallet("thor"), wallet("Eth2"), wallet("BNB-Chain"), wallet("Terra Classic")] },
      new Date(),
    );
    assert.deepEqual(
      result.wallets.map((w) => w.blockchain),
      ["THOR", "ETH2", "BNBCHAIN", "TERRACLASSIC"],
    );
    for (const bad of ["", "-_", undefined]) {
      assert.throws(
        () => TaxConfig.applyDefaults({ ...base, wallets: [wallet(bad)] }, new Date()),
        /wallet Example: blockchain must hold letters or digits/,
      );
    }
  });

  test("an unknown timezone is an error", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, timezone: "Nowhere/City" }, new Date()),
      /Unknown timezone: Nowhere\/City/,
    );
  });

  test("pendingStuckDays and pendingGraceDays must be a number of days, 0 or more", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, pendingStuckDays: -1 }, new Date()),
      /pendingStuckDays must be a number of days/,
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, pendingStuckDays: "30" as any }, new Date()),
      /pendingStuckDays must be a number of days/,
    );
    assert.equal(TaxConfig.applyDefaults({ ...base, pendingStuckDays: 0 }, new Date()).pendingStuckDays, 0);
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, pendingGraceDays: -2 }, new Date()),
      /pendingGraceDays must be a number of days/,
    );
  });

  test("incomeFrom is a list of addresses", () => {
    assert.deepEqual(TaxConfig.applyDefaults({ ...base, incomeFrom: ["maya1a"] }, new Date()).incomeFrom, ["maya1a"]);
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, incomeFrom: "maya1a" as any }, new Date()),
      /incomeFrom must be a list of addresses/,
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, incomeFrom: [""] as any }, new Date()),
      /incomeFrom must be a list of addresses/,
    );
  });

  test("mayaLiquidityAuction is income or pool-units, with no default; deposit is read as pool-units", () => {
    assert.equal(TaxConfig.applyDefaults(base, new Date()).mayaLiquidityAuction, undefined);
    assert.equal(
      TaxConfig.applyDefaults({ ...base, mayaLiquidityAuction: "pool-units" }, new Date()).mayaLiquidityAuction,
      "pool-units",
    );
    assert.equal(
      TaxConfig.applyDefaults({ ...base, mayaLiquidityAuction: "deposit" as any }, new Date()).mayaLiquidityAuction,
      "pool-units",
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, mayaLiquidityAuction: "gift" as any }, new Date()),
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

describe("TaxConfig checks, before anything is fetched", () => {
  const today = new Date("2026-06-30T12:00:00.000Z");
  const wallet = { name: "Main", address: "thor1abc", blockchain: "THOR" };

  test("fromDate is required and must be a calendar date", () => {
    const { fromDate, ...noFrom } = base;
    assert.throws(() => TaxConfig.applyDefaults(noFrom, today), /fromDate must be a date such as "2025-07-01"/);
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, fromDate: "2023-02-30" }, today),
      /fromDate must be a date .*"2023-02-30"/,
    );
    assert.throws(() => TaxConfig.applyDefaults({ ...base, fromDate: "2023-2-1" }, today), /fromDate must be a date/);
    assert.throws(() => TaxConfig.applyDefaults({ ...base, toDate: "2026-13-01" }, today), /toDate must be a date/);
  });

  test("an unquoted TOML date is read as YYYY-MM-DD; a date-time is refused", () => {
    const config = TaxConfig.applyDefaults(
      { ...base, fromDate: new Date("2020-01-01T00:00:00.000Z") as any, toDate: new Date("2020-12-31") as any },
      today,
    );

    assert.equal(config.fromDate, "2020-01-01");
    assert.equal(config.toDate, "2020-12-31");
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, fromDate: new Date("2020-01-01T10:00:00.000Z") as any }, today),
      /fromDate must be a date/,
    );
  });

  test("toDate is not before fromDate", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, fromDate: "2025-07-01", toDate: "2025-06-30" }, today),
      /toDate \(2025-06-30\) is before fromDate \(2025-07-01\)/,
    );
    assert.equal(TaxConfig.applyDefaults({ ...base, toDate: "2025-07-01" }, today).toDate, "2025-07-01");
  });

  test("frequency is monthly, yearly or none", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, frequency: "annually" as any }, today),
      /frequency must be "monthly", "yearly", "none" \(got "annually"\)/,
    );
    const { frequency, ...noFrequency } = base;
    assert.throws(() => TaxConfig.applyDefaults(noFrequency, today), /frequency must be/);
  });

  test("wallets is a list of wallets, each with a name, its own address and a blockchain", () => {
    const { wallets, ...noWallets } = base;
    assert.throws(() => TaxConfig.applyDefaults(noWallets, today), /wallets must be a list/);
    assert.deepEqual(TaxConfig.applyDefaults({ ...base, wallets: [wallet] }, today).wallets, [wallet]);

    const invalid: [object, RegExp][] = [
      [{ ...wallet, address: "" }, /wallets\[0\]\.address must be set/],
      [{ ...wallet, name: undefined }, /wallets\[0\]\.name must be set/],
      [{ ...wallet, blockchain: undefined }, /blockchain must hold letters or digits/],
    ];
    for (const [entry, error] of invalid) {
      assert.throws(() => TaxConfig.applyDefaults({ ...base, wallets: [entry as any] }, today), error);
    }

    assert.throws(
      () =>
        TaxConfig.applyDefaults(
          { ...base, wallets: [wallet, { name: "Other", address: "THOR1ABC", blockchain: "THOR" }] },
          today,
        ),
      /wallets\[1\]\.address THOR1ABC is already another wallet's address/,
    );
  });

  test("protocols lists known protocols, each once", () => {
    assert.deepEqual(TaxConfig.applyDefaults({ ...base, protocols: ["thorchain", "maya"] }, today).protocols, [
      "thorchain",
      "maya",
    ]);
    assert.throws(
      () => TaxConfig.applyDefaults({ ...base, protocols: ["mayachain"] as any }, today),
      /protocols must be a list of "thorchain", "maya", each once/,
    );
    assert.throws(() => TaxConfig.applyDefaults({ ...base, protocols: ["maya", "maya"] }, today), /each once/);
    assert.throws(() => TaxConfig.applyDefaults({ ...base, protocols: "maya" as any }, today), /protocols must be/);
  });

  test("load reads an unquoted TOML fromDate as a date string", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tct-config-"));
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, 'fromDate = 2020-01-01\ntoDate = 2020-12-31\nfrequency = "yearly"\nwallets = []\n');

    const config = TaxConfig.load(file, today);

    assert.equal(config.fromDate, "2020-01-01");
    assert.equal(config.toDate, "2020-12-31");
  });
});

describe("TaxConfig paths", () => {
  test("resolves relative paths against the config file folder", () => {
    const config = TaxConfig.resolvePaths(
      TaxConfig.applyDefaults({ ...base, storePath: "FY/store" }, new Date()),
      "/private/tax",
    );

    assert.equal(config.outputPath, path.resolve("/private/tax/output"));
    assert.equal(config.storePath, path.resolve("/private/tax/FY/store"));
  });

  test("keeps absolute paths", () => {
    const config = TaxConfig.resolvePaths(
      TaxConfig.applyDefaults({ ...base, outputPath: "/elsewhere/output" }, new Date()),
      "/private/tax",
    );

    assert.equal(config.outputPath, path.resolve("/elsewhere/output"));
  });

  test("load resolves paths relative to the config file, not the working directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-config-"));
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, 'fromDate = "2024-07-01"\nfrequency = "yearly"\nwallets = []\ncachePath = "FY/cache"\n');

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
