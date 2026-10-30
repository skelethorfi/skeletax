// A run folder, the desired state: the rows of its period wallet files.
//
//   <run dir>/csv/<from>_<to>_<CHAIN>_<wallet>_<name>.csv   one wallet's rows in one period
//
// all.csv and all-<from>_<to>.csv are not read: all.csv holds rows outside the run's periods, and
// neither is uploaded. Each row's on-chain txids are the 64-hex strings in its description.
// Extra folders (config.extraDirs) hold hand-made files of the same shape (manual rows, amendments);
// a file there counts only when its period is one of the run's, so it never widens the plan's scope.

import { readdirSync, readFileSync } from "node:fs";
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

const WALLET_FILE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_([A-Z0-9]+)_.+\.csv$/;

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
  const file: RunFile = { name, chain: m[3], period: { from: m[1], to: m[2] }, header };
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

export function readRun(runDir: string, extraDirs: string[] = []): { files: RunFile[]; rows: Row[] } {
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
  for (const name of readdirSync(dir)
    .filter((n) => WALLET_FILE.test(n))
    .sort())
    add(join(dir, name), name);
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
