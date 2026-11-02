import { after, before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { caseWallets, type Case, fillStore, runFolders, thorchainCases } from "./helpers/caseStore.ts";
import { ROW_IDS_FILE, txToCsv } from "../src/export/summ/csv/index.ts";
import { MANIFEST_FILE, SnapshotManifest } from "../src/sources/store/SnapshotManifest.ts";
import { SUMMARY_FILE } from "../src/cli/RunSummary.ts";

// The whole export, offline: a store made from the golden cases, the CLI run on it, then replayed
// (docs/specs/fixtures.md, End-to-end export)

const CLI = path.join(import.meta.dirname, "..", "src", "full-export.ts");
const CASES = path.join(import.meta.dirname, "cases");

// The CLI's output, or its error output when it fails
function exportCli(dir: string, ...args: string[]): { ok: boolean; output: string } {
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: dir, stdio: "pipe", encoding: "utf8" });
    return { ok: true, output: "" };
  } catch (error: any) {
    return { ok: false, output: `${error.stdout}\n${error.stderr}` };
  }
}

// A CSV file's rows, without the header
function csvRows(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").slice(1);
}

// The rows a case's expected.yaml holds, as CSV lines
function expectedLines(cases: Case[]): string[] {
  return cases.flatMap((c) => c.expected.map((row: any) => txToCsv({ ...row, timestamp: new Date(row.timestamp) })));
}

const sorted = (lines: string[]) => [...lines].sort();

describe("offline export of the golden cases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-offline-"));
  const { cases, skipped } = thorchainCases(CASES);
  const wallets = caseWallets(cases);
  // Yearly files over the years of the cases' rows (from before 2022-04, so Viewblock is read too)
  const years = cases.flatMap((c) => c.expected.map((row: any) => row.timestamp.slice(0, 4) as string)).sort();
  const config = {
    fromDate: `${years[0]}-01-01`,
    toDate: `${years[years.length - 1]}-12-31`,
    frequency: "yearly",
    outputPath: "output",
    storePath: "store",
    wallets,
  };
  let run: string;

  before(async () => {
    fs.writeJsonSync(path.join(dir, "config.json"), config);
    // The replay writes to its own folder, so its run can't take the first run's timestamp
    fs.writeJsonSync(path.join(dir, "replay.json"), { ...config, outputPath: "replayed" });
    const log = mock.method(console, "log", () => {});
    await fillStore(path.join(dir, "config.json"), cases, new Date());
    log.mock.restore();

    const result = exportCli(dir, "config.json", "--offline");
    assert.ok(result.ok, result.output);
    [run] = runFolders(path.join(dir, "output"));
  });

  after(() => fs.removeSync(dir));

  test("most cases share the store", () => {
    // Left out: duplicates of a case with prices, and anonymised cases whose placeholder txids clash
    assert.ok(cases.length >= 50, `${cases.length} cases, skipped ${skipped.join(", ")}`);
    assert.ok(skipped.length <= 15, `skipped ${skipped.join(", ")}`);
  });

  test("all.csv holds every case's expected rows, and only those", () => {
    assert.deepEqual(sorted(csvRows(path.join(run, "csv", "all.csv"))), sorted(expectedLines(cases)));
  });

  test("each period's rows are in its all-<period> file and in their wallet's file", () => {
    const rows = cases.flatMap((c) => c.expected) as any[];
    const files = new Map<string, string[]>();
    const add = (name: string, row: any) =>
      files.set(name, [...(files.get(name) ?? []), txToCsv({ ...row, timestamp: new Date(row.timestamp) })]);

    for (const row of rows) {
      const year = row.timestamp.slice(0, 4);
      const period = `${year}-01-01_${year}-12-31`;
      const wallet = wallets.find((w) => w.address.toLowerCase() === row.wallet.toLowerCase());
      add(`all-${period}.csv`, row);
      add(
        row.wallet === "thorchain"
          ? `${period}_THOR_thorchain_swaps.csv`
          : `${period}_${wallet!.blockchain}_${wallet!.address.slice(-5)}_${wallet!.name}.csv`,
        row,
      );
    }

    assert.deepEqual(fs.readdirSync(path.join(run, "csv")).sort(), ["all.csv", ...files.keys()].sort());

    for (const [name, lines] of files) {
      assert.deepEqual(sorted(csvRows(path.join(run, "csv", name))), sorted(lines), name);
    }
  });

  test("summary.md reports the run", () => {
    const summary = fs.readFileSync(path.join(run, SUMMARY_FILE), "utf8");
    const rows = expectedLines(cases).length;

    assert.match(summary, /^# Run summary\n\n## Run\n/);
    assert.match(summary, /- Mode: offline; store .*store\n/);
    assert.match(summary, new RegExp(`- Total exported: ${rows}\n`));
    assert.match(summary, /- Snapshot: \d+ records from \d+ wallet lists\. Fetched: 0 new, 0 changed, 0 unchanged\./);
    // Every row is in a configured wallet's file, and no action failed or is unsupported
    assert.doesNotMatch(summary, /## Warnings/);
    assert.doesNotMatch(summary, /## Failed actions/);
    assert.doesNotMatch(summary, /## Unsupported actions/);
    // The pending cases (a refund never paid, a pending loan open) and a failed send
    assert.match(summary, /## Not final \(status not success\) \(3\)/);
    // row-ids.csv, next to csv/: a line per row
    assert.equal(fs.readFileSync(path.join(run, ROW_IDS_FILE), "utf8").trim().split("\n").length - 1, rows);
  });

  test("snapshots.json names every list and record the run read, each in the store", () => {
    const manifest = fs.readJsonSync(path.join(run, MANIFEST_FILE));
    const thorWallets = wallets.filter((w) => w.address.startsWith("thor1")).length;

    // Midgard for every wallet; Viewblock (the period starts before 2022-04) and TCY for THORChain wallets
    assert.equal(manifest.lists.length, wallets.length + 2 * thorWallets);
    assert.ok(manifest.records.length > cases.length);

    for (const entry of [...manifest.records, ...manifest.lists]) {
      assert.ok(fs.existsSync(path.join(dir, "store", entry.file)), entry.file);
    }

    assert.ok(manifest.records.every((entry: any) => entry.fetched === undefined));
    assert.ok(SnapshotManifest.load(run).findList("midgard", wallets[0].address));
  });

  test("a replay of the run writes the same files", () => {
    const result = exportCli(dir, "replay.json", "--replay", run);
    assert.ok(result.ok, result.output);
    const [replayed] = runFolders(path.join(dir, "replayed"));
    const names = fs.readdirSync(path.join(run, "csv")).sort();

    assert.deepEqual(fs.readdirSync(path.join(replayed, "csv")).sort(), names);

    for (const name of [...names.map((name) => path.join("csv", name)), ROW_IDS_FILE, MANIFEST_FILE]) {
      assert.equal(fs.readFileSync(path.join(replayed, name), "utf8"), fs.readFileSync(path.join(run, name), "utf8"));
    }

    assert.match(fs.readFileSync(path.join(replayed, SUMMARY_FILE), "utf8"), /- Mode: replay of /);
  });

  test("an offline run fails on a record the store does not hold, and names it", () => {
    const store = path.join(dir, "store-missing");
    fs.copySync(path.join(dir, "store"), store);
    const [file] = fs
      .readdirSync(path.join(store, "records", "thornode"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile());
    fs.removeSync(path.join(file.parentPath, file.name));
    fs.writeJsonSync(path.join(dir, "missing.json"), { ...config, storePath: "store-missing", outputPath: "missing" });

    const result = exportCli(dir, "missing.json", "--offline");
    assert.equal(result.ok, false);
    assert.match(result.output, /Offline: nothing stored for thornode [0-9A-F]{64}/);
  });
});
