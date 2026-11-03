import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import type { Action } from "@xchainjs/xchain-midgard";
import {
  findCaseDirs,
  type GoldenCaseInput,
  readCaseExpected,
  readCaseInput,
  toBundle,
} from "../../src/fixtures/GoldenCase.ts";
import { type Fetched, type ListOptions, RecordStore, type RecordRules } from "../../src/sources/store/RecordStore.ts";
import { getAggregatorOutbound, getInboundTxs } from "../../src/sources/Source.ts";
import { getCosmosTxIds } from "../../src/sources/thorchain/CosmosTxService.ts";
import { bucketStart } from "../../src/sources/thorchain/MidgardService.ts";
import { getBundleKey } from "../../src/sources/RawBundle.ts";
import { Exporter } from "../../src/cli/Exporter.ts";
import { Viewblock } from "../../src/sources/viewblock/index.ts";
import { MidgardService } from "../../src/sources/thorchain/MidgardService.ts";
import { ThornodeService } from "../../src/sources/thorchain/ThornodeService.ts";
import { CosmosTxService } from "../../src/sources/thorchain/CosmosTxService.ts";
import { EvmReceipts } from "../../src/sources/evm/EvmReceipts.ts";
import { TcyDistributionService } from "../../src/sources/tcy/TcyDistributionService.ts";
import { TcyClaimService } from "../../src/sources/tcy/TcyClaimService.ts";
import { getActionDate } from "../../src/sources/thorchain/MidgardUtils.ts";
import { runBundle } from "../../src/pipeline/run.ts";
import { getProtocol } from "../../src/domain/Protocol.ts";
import type { ViewblockTx } from "../../src/sources/viewblock/index.ts";

// A record store made from the golden cases (test/cases), for running the whole exporter offline
// (docs/specs/fixtures.md, End-to-end export). Each case's input is a bundle; its records are put in the store
// under the keys the services read them by, and what a case does not hold (a THORNode status, a price) gets a
// stand-in that adds nothing to its rows.

export interface Case {
  name: string;
  input: GoldenCaseInput;
  expected: object[];
}

// The reviewed THORChain cases that can share one store. A Viewblock send with an anonymised placeholder hash gets
// a hash of its own first (withOwnHash). A case is left out when it would clash with one kept: the same record of
// the same wallet (e.g. an anonymised placeholder txid), another record under the same key with other data, or a
// Viewblock send whose hash a Midgard case has, which the exporter drops as that action's inbound (docs/specs/sends.md).
// Cases with prices go first. Maya cases are left out (THORChain's sources only).
export function thorchainCases(root: string): { cases: Case[]; skipped: string[] } {
  const all = findCaseDirs(root)
    .map((dir) => ({ name: path.relative(root, dir), input: readCaseInput(dir), expected: readCaseExpected(dir) }))
    .filter((c): c is Case => c.expected !== undefined && (c.input.protocol ?? "thorchain") === "thorchain")
    .filter((c) => c.input.source !== "maya-distribution")
    .map(withOwnHash);
  const midgardTxIds = new Set(
    all
      .filter((c) => c.input.source === "midgard")
      .flatMap((c) => (c.input.data as Action).in.map((tx) => tx.txID?.toUpperCase())),
  );
  const bundles = new Set<string>();
  const records = new Map<string, string>();
  const cases: Case[] = [];
  const skipped: string[] = [];

  for (const c of [...all.filter((c) => c.input.usdPrices), ...all.filter((c) => !c.input.usdPrices)]) {
    const bundle = `${c.input.wallet}|${getBundleKey(toBundle(c.input))}`;
    const own = [...recordsOf(c.input)].map(([key, data]) => [key, JSON.stringify(data)]);

    if (
      bundles.has(bundle) ||
      own.some(([key, data]) => records.has(key) && records.get(key) !== data) ||
      (c.input.source === "viewblock" && midgardTxIds.has((c.input.data as ViewblockTx).hash.toUpperCase()))
    ) {
      skipped.push(c.name);
      continue;
    }

    bundles.add(bundle);
    own.forEach(([key, data]) => records.set(key, data));
    cases.push(c);
  }

  return { cases: all.filter((c) => cases.includes(c)), skipped };
}

// An anonymised Viewblock send's placeholder hash (all zeros) is the same in every such case, and the same as the
// placeholder txids of anonymised Midgard cases, so in one store the sends would be one record, dropped as a
// Midgard action's inbound. The case gets a hash of its own, from its name; its expected rows name that hash, and
// their IDs are those the rows get from it (the row the case gives with the placeholder, matched by its ID).
function withOwnHash(c: Case): Case {
  const tx = c.input.data as ViewblockTx;

  if (c.input.source !== "viewblock" || !/^0+$/.test(tx.hash)) {
    return c;
  }

  const hash = crypto.createHash("sha256").update(c.name).digest("hex").toUpperCase();
  const input = { ...c.input, data: { ...tx, hash } };
  const rowsOf = (caseInput: GoldenCaseInput) =>
    runBundle(toBundle(caseInput), getProtocol(caseInput.protocol), caseInput.treatment).rows;
  const before = rowsOf(c.input);
  const after = rowsOf(input);
  const newId = (id: string) => {
    const i = before.findIndex((row) => row.id === id);

    if (i < 0 || before.length !== after.length) {
      throw new Error(`${c.name}: no row ${id} to give a hash of its own`);
    }

    return after[i].id;
  };

  return {
    ...c,
    input,
    expected: c.expected.map((row: any) => ({
      ...row,
      id: newId(row.id),
      description: row.description.replaceAll(tx.hash, hash),
    })),
  };
}

// The records a midgard case's bundle was made from, by '<source>|<key>' as the services key them
function recordsOf(input: GoldenCaseInput): Map<string, any> {
  const records = new Map<string, any>();
  const add = (source: string, key: string, data: any) => data !== undefined && records.set(`${source}|${key}`, data);

  if (input.source !== "midgard") {
    return records;
  }

  const action = input.data as Action;
  // Inbound statuses are fetched in getInboundTxs' order, Cosmos txs in getCosmosTxIds'
  getInboundTxs(action).forEach(({ txId }, i) => add("thornode", txId, input.thornodeTxs?.[i]));
  getCosmosTxIds(action).forEach((txId, i) => add("thornode-cosmos", txId, input.cosmosTxs?.[i]));
  input.viewblockInbounds?.forEach((tx) => add("viewblock-tx", tx.hash, tx));
  input.evmReceipts?.forEach((receipt) => add("evm-receipt", evmKey(receipt.chain, receipt.transactionHash), receipt));
  const aggregator = getAggregatorOutbound(action);

  if (aggregator && input.tokenPayout) {
    add("evm-payout", evmKey(aggregator.chain, aggregator.txId), input.tokenPayout);
  }

  if (input.tcyClaim) {
    add("tcy-claim", `${action.in[0].address}.${action.height}`, input.tcyClaim);
  }

  const start = bucketStart(getActionDate(action));
  const bucket = { startTime: String(start), endTime: String(start + 300), final: true };
  const prices = { ...(input.runePriceUsd ? { "THOR.RUNE": input.runePriceUsd } : {}), ...input.usdPrices };

  for (const [key, usd] of Object.entries(prices)) {
    if (key === "THOR.RUNE") {
      add("midgard-rune-price", String(start), { ...bucket, runePriceUSD: usd });
    } else {
      add("midgard-pool-price", `${key}.${start}`, { pool: key, ...bucket, assetPriceUSD: usd });
      // Swapped on both sides of the bucket, so the price is not frozen
      add("midgard-pool-swaps", `${key}.${start}`, {
        pool: key,
        startTime: String(start),
        before: "1",
        after: "1",
        final: true,
      });
    }
  }

  return records;
}

// The cases' wallet lists and records
class CaseRecords {
  private records = new Map<string, any>();
  private lists = new Map<string, any[]>();

  constructor(cases: Case[]) {
    for (const { input } of cases) {
      const listKey = `${input.source}|${input.wallet}`;
      this.lists.set(listKey, [...(this.lists.get(listKey) ?? []), input.data]);
      recordsOf(input).forEach((data, key) => this.records.set(key, data));
    }
  }

  list(source: string, wallet: string): any[] {
    const items = this.lists.get(`${source}|${wallet}`) ?? [];
    // Newest first, as Midgard lists them
    return source === "midgard"
      ? [...items].sort((a, b) => Number(BigInt(b.date) - BigInt(a.date)))
      : source === "tcy"
        ? [...items].sort((a, b) => Number(b.date) - Number(a.date))
        : items;
  }

  // The case's record, or a stand-in that adds nothing to the rows: a THORNode status with nothing observed, a
  // Viewblock lookup that found nothing, a Cosmos tx with no events, no price, no claim-list entry
  record(source: string, key: string): any {
    const found = this.records.get(`${source}|${key}`);

    if (found !== undefined) {
      return found;
    }

    const [pool, start] = key.includes(".") ? [key.slice(0, key.lastIndexOf(".")), key.split(".").pop()!] : [key, key];
    const bucket = { startTime: start, endTime: String(Number(start) + 300), final: true };

    switch (source) {
      case "thornode":
        return { stages: {} };
      case "viewblock-tx":
        return { hash: key, found: false, gas: [] };
      case "evm-receipt":
      case "evm-payout":
        return null;
      case "thornode-cosmos":
        return { txhash: key, height: "0", code: 0, fee: [], events: [] };
      case "midgard-rune-price":
        return { ...bucket, runePriceUSD: "0" };
      case "midgard-pool-price":
        return { pool, ...bucket, assetPriceUSD: "" };
      case "tcy-claim":
        return { claims: [], savers: [], loans: [] };
      default:
        throw new Error(`No stand-in for ${source} ${key}`);
    }
  }
}

function evmKey(chain: string, hash: string): string {
  return `${chain}.0x${hash.replace(/^0x/i, "").toLowerCase()}`;
}

// A store whose fetches answer from the cases instead of the network
class CaseStore extends RecordStore {
  private readonly records: CaseRecords;

  constructor(root: string, records: CaseRecords) {
    super(root);
    this.records = records;
  }

  override record<T>(
    source: string,
    key: string,
    _fetch: () => Promise<Fetched<T>>,
    rules?: RecordRules<T>,
    date?: Date,
  ): Promise<T> {
    return super.record(source, key, async () => ({ data: this.records.record(source, key) }), rules, date);
  }

  override list<T>(
    source: string,
    wallet: string,
    _fetch: () => Promise<Fetched<T[]>>,
    options: ListOptions<T>,
  ): Promise<T[]> {
    return super.list(source, wallet, async () => ({ data: this.records.list(source, wallet) }), options);
  }
}

// A config wallet for each wallet the cases export and each wallet their rows name (a swap's destination, a
// switch's sender), so every row lands in a wallet's file
export function caseWallets(cases: Case[]): { name: string; address: string; blockchain: string }[] {
  const addresses = new Map<string, string>();
  cases
    .flatMap((c) => [c.input.wallet, ...c.expected.map((row: any) => row.wallet as string)])
    .filter((address) => address && address !== "thorchain" && !addresses.has(address.toLowerCase()))
    .forEach((address) => addresses.set(address.toLowerCase(), address));
  return [...addresses.values()].map((address, i) => ({
    name: `case${i + 1}`,
    address,
    blockchain: chainOf(address),
  }));
}

function chainOf(address: string): string {
  const prefixes: [RegExp, string][] = [
    [/^thor/, "THOR"],
    [/^0x/i, "ETH"],
    [/^(bc1|[13])/, "BTC"],
    [/^ltc1/, "LTC"],
    [/^cosmos1/, "GAIA"],
    [/^bnb/, "BNB"],
    [/^D/, "DOGE"],
    [/^T/, "TRON"],
  ];
  return prefixes.find(([prefix]) => prefix.test(address))?.[1] ?? "OTHER";
}

// Fills the config's store from the cases: runs the exporter's sources through a store that answers each fetch
// from the cases, so every record a run reads is stored under the key its service gives it
export async function fillStore(configFile: string, cases: Case[], today: Date): Promise<void> {
  const exporter = new Exporter(configFile, { today });
  const store = new CaseStore(exporter.config.storePath, new CaseRecords(cases));
  exporter.viewblock = new Viewblock(store);
  exporter.midgard = new MidgardService(store);
  exporter.thornode = new ThornodeService(store);
  exporter.cosmosTxs = new CosmosTxService(store);
  exporter.evmReceipts = new EvmReceipts(store);
  exporter.tcyDistribution = new TcyDistributionService(store);
  exporter.tcyClaims = new TcyClaimService(store);

  if (exporter.otherMidgards.length > 0) {
    throw new Error("fillStore: THORChain only");
  }

  await exporter.withPrices(await exporter.collectBundles());
}

// The run folders under an output folder, oldest first
export function runFolders(outputPath: string): string[] {
  return fs.existsSync(outputPath)
    ? fs
        .readdirSync(outputPath)
        .sort()
        .map((name) => path.join(outputPath, name))
    : [];
}
