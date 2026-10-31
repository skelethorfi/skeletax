import fs from "fs-extra";
import path from "path";
import YAML from "yaml";
import type { Action } from "@xchainjs/xchain-midgard";
import type { TxStatusResponse } from "@xchainjs/xchain-thornode";
import type { SummRow } from "../export/summ/csv/index.ts";
import type { ViewblockInbound, ViewblockTx } from "../sources/viewblock/index.ts";
import type { EvmReceipt, EvmTokenPayout } from "../sources/evm/EvmReceipts.ts";
import { runBundle } from "../pipeline/run.ts";
import type { Treatment } from "../export/summ/index.ts";
import type { TcyDistributionItem } from "../sources/tcy/TcyDistributionService.ts";
import type { TcyClaimData } from "../sources/tcy/TcyClaimService.ts";
import type { MayaDistributionPayout } from "../sources/maya/MayaDistributionService.ts";
import { getProtocol, type ProtocolId } from "../domain/Protocol.ts";
import type { CosmosTx } from "../sources/thorchain/CosmosTxService.ts";
import type { BundleSource, RawBundle } from "../sources/RawBundle.ts";
import type { Activity } from "../domain/Activity.ts";
import { formatAmount } from "../domain/Amount.ts";

// A golden test case is a folder containing:
//   input.json    - the raw source data (a GoldenCaseInput: a RawBundle plus a description)
//   activity.yaml - the activities an interpreter makes from it, reviewed by hand (docs/specs/activity.md)
//   expected.yaml - the CSV rows the exporter should produce, reviewed by hand;
//                   one YAML document per row, separated by '---' ('[]' for no rows)
// Inputs must never contain anyone's own wallets or txids (see docs/specs/fixtures.md).

export type GoldenCaseSource = BundleSource;

export interface GoldenCaseInput {
  description: string;
  source: GoldenCaseSource;
  // Protocol of a midgard case. Default: thorchain
  protocol?: ProtocolId;
  // The wallet being exported. Required for viewblock, tcy and maya-distribution, which map relative to a wallet.
  wallet: string;
  data: Action | ViewblockTx | TcyDistributionItem | MayaDistributionPayout;
  // Related THORNode transactions (midgard swaps and switches)
  thornodeTxs?: TxStatusResponse[];
  // The Cosmos tx of a contract action
  cosmosTxs?: CosmosTx[];
  // Viewblock's gas and EVM receipts of the inbounds (docs/specs/fees.md)
  viewblockInbounds?: ViewblockInbound[];
  evmReceipts?: EvmReceipt[];
  // What an aggregator outbound delivered (docs/specs/activity.md, Aggregator payouts)
  tokenPayout?: EvmTokenPayout;
  // THORChain sends attached as the action's inbounds (a Maya liquidity auction's deposits)
  inbounds?: Action[];
  // The native fee at the action's height (Maya), base units
  nativeFee?: string;
  // RUNE's USD price at the action's time (a contract action that sends bRUNE)
  runePriceUsd?: string;
  // USD prices at the action's time, by THOR.RUNE, MAYA.CACAO or pool (docs/specs/prices.md)
  usdPrices?: Record<string, string>;
  // What a TCY claim was for (docs/specs/thorfi-collapse.md)
  tcyClaim?: TcyClaimData;
  // The config's treatment choices the case is mapped with, e.g. {mayaLiquidityAuction: 'income'}
  treatment?: Treatment;
}

export const INPUT_FILE = "input.json";
export const EXPECTED_FILE = "expected.yaml";
export const ACTIVITY_FILE = "activity.yaml";

export function findCaseDirs(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const dirs: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(root, entry.name);

    if (fs.existsSync(path.join(dir, INPUT_FILE))) {
      dirs.push(dir);
    } else {
      dirs.push(...findCaseDirs(dir));
    }
  }

  return dirs.sort();
}

export function readCaseInput(dir: string): GoldenCaseInput {
  return fs.readJSONSync(path.join(dir, INPUT_FILE));
}

export function readCaseExpected(dir: string): object[] | undefined {
  const file = path.join(dir, EXPECTED_FILE);
  return fs.existsSync(file) ? parseRows(fs.readFileSync(file, "utf8")) : undefined;
}

export function readCaseActivities(dir: string): object[] | undefined {
  const file = path.join(dir, ACTIVITY_FILE);
  return fs.existsSync(file) ? parseRows(fs.readFileSync(file, "utf8")) : undefined;
}

export function parseRows(text: string): any[] {
  const docs = YAML.parseAllDocuments(text).map((doc) => {
    if (doc.errors.length > 0) {
      throw doc.errors[0];
    }
    return doc.toJS();
  });

  // A single '[]' document means no rows
  return docs.length === 1 && Array.isArray(docs[0]) ? docs[0] : docs;
}

// One document per row. Strings that look like numbers (e.g. amounts) are quoted,
// so they parse back as strings.
export function formatRows(rows: object[]): string {
  if (rows.length === 0) {
    return "[]\n";
  }

  return rows.map((row) => YAML.stringify(row, { lineWidth: 0, aliasDuplicateObjects: false })).join("---\n");
}

export function writeCaseExpected(dir: string, rows: object[]) {
  fs.outputFileSync(path.join(dir, EXPECTED_FILE), formatRows(rows));
}

export function writeCaseActivities(dir: string, activities: Activity[]) {
  fs.outputFileSync(path.join(dir, ACTIVITY_FILE), formatRows(activities.map(toPlainActivity)));
}

// An activity as activity.yaml holds it: amounts as decimal strings with their decimals, times as ISO
// (fields that are undefined, e.g. a missing memo, are left out, as YAML can't hold them)
export function toPlainActivity(activity: Activity): object {
  return JSON.parse(
    JSON.stringify({
      ...activity,
      time: activity.time.toISOString(),
      legs: activity.legs.map(({ amount, ...leg }) => ({
        ...leg,
        amount: formatAmount(amount),
        decimals: amount.decimals,
      })),
    }),
  );
}

// A row as expected.yaml holds it: the timestamp as ISO, as the CSV writes it
// The row as expected.yaml holds it: its CSV columns (the trace is in the ID)
export function toPlainRow({ trace, ...row }: SummRow): object {
  return { ...row, timestamp: row.timestamp.toISOString() };
}

// A case's input is a RawBundle, written without the fields that are at their default
export function toBundle(input: GoldenCaseInput): RawBundle {
  return {
    source: input.source,
    protocol: input.protocol ?? "thorchain",
    wallet: input.wallet,
    data: input.data,
    thornodeTxs: input.thornodeTxs ?? [],
    cosmosTxs: input.cosmosTxs ?? [],
    ...(input.viewblockInbounds ? { viewblockInbounds: input.viewblockInbounds } : {}),
    ...(input.evmReceipts ? { evmReceipts: input.evmReceipts } : {}),
    ...(input.tokenPayout ? { tokenPayout: input.tokenPayout } : {}),
    ...(input.inbounds ? { inbounds: input.inbounds } : {}),
    ...(input.nativeFee ? { nativeFee: input.nativeFee } : {}),
    ...(input.runePriceUsd ? { runePriceUsd: input.runePriceUsd } : {}),
    ...(input.usdPrices ? { usdPrices: input.usdPrices } : {}),
    ...(input.tcyClaim ? { tcyClaim: input.tcyClaim } : {}),
  };
}

export function toCaseInput(bundle: RawBundle, description: string): GoldenCaseInput {
  return {
    description,
    source: bundle.source,
    ...(bundle.protocol === "thorchain" ? {} : { protocol: bundle.protocol }),
    wallet: bundle.wallet,
    data: bundle.data,
    ...(bundle.thornodeTxs.length ? { thornodeTxs: bundle.thornodeTxs } : {}),
    ...(bundle.cosmosTxs.length ? { cosmosTxs: bundle.cosmosTxs } : {}),
    ...(bundle.viewblockInbounds?.length ? { viewblockInbounds: bundle.viewblockInbounds } : {}),
    ...(bundle.evmReceipts?.length ? { evmReceipts: bundle.evmReceipts } : {}),
    ...(bundle.tokenPayout ? { tokenPayout: bundle.tokenPayout } : {}),
    ...(bundle.inbounds?.length ? { inbounds: bundle.inbounds } : {}),
    ...(bundle.nativeFee ? { nativeFee: bundle.nativeFee } : {}),
    ...(bundle.runePriceUsd ? { runePriceUsd: bundle.runePriceUsd } : {}),
    ...(bundle.usdPrices ? { usdPrices: bundle.usdPrices } : {}),
    ...(bundle.tcyClaim ? { tcyClaim: bundle.tcyClaim } : {}),
  };
}

// Runs a case through the same path the exporter uses (runBundle). An unsupported action gives no rows;
// a failure throws, so a case can't pass by failing.
export function runCase(input: GoldenCaseInput): object[] {
  return runCaseLayers(input).rows;
}

// The activities a case gives, and the rows as expected.yaml holds them
export function runCaseLayers(input: GoldenCaseInput): { activities: Activity[]; rows: object[] } {
  const { activities, rows, issues } = runBundle(toBundle(input), getProtocol(input.protocol), input.treatment);
  const failure = issues.find((issue) => issue.kind === "failed");

  if (failure) {
    throw new Error(failure.message);
  }

  return { activities, rows: rows.map(toPlainRow) };
}
