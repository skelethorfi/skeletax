import { Viewblock } from "../sources/viewblock/index.ts";
import fs from "fs-extra";
import { format } from "date-fns-tz";
import { type SummRow, renderRowIds, ROW_IDS_FILE, writeCsv } from "../export/summ/csv/index.ts";
import { MidgardService } from "../sources/thorchain/MidgardService.ts";
import { ThornodeService } from "../sources/thorchain/ThornodeService.ts";
import { CosmosTxService } from "../sources/thorchain/CosmosTxService.ts";
import { EvmReceipts } from "../sources/evm/EvmReceipts.ts";
import { MayanodeService } from "../sources/maya/MayanodeService.ts";
import { TcyDistributionService } from "../sources/tcy/TcyDistributionService.ts";
import { TcyClaimService } from "../sources/tcy/TcyClaimService.ts";
import type { ITaxConfig } from "../config/ITaxConfig.ts";
import { generateDateRanges } from "../utils/DateRange.ts";
import path from "path";
import { TaxConfig } from "../config/TaxConfig.ts";
import { type FetchMode, RecordStore, StoreMissError } from "../sources/store/RecordStore.ts";
import { SnapshotManifest } from "../sources/store/SnapshotManifest.ts";
import { getProtocol, MAYA, type Protocol, THORCHAIN, withAssetNames } from "../domain/Protocol.ts";
import { MayaDistributionSource, MidgardSource, type Source, TcySource, ViewblockSource } from "../sources/Source.ts";
import { MayaDistributionService } from "../sources/maya/MayaDistributionService.ts";
import { ageInDays, inboundSends, type NotFinal, type PendingAge, pendingAge } from "../sources/Pending.ts";
import { getActionDate } from "../sources/thorchain/MidgardUtils.ts";
import { ACTION_MEMO_WARNING, actionMemoSummary } from "../interpret/midgard/send.ts";
import { knownDistributorReport } from "../export/summ/send.ts";
import { RunSummary } from "./RunSummary.ts";
import {
  attachAuctionDeposits,
  dedupeBundles,
  getBundleDate,
  getBundleKey,
  getBundleSourceName,
  type RawBundle,
  selectSends,
  VIEWBLOCK_SENDS_BEFORE,
} from "../sources/RawBundle.ts";
import { type BundleResult, collectRows, runBundle } from "../pipeline/run.ts";
import { csvFiles } from "../export/summ/files.ts";
import type { Action } from "@xchainjs/xchain-midgard";
import { midgardActionKey } from "../sources/store/Sources.ts";
import { PriceSource } from "../sources/Prices.ts";

export interface ExportOptions {
  // Only read cached snapshots; fail on anything not cached
  offline?: boolean;
  // 'latest' (default: wallet lists and pending records) or 'all' (every record again)
  fetch?: FetchMode;
  // A run folder (or its snapshots.json) whose exact records to read
  replay?: string;
  // The run's date: the default toDate. Default: now
  today?: Date;
}

export class Exporter {
  config: ITaxConfig;
  // The snapshots this run used
  snapshots: SnapshotManifest;
  viewblock: Viewblock;
  midgard: MidgardService;
  // Midgard of each other protocol enabled in the config (e.g. Maya)
  thorchain: Protocol;
  otherMidgards: {
    protocol: Protocol;
    midgard: MidgardService;
    node?: MayanodeService;
    distribution?: MayaDistributionService;
  }[];
  thornode: ThornodeService;
  cosmosTxs: CosmosTxService;
  evmReceipts: EvmReceipts;
  tcyDistribution: TcyDistributionService;
  tcyClaims: TcyClaimService;
  // What the run printed that is worth keeping, written to its folder as summary.md
  report = new RunSummary();
  // Warnings for the end of the run, set by getRows
  endWarnings: string[] = [];
  // Midgard actions whose status is not 'success', filled by the Midgard sources
  notFinal: NotFinal[] = [];
  private readonly today: Date;

  constructor(filename: string, options: ExportOptions = {}) {
    this.today = options.today ?? new Date();
    this.config = TaxConfig.load(filename, this.today);
    const storePath = this.config.storePath;
    this.snapshots = new SnapshotManifest();
    // One store for every source (docs/specs/snapshots.md)
    if (this.config.unsupportedActionsPath !== undefined) {
      this.report.warn(
        "Config: unsupportedActionsPath is no longer used: unsupported actions are saved in each run's folder (<run>/unsupported/)",
      );
    }
    if (this.config.cacheDataSources !== undefined) {
      this.report.warn(
        "Config: cacheDataSources is no longer used: every run fetches the latest data and keeps what was stored; use --offline to fetch nothing",
      );
    }
    for (const wallet of this.config.wallets.filter((w) => w.addReferencePrices)) {
      this.report.warn(`Config: addReferencePrices is no longer supported and is ignored (wallet ${wallet.name})`);
    }

    const store = new RecordStore(storePath, {
      offline: options.offline,
      fetch: options.fetch,
      replay: options.replay ? SnapshotManifest.load(options.replay) : undefined,
      manifest: this.snapshots,
      pendingStuckDays: this.config.pendingStuckDays,
      today: options.today,
    });
    this.viewblock = new Viewblock(store);
    this.midgard = new MidgardService(store);
    this.thornode = new ThornodeService(store);
    this.cosmosTxs = new CosmosTxService(store);
    this.evmReceipts = new EvmReceipts(store);
    this.tcyDistribution = new TcyDistributionService(store);
    this.tcyClaims = new TcyClaimService(store);
    this.thorchain = withAssetNames(THORCHAIN, this.config.assets);
    this.otherMidgards = (this.config.protocols ?? ["thorchain"])
      .map((id) => withAssetNames(getProtocol(id), this.config.assets))
      .filter((protocol) => protocol.id !== THORCHAIN.id)
      .map((protocol) => ({
        protocol,
        midgard: new MidgardService(store, `${protocol.id}-midgard`, protocol.midgardUrl),
        node: protocol.nodeUrl ? new MayanodeService(store, protocol.nodeUrl) : undefined,
        distribution:
          protocol.id === MAYA.id && protocol.nodeUrl
            ? new MayaDistributionService(store, protocol.midgardUrl, protocol.nodeUrl)
            : undefined,
      }));
  }

  // Each source's bundles for the wallet, in this order: Viewblock (only when the run exports a period
  // before Midgard's send history is complete, docs/specs/sends.md), THORChain Midgard, other protocols'
  // Midgards (e.g. Maya), TCY distributions, CACAO payouts to MAYA holders
  sources(): Source[] {
    return [
      ...(this.config.fromDate < VIEWBLOCK_SENDS_BEFORE ? [new ViewblockSource(this.viewblock)] : []),
      new MidgardSource(
        this.thorchain,
        this.midgard,
        this.thornode,
        this.cosmosTxs,
        this.notFinal,
        this.stuckBefore(),
        undefined,
        { viewblock: this.viewblock, evm: this.evmReceipts },
        this.tcyClaims,
      ),
      ...this.otherMidgards.map(
        ({ protocol, midgard, node }) =>
          new MidgardSource(protocol, midgard, this.thornode, this.cosmosTxs, this.notFinal, this.stuckBefore(), node),
      ),
      new TcySource(this.tcyDistribution),
      ...this.otherMidgards.flatMap(({ midgard, distribution }) =>
        distribution ? [new MayaDistributionSource(midgard, distribution)] : [],
      ),
    ];
  }

  // Every wallet's bundles, wallet by wallet in config order
  async collectBundles(): Promise<RawBundle[]> {
    const bundles: RawBundle[] = [];

    for (const wallet of this.config.wallets) {
      for (const source of this.sources()) {
        bundles.push(...(await source.bundlesFor(wallet.address)));
      }
    }

    return bundles;
  }

  // With referencePrices = 'all' (the default), each bundle with the USD prices of its legs (docs/specs/prices.md); otherwise the
  // bundles as they are, so a run fetches no price. Only a bundle that can give rows is priced: one listing of each
  // action, dated inside the run's periods (a day's margin either side, for the time zone).
  async withPrices(bundles: RawBundle[]): Promise<RawBundle[]> {
    if ((this.config.referencePrices ?? "all") !== "all") {
      return bundles;
    }

    const prices = new PriceSource(
      new Map([
        [THORCHAIN.id, this.midgard],
        ...this.otherMidgards.map(({ protocol, midgard }) => [protocol.id, midgard] as [string, MidgardService]),
      ]),
    );
    const day = 24 * 60 * 60 * 1000;
    const from = new Date(this.config.fromDate).getTime() - day;
    const to = new Date(this.config.toDate).getTime() + 2 * day;
    const exported = new Set(
      dedupeBundles(bundles).bundles.filter((bundle) => {
        const time = getBundleDate(bundle).getTime();
        return time >= from && time < to;
      }),
    );
    const priced: RawBundle[] = [];

    try {
      for (const bundle of bundles) {
        priced.push(exported.has(bundle) ? await prices.add(bundle) : bundle);
      }
    } catch (error) {
      // A store made before reference prices has none (docs/specs/prices.md, The option)
      if (error instanceof StoreMissError) {
        throw new StoreMissError(
          `${error.message.replace(/^Offline: nothing stored for /, "")}. This store has no reference prices for ` +
            `this run: run without --offline to fetch them, or set referencePrices = "swaps" to reproduce an earlier ` +
            "run (docs/specs/prices.md)",
        );
      }

      throw error;
    }

    return priced;
  }

  // Every row of the bundles; issues are logged, and unsupported and failed actions saved
  getRows(bundles: RawBundle[], outputPath: string): SummRow[] {
    const unique = dedupeBundles(bundles);
    const sends = selectSends(unique.bundles);
    this.reportNotFinal(sends.bundles);
    const auction = attachAuctionDeposits(sends.bundles);

    if (unique.duplicates > 0) {
      this.report.info(`Skipped ${unique.duplicates} Midgard actions also listed for an earlier wallet`);
    }

    if (sends.dropped.inbound > 0) {
      this.report.info(`Skipped ${sends.dropped.inbound} Midgard sends that are another action's inbound`);
    }

    if (sends.dropped.outbound > 0) {
      this.report.info(`Skipped ${sends.dropped.outbound} Midgard sends that are another action's outbound`);
    }

    if (auction.attached > 0) {
      this.report.info(`Attached ${auction.attached} Midgard sends to Maya liquidity auction adds as their deposits`);
    }

    const results = auction.bundles.map((bundle) =>
      runBundle(bundle, this.protocolFor(bundle), {
        assets: this.config.assets,
        mayaLiquidityAuction: this.config.mayaLiquidityAuction,
        incomeFrom: this.config.incomeFrom,
        referencePrices: this.config.referencePrices,
      }),
    );
    results.forEach((result) => this.handleIssues(result, outputPath));
    const actionMemos = results
      .flatMap((result) => result.issues)
      .filter((issue) => issue.message.startsWith(ACTION_MEMO_WARNING)).length;
    this.endWarnings = [actionMemoSummary(actionMemos, this.config.protocols ?? ["thorchain"])].filter(
      (line): line is string => !!line,
    );

    const rows = collectRows(results);
    const distributors = knownDistributorReport(rows, this.config.incomeFrom);
    distributors.info.forEach((line) => this.report.info(line));
    this.endWarnings.push(...distributors.warnings);

    return rows;
  }

  // An action still pending from before this date is stuck
  private stuckBefore(): Date {
    return new Date(this.today.getTime() - this.config.pendingStuckDays * 86400_000);
  }

  // Every action that is not final, once, oldest first, with its age and whether it was exported, or which send
  // stands in for it (docs/specs/pending.md)
  private reportNotFinal(bundles: RawBundle[]) {
    const byKey = new Map(this.notFinal.map((item) => [item.key, item]));
    const sends = inboundSends([...byKey.values()], bundles);
    const items = [...byKey.values()].sort(
      (a, b) => getActionDate(a.action).getTime() - getActionDate(b.action).getTime(),
    );

    if (items.length === 0) {
      return;
    }

    // Only a pending action may still finish, so only it has an age class; a failed one is final as failed
    const ages = items.map((item) =>
      item.action.status === "pending"
        ? pendingAge(getActionDate(item.action), this.today, this.config.pendingGraceDays, this.config.pendingStuckDays)
        : undefined,
    );

    const count = (age: PendingAge) => ages.filter((a) => a === age).length;
    const others = ages.filter((age) => age === undefined).length;
    const exported = items.filter((item) => item.exported).length;
    const covered = items.filter((item) => item.coveredBy).length;
    this.report.info(
      `Not final: ${items.length} Midgard actions (${count("recent")} recent, ${count("waiting")} waiting, ${count("stuck")} stuck${others ? `, ${others} failed` : ""}); ${exported} exported, ${covered} covered by a successful action, ${items.length - exported - covered} not exported`,
    );

    items.forEach((item, i) => {
      const { action } = item;
      const date = getActionDate(action);
      const txType = (action.metadata?.swap as any)?.txType;
      const type = txType ? `${action.type} (${txType})` : action.type;
      const days = Math.floor(ageInDays(date, this.today));
      const send = sends.get(item.key);
      const outcome = item.coveredBy
        ? `covered by ${item.coveredBy}`
        : item.exported
          ? "exported"
          : send
            ? `not exported; its inbound is exported as a send (${send})${ages[i] ? " until it is final" : ""}`
            : "not exported";
      this.report.issue(
        "notFinal",
        `${date.toISOString()} ${type}: ${action.status}, ${days} days old${ages[i] ? `, ${ages[i]}` : ""}; ${outcome}`,
        item.key,
      );
    });
  }

  // Unsupported actions are saved for triage and failures with their error, both in the run's folder; those, warnings and
  // actions to enter by hand are logged
  private handleIssues({ bundle, time, rows, issues }: BundleResult, outputPath: string) {
    const date = time.toISOString();
    const type = bundle.source === "midgard" ? (bundle.data as Action).type : bundle.source;

    if (
      bundle.source === "midgard" &&
      !issues.some((issue) => ["unsupported", "failed", "ignored"].includes(issue.kind))
    ) {
      console.log(`${date} ${type}: ${rows.length}`);
    }

    const key = getBundleKey(bundle);

    for (const issue of issues) {
      if (issue.kind === "warning" || issue.kind === "manual") {
        this.report.issue(
          issue.kind,
          `${date} ${type}: ${issue.kind === "manual" ? "enter by hand: " : ""}${issue.message}`,
          key,
        );
      } else if (issue.kind === "unsupported") {
        this.report.issue("unsupported", `${date} ${type}: unsupported action`, key);
        this.saveUnsupported(bundle, outputPath);
      } else if (issue.kind === "failed") {
        this.report.issue("failed", `${date} ${type}: ${issue.message}`, key);
        this.saveFailure(outputPath, bundle.wallet, getBundleSourceName(bundle), time, bundle.data, issue.message);
      }
    }
  }

  // In the run's folder, so it lists only what this run could not map
  private saveUnsupported(bundle: RawBundle, outputPath: string) {
    const filePath = path.join(outputPath, "unsupported", unsupportedActionFile(bundle));
    fs.outputFileSync(filePath, JSON.stringify(bundle.data, null, 4));
  }

  // Midgard actions and CACAO payouts to MAYA holders are mapped with their protocol's asset-name settings; Viewblock sends
  // and TCY distributions with THORChain's defaults
  private protocolFor(bundle: RawBundle): Protocol {
    if (bundle.source === "viewblock" || bundle.source === "tcy") {
      return THORCHAIN;
    }

    return [{ protocol: this.thorchain }, ...this.otherMidgards].find(
      ({ protocol }) => protocol.id === bundle.protocol,
    )!.protocol;
  }

  // Writes the CSV files that csvFiles lays out
  saveToCsv(txs: SummRow[], outputPath: string) {
    const ranges = generateDateRanges(this.config.fromDate, this.config.toDate, this.config.frequency);
    const { files, exported, warnings } = csvFiles(txs, ranges, this.config.wallets, this.config.timezone);
    warnings.forEach((warning) => this.report.warn(`WARN: ${warning}`));
    files.forEach((file) => writeCsv(path.join(outputPath, file.name), file.rows));
    // Next to csv/, so it is not uploaded: it names wallets and records
    fs.outputFileSync(path.join(path.dirname(outputPath), ROW_IDS_FILE), renderRowIds(files[0].rows));
    this.report.info(`Total exported: ${exported}`);
  }

  private saveFailure(
    outputPath: string,
    walletAddress: string,
    source: string,
    date: Date,
    data: any,
    errorMessage: string,
  ): void {
    const failureDir = path.join(outputPath, "failures", walletAddress, source);
    fs.ensureDirSync(failureDir);
    const timestamp = format(date, "yyyy-MM-dd_HHmm_ssSSS");
    fs.writeJsonSync(
      path.join(failureDir, `${timestamp}.json`),
      { ERROR_MESSAGE: errorMessage, ...data },
      { spaces: 4 },
    );
  }
}

// Where an unsupported Midgard action is saved, under <run>/unsupported/: [<protocol>/]<type>/<record key>.json.
// The record key (midgardActionKey) is unique per action, so the several contract actions of one tx each get a
// file; a '/' in a contract type becomes '_'.
export function unsupportedActionFile(bundle: RawBundle): string {
  const action = bundle.data as Action;
  const protocolDir = bundle.protocol === THORCHAIN.id ? "" : bundle.protocol;
  return path.join(protocolDir, action.type, midgardActionKey(action).replace(/[\\/:*?"<>|]/g, "_") + ".json");
}
