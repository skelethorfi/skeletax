import fs from "fs-extra";
import * as path from "path";

// A run's snapshot: the copy of each record it used and the record keys of each wallet list, written to
// its output folder as snapshots.json, so the run can be replayed exactly (--replay). Paths are relative to
// the store root (the config's storePath). See docs/specs/snapshots.md.

export const MANIFEST_FILE = "snapshots.json";

// The store layout the manifest's paths are in: 3 is records/<source>/<yyyy>/<mm>/<key>.<n>.json
const LAYOUT = 3;

const FETCHED_RANK: RecordEntry["fetched"][] = [undefined, "unchanged", "new", "changed"];

export interface RecordEntry {
  source: string;
  key: string;
  // The copy used, relative to the store root
  file: string;
  fetchedAt: string | null;
  url?: string;
  sha256: string;
  // Why this copy: the only one, a finalised copy over a pending one, a revised copy, or the earlier
  // copy kept because a later one has less in it (pruned)
  choice: string;
  // Copies stored
  copies: number;
  // What this run's fetch did, if it fetched the record: first copy, a new copy, or the same as before
  fetched?: "new" | "changed" | "unchanged";
  // In an earlier fetch of a wallet, but not in the latest; kept
  missing?: boolean;
}

export interface ListEntry {
  source: string;
  wallet: string;
  // The record keys used, in order
  keys: string[];
  // Keys kept from earlier fetches but missing from the latest
  missing: string[];
  // The latest list file
  file: string;
  // The latest list came back short from the source: why
  incomplete?: string;
}

// A record a best-effort source (Viewblock) could not give the run: a replay gives nothing for it, as the run had
export interface SkippedEntry {
  source: string;
  key: string;
}

export class SnapshotManifest {
  private records = new Map<string, RecordEntry>();
  private lists = new Map<string, ListEntry>();
  private skipped = new Map<string, SkippedEntry>();

  constructor(records: RecordEntry[] = [], lists: ListEntry[] = [], skipped: SkippedEntry[] = []) {
    records.forEach((entry) => this.records.set(this.id(entry.source, entry.key), entry));
    lists.forEach((entry) => this.lists.set(this.id(entry.source, entry.wallet), entry));
    skipped.forEach((entry) => this.skipped.set(this.id(entry.source, entry.key), entry));
  }

  // A run folder or its snapshots.json
  static load(runOrFile: string): SnapshotManifest {
    const file =
      fs.existsSync(runOrFile) && fs.statSync(runOrFile).isDirectory()
        ? path.join(runOrFile, MANIFEST_FILE)
        : runOrFile;
    const { layout, records, lists, skipped } = fs.readJSONSync(file);

    if (layout !== LAYOUT) {
      throw new Error(
        `${file} was written for an older store layout (${layout ?? 1}); its paths no longer exist, so it can't be replayed`,
      );
    }

    return new SnapshotManifest(records, lists, skipped);
  }

  recordRecord(entry: RecordEntry) {
    const previous = this.records.get(this.id(entry.source, entry.key));
    // A record in several wallets' lists keeps the most telling thing this run's fetches did to it
    const fetched = [previous?.fetched, entry.fetched].sort(
      (a, b) => FETCHED_RANK.indexOf(b) - FETCHED_RANK.indexOf(a),
    )[0];
    this.records.set(this.id(entry.source, entry.key), { ...entry, ...(fetched ? { fetched } : {}) });
  }

  recordList(entry: ListEntry) {
    this.lists.set(this.id(entry.source, entry.wallet), entry);
  }

  recordSkipped(source: string, key: string) {
    this.skipped.set(this.id(source, key), { source, key });
  }

  isSkipped(source: string, key: string): boolean {
    return this.skipped.has(this.id(source, key));
  }

  findRecord(source: string, key: string): RecordEntry | undefined {
    return this.records.get(this.id(source, key));
  }

  findList(source: string, wallet: string): ListEntry | undefined {
    return this.lists.get(this.id(source, wallet));
  }

  // Whether the run read anything from the source
  hasSource(source: string): boolean {
    const prefix = `${source}/`;
    return [...this.lists.keys(), ...this.records.keys()].some((id) => id.startsWith(prefix));
  }

  // Writes the manifest; returns the run's summary of it, for the shell to print
  write(outputPath: string): string[] {
    const records = [...this.records.values()].sort((a, b) =>
      this.id(a.source, a.key).localeCompare(this.id(b.source, b.key)),
    );
    const lists = [...this.lists.values()].sort((a, b) =>
      this.id(a.source, a.wallet).localeCompare(this.id(b.source, b.wallet)),
    );
    const skipped = [...this.skipped.values()].sort((a, b) =>
      this.id(a.source, a.key).localeCompare(this.id(b.source, b.key)),
    );
    fs.outputJsonSync(
      path.join(outputPath, MANIFEST_FILE),
      { layout: LAYOUT, records, lists, ...(skipped.length ? { skipped } : {}) },
      { spaces: 2 },
    );

    const count = (filter: (entry: RecordEntry) => boolean) => records.filter(filter).length;
    const lines = [
      `Snapshot: ${records.length} records from ${lists.length} wallet lists. ` +
        `Fetched: ${count((e) => e.fetched === "new")} new, ${count((e) => e.fetched === "changed")} changed, ${count((e) => e.fetched === "unchanged")} unchanged. ` +
        `Using: ${count((e) => e.choice === "finalised")} finalised, ${count((e) => e.choice === "revised")} revised, ` +
        `${count((e) => e.choice === "kept-over-pruned")} kept over a pruned copy, ${count((e) => !!e.missing)} missing from the source`,
    ];

    // Changes this run found, and records the sources no longer return; earlier choices are in the manifest. A bank
    // balance (the balance check's) changes with any activity, so it is no news
    const notable = records.filter((e) => (e.fetched === "changed" || e.missing) && !e.source.endsWith("-balance"));
    notable
      .slice(0, 20)
      .forEach((entry) =>
        lines.push(`  ${entry.missing ? "missing" : `changed (${entry.choice})`}: ${entry.source} ${entry.key}`),
      );

    if (notable.length > 20) {
      lines.push(`  … and ${notable.length - 20} more (${MANIFEST_FILE})`);
    }

    return lines;
  }

  private id(source: string, key: string): string {
    return `${source}/${key}`;
  }
}
