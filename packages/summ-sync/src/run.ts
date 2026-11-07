// A run folder, the desired state: the rows of its period wallet files.
//
//   <run dir>/csv/<from>_<to>_<CHAIN>_<wallet>_<name>.csv   one wallet's rows in one period
//
// all.csv and all-<from>_<to>.csv are not read: all.csv holds rows outside the run's periods, and
// neither is uploaded. Each row's on-chain txids are the 64-hex strings in its description.
// Extra folders (config.extraDirs) hold hand-made files of the same shape (manual rows, amendments);
// a file there counts only when its period is one of the run's, so it never widens the plan's scope.
//
//   <run dir>/unmapped.json   the records the run could not map (unsupported, failed, or no rows with a warning), with their time and txids
//
// The chain in a file's name is read in any case. Any other .csv in csv/ is refused: its rows would be missing
// from the run, and the plan would delete them from Summ.
//
//   <run dir>/run.json   { "version": 1, "timezone": "<IANA name>" }: the timezone the exporter cut the periods in

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface Period {
  from: string;
  to: string;
}

export interface RunFile {
  name: string;
  chain: string;
  period: Period;
  header: string;
}

export interface Row {
  file: string;
  chain: string;
  /** The row's line as the exporter wrote it, for upload files. */
  line: string;
  id: string;
  timestamp: string;
  type: string;
  baseCurrency: string;
  baseAmount: string;
  quoteCurrency: string;
  quoteAmount: string;
  feeCurrency: string;
  feeAmount: string;
  from: string;
  to: string;
  blockchain: string;
  description: string;
  /** The row's reference price, as the CSV holds it (blank when it has none). */
  referencePrice?: string;
  referencePriceCurrency?: string;
  /** Lower case, without 0x. */
  txids: string[];
  /** From a file in an extra folder (config.extraDirs), not the run's own. */
  extra?: true;
}

const COLUMNS: Record<string, keyof Row> = {
  "Timestamp (UTC)": "timestamp",
  Type: "type",
  "Base Currency": "baseCurrency",
  "Base Amount": "baseAmount",
  "Quote Currency (Optional)": "quoteCurrency",
  "Quote Amount (Optional)": "quoteAmount",
  "Fee Currency (Optional)": "feeCurrency",
  "Fee Amount (Optional)": "feeAmount",
  "From (Optional)": "from",
  "To (Optional)": "to",
  "Blockchain (Optional)": "blockchain",
  "ID (Optional)": "id",
  "Description (Optional)": "description",
};

const PRICE_COLUMNS: Record<string, keyof Row> = {
  "Reference Price Per Unit (Optional)": "referencePrice",
  "Reference Price Currency (Optional)": "referencePriceCurrency",
};

const WALLET_FILE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_([A-Za-z0-9]+)_.+\.csv$/;
/** The files of csv/ that are not uploaded: every row, and every row of one period. */
const ALL_FILE = /^all(-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})?\.csv$/;

/** One CSV line: fields with a comma or a quote are quoted, quotes doubled (RFC 4180); no newline in a field. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let field = "";
    if (line[i] === '"') {
      for (i++; ; i++) {
        if (i >= line.length) throw new Error(`Unclosed quote: ${line}`);
        if (line[i] === '"') {
          if (line[i + 1] !== '"') break;
          i++;
        }
        field += line[i];
      }
      i++;
      if (i < line.length && line[i] !== ",") throw new Error(`Text after a closing quote: ${line}`);
    } else {
      const end = line.indexOf(",", i);
      field = line.slice(i, end === -1 ? line.length : end);
      i = end === -1 ? line.length : end;
    }
    fields.push(field);
    if (i >= line.length) return fields;
    i++;
  }
}

export function txidsOf(description: string): string[] {
  return [
    ...new Set(
      [...description.matchAll(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()),
    ),
  ];
}

export function parseWalletFile(name: string, text: string): { file: RunFile; rows: Row[] } {
  const m = name.match(WALLET_FILE);
  if (!m) throw new Error(`Not a period wallet file: ${name}`);
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l !== "");
  const names = parseCsvLine(header);
  for (const column of Object.keys(COLUMNS)) {
    if (!names.includes(column)) throw new Error(`${name}: no column "${column}"`);
  }
  const file: RunFile = { name, chain: m[3].toUpperCase(), period: { from: m[1], to: m[2] }, header };
  const rows = lines.map((line) => {
    const values = parseCsvLine(line);
    if (values.length !== names.length)
      throw new Error(`${name}: ${values.length} fields, header has ${names.length}: ${line}`);
    const row = { file: name, chain: file.chain, line, txids: [] as string[] } as unknown as Row;
    names.forEach((column, i) => {
      const key = COLUMNS[column] ?? PRICE_COLUMNS[column];
      if (key) (row as unknown as Record<string, string>)[key] = values[i];
    });
    if (!row.id) throw new Error(`${name}: a row without an ID: ${line}`);
    row.txids = txidsOf(row.description);
    return row;
  });
  return { file, rows };
}

/** The run's distinct periods. */
export function periodsOf(files: { period: Period }[]): Period[] {
  return [...new Map(files.map((f) => [`${f.period.from}_${f.period.to}`, f.period])).values()];
}

/** Written by the exporter when it skipped a wallet a source failed for (docs/specs/run-summary.md, Not fetched). */
export const NOT_FETCHED_FILE = "not-fetched.json";

export function readRun(runDir: string, extraDirs: string[] = []): { files: RunFile[]; rows: Row[] } {
  // A skipped wallet has no file, so every row of it in Summ would be planned for deletion
  const notFetched = join(runDir, NOT_FETCHED_FILE);
  if (existsSync(notFetched)) {
    let names = "";
    try {
      const wallets = (JSON.parse(readFileSync(notFetched, "utf8")) as { wallets?: { name?: string }[] }).wallets;
      names = (wallets ?? []).map((w) => w.name).join(", ");
    } catch {
      // The refusal stands without the names
    }
    throw new Error(
      `${runDir}: the export could not fetch every wallet${names ? ` (${names})` : ""} and wrote no file for it, ` +
        `so a plan would delete its rows in Summ: export again until every wallet is fetched (${NOT_FETCHED_FILE}, summary.md)`,
    );
  }
  const dir = join(runDir, "csv");
  const files: RunFile[] = [];
  const rows: Row[] = [];
  const seen = new Map<string, string>();
  const add = (path: string, name: string, extra = false) => {
    const parsed = parseWalletFile(name, readFileSync(path, "utf8"));
    // Rows are grouped by file name for upload, under one header
    const same = files.find((f) => f.name === name);
    if (same && same.header !== parsed.file.header)
      throw new Error(`${path}: the same name as another wallet file, with another header: give it its own name`);
    if (extra) for (const row of parsed.rows) row.extra = true;
    files.push(parsed.file);
    for (const row of parsed.rows) {
      const other = seen.get(row.id);
      if (other) throw new Error(`ID ${row.id} is in ${other} and ${name}`);
      seen.set(row.id, name);
      rows.push(row);
    }
  };
  const csvNames = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".csv") && !ALL_FILE.test(n));
  const others = csvNames.filter((n) => !WALLET_FILE.test(n));
  if (others.length)
    throw new Error(
      `Not period wallet files (<from>_<to>_<CHAIN>_<wallet>_<name>.csv) in ${dir}: ${others.join(", ")}. Their rows would be missing from the run, and the plan would delete them from Summ: fix the wallet's blockchain or address in the exporter's config and export again, or move the file out of csv/`,
    );
  for (const name of csvNames.sort()) add(join(dir, name), name);
  if (files.length === 0) throw new Error(`No period wallet files (<from>_<to>_<CHAIN>_...csv) in ${dir}`);
  const periods = new Set(files.map((f) => `${f.period.from}_${f.period.to}`));
  for (const extra of extraDirs) {
    const names = (readdirSync(extra, { recursive: true }) as string[])
      .filter((n) => WALLET_FILE.test(basename(n)))
      .sort();
    for (const path of names) {
      const name = basename(path);
      const m = name.match(WALLET_FILE) as RegExpMatchArray;
      if (periods.has(`${m[1]}_${m[2]}`)) add(join(extra, path), name, true);
    }
  }
  return { files, rows };
}

/** A record the run could not map (unmapped.json): the rows an earlier run made of it are not in this one. */
export interface Unmapped {
  kind: string;
  record: string;
  wallet: string;
  /** The record's time, as a row ID made from it starts. */
  time: string;
  /** Every time a row ID made from it can start with: its own, each attached inbound's, and a withdrawn pending add's. */
  times: string[];
  /** Lower case. */
  txids: string[];
  reason: string;
}

export const UNMAPPED_FILE = "unmapped.json";

/** The run's unmapped.json, or null for a run made before it. */
export function readUnmapped(runDir: string): Unmapped[] | null {
  const path = join(runDir, UNMAPPED_FILE);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: number; records?: Unmapped[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error(`${path}: not version 1`);
  return parsed.records.map((r) => ({
    ...r,
    times: r.times ?? [r.time],
    txids: r.txids.map((t) => t.toLowerCase()),
  }));
}

/**
 * Checks the run was cut in summ-sync's timezone: scope and filedBefore are judged in it, so a run cut in another
 * would put legs near a period's edge in or out of scope unlike the files that hold their rows. Throws when the
 * run's run.json names another timezone; returns a note when the run has none (written before run.json was).
 */
export function checkRunTimezone(runDir: string, timezone: string): string | null {
  const file = join(runDir, "run.json");
  if (!existsSync(file))
    return `timezone: the run has no run.json (an older exporter), so its timezone is not known; summ-sync judges scope in ${timezone}: check the exporter config's timezone is the same`;
  const info = JSON.parse(readFileSync(file, "utf8")) as { timezone?: unknown };
  if (typeof info.timezone !== "string") throw new Error(`${file}: no timezone`);
  if (info.timezone !== timezone)
    throw new Error(
      `The run's periods are in ${info.timezone} (${file}), summ-sync.json's timezone is ${timezone}: set both to your Summ account's timezone and export again`,
    );
  return null;
}
