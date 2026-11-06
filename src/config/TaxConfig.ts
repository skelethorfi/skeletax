import {
  FREQUENCIES,
  type Frequency,
  type ITaxConfig,
  MAYA_LIQUIDITY_AUCTION,
  MAYA_LIQUIDITY_AUCTION_OLD_NAMES,
} from "./ITaxConfig.ts";
import path from "path";
import fs from "fs-extra";
import { load as loadToml } from "js-toml";
import { checkTimeZone, dateIn, isCalendarDate } from "../utils/DateRange.ts";
import { REFERENCE_PRICES } from "../export/summ/prices.ts";
import { PROTOCOLS } from "../domain/Protocol.ts";

// A config date as YYYY-MM-DD. An unquoted TOML date (fromDate = 2020-01-01) loads as a Date at UTC midnight;
// any other Date is a date-time, whose calendar day is not clear, so it is refused.
function configDate(value: unknown, key: string): string {
  const date =
    value instanceof Date && !isNaN(value.getTime()) && value.getTime() % (24 * 60 * 60 * 1000) === 0
      ? value.toISOString().slice(0, 10)
      : value;

  if (!isCalendarDate(date)) {
    throw new Error(`Config: ${key} must be a date such as "2025-07-01" (got ${JSON.stringify(value)})`);
  }
  return date;
}

export class TaxConfig {
  // today: the default toDate (its date in the config's timezone)
  static load(filename: string, today: Date): ITaxConfig {
    const config = this.renameDeprecated(this.loadConfigFile(filename));
    return this.resolvePaths(this.applyDefaults(config, today), path.dirname(path.resolve(filename)));
  }

  // Relative paths in the config are relative to the config file's folder, so a config
  // kept outside the repo also keeps its output and cache outside the repo.
  static resolvePaths(config: ITaxConfig, baseDir: string): ITaxConfig {
    return {
      ...config,
      outputPath: path.resolve(baseDir, config.outputPath),
      storePath: path.resolve(baseDir, config.storePath),
    };
  }

  // Old configs keep working: cachePath is now storePath
  static renameDeprecated(config: Partial<ITaxConfig>): Partial<ITaxConfig> {
    if (config.cachePath === undefined) {
      return config;
    }

    if (config.storePath !== undefined) {
      throw new Error("Config has both storePath and its old name cachePath: keep storePath");
    }

    console.warn("Config: cachePath is now called storePath (cachePath still works)");
    const { cachePath, ...rest } = config;
    return { ...rest, storePath: cachePath };
  }

  private static loadConfigFile(filename: string): ITaxConfig {
    console.log(`Wallets config file: ${filename}\n`);

    const fileExtension = path.extname(filename).toLowerCase();
    const fileContent = fs.readFileSync(filename).toString();

    let config;

    if (fileExtension === ".toml") {
      config = loadToml(fileContent) as unknown as ITaxConfig;
    } else if (fileExtension === ".json") {
      config = JSON.parse(fileContent);
    } else {
      throw new Error(`Unsupported config file format: ${fileExtension}`);
    }

    return config;
  }

  static applyDefaults(config: Partial<ITaxConfig>, today: Date): ITaxConfig {
    if (config.timezone !== undefined) {
      checkTimeZone(config.timezone);
    }
    const auction = config.mayaLiquidityAuction as string | undefined;
    if (auction !== undefined && auction in MAYA_LIQUIDITY_AUCTION_OLD_NAMES) {
      config = { ...config, mayaLiquidityAuction: MAYA_LIQUIDITY_AUCTION_OLD_NAMES[auction] };
    }
    if (config.mayaLiquidityAuction !== undefined && !MAYA_LIQUIDITY_AUCTION.includes(config.mayaLiquidityAuction)) {
      throw new Error(
        `Config: mayaLiquidityAuction must be ${MAYA_LIQUIDITY_AUCTION.map((value) => `"${value}"`).join(" or ")} (got ${JSON.stringify(config.mayaLiquidityAuction)})`,
      );
    }

    if (config.referencePrices !== undefined && !REFERENCE_PRICES.includes(config.referencePrices)) {
      throw new Error(
        `Config: referencePrices must be ${REFERENCE_PRICES.map((value) => `"${value}"`).join(" or ")} (got ${JSON.stringify(config.referencePrices)})`,
      );
    }

    if (
      config.incomeFrom !== undefined &&
      !(
        Array.isArray(config.incomeFrom) &&
        config.incomeFrom.every((address) => typeof address === "string" && address.length > 0)
      )
    ) {
      throw new Error(`Config: incomeFrom must be a list of addresses (got ${JSON.stringify(config.incomeFrom)})`);
    }

    this.checkWallets(config.wallets);
    this.checkProtocols(config.protocols);

    if (!FREQUENCIES.includes(config.frequency as Frequency)) {
      throw new Error(
        `Config: frequency must be ${FREQUENCIES.map((value) => `"${value}"`).join(", ")} (got ${JSON.stringify(config.frequency)})`,
      );
    }

    for (const key of ["pendingStuckDays", "pendingGraceDays"] as const) {
      const days = config[key];

      if (days !== undefined && !(typeof days === "number" && days >= 0)) {
        throw new Error(`Config: ${key} must be a number of days, 0 or more (got ${JSON.stringify(days)})`);
      }
    }

    // A wallet file's name holds the chain (<from>_<to>_<CHAIN>_...), which summ-sync reads back to tell managed rows
    // from categorised ones: written in upper case, letters and digits only (anything else is dropped)
    if (config.wallets !== undefined) {
      config = {
        ...config,
        wallets: config.wallets.map((wallet) => {
          const blockchain =
            typeof wallet.blockchain === "string" ? wallet.blockchain.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
          if (!blockchain) {
            throw new Error(
              `Config: wallet ${wallet.name}: blockchain must hold letters or digits, e.g. "THOR" (got ${JSON.stringify(wallet.blockchain)})`,
            );
          }
          return { ...wallet, blockchain };
        }),
      };
    }

    const fromDate = configDate(config.fromDate, "fromDate");
    const toDate = config.toDate === undefined ? dateIn(today, config.timezone) : configDate(config.toDate, "toDate");
    if (toDate < fromDate) {
      throw new Error(`Config: toDate (${toDate}) is before fromDate (${fromDate})`);
    }

    const defaults = {
      outputPath: "output",
      // The record store (docs/specs/snapshots.md); can be shared by several configs
      storePath: "store",
      pendingStuckDays: 30,
      pendingGraceDays: 3,
      // Reference prices on every row (docs/specs/prices.md)
      referencePrices: "all" as const,
    };

    return {
      ...defaults,
      ...config,
      fromDate,
      toDate,
    } as ITaxConfig;
  }

  // Each wallet has a name, an address no other wallet has, and a blockchain for its file names
  private static checkWallets(wallets: unknown): void {
    if (!Array.isArray(wallets)) {
      throw new Error(`Config: wallets must be a list of [[wallets]] entries (got ${JSON.stringify(wallets)})`);
    }

    const addresses = new Set<string>();
    wallets.forEach((wallet, i) => {
      const where = `wallets[${i}]`;
      if (wallet === null || typeof wallet !== "object") {
        throw new Error(`Config: ${where} must be a [[wallets]] entry (got ${JSON.stringify(wallet)})`);
      }
      for (const key of ["name", "address"]) {
        if (typeof wallet[key] !== "string" || wallet[key].trim() === "") {
          throw new Error(`Config: ${where}.${key} must be set (got ${JSON.stringify(wallet[key])})`);
        }
      }
      // EVM addresses are the same address in any case
      const address = wallet.address.toLowerCase();
      if (addresses.has(address)) {
        throw new Error(`Config: ${where}.address ${wallet.address} is already another wallet's address`);
      }
      addresses.add(address);
    });
  }

  private static checkProtocols(protocols: unknown): void {
    const ids = Object.keys(PROTOCOLS);

    if (
      protocols !== undefined &&
      !(
        Array.isArray(protocols) &&
        protocols.every((id) => ids.includes(id)) &&
        new Set(protocols).size === protocols.length
      )
    ) {
      throw new Error(
        `Config: protocols must be a list of ${ids.map((id) => `"${id}"`).join(", ")}, each once (got ${JSON.stringify(protocols)})`,
      );
    }
  }
}
