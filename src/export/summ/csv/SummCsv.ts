import crypto from "crypto";
import fs from "fs-extra";
import type { SummRow, RowTrace } from "./SummRow.ts";
import { sortNewestFirst } from "./index.ts";

export const csvMapping = [
  { header: "Timestamp (UTC)", field: "timestamp" },
  { header: "Type", field: "type" },
  { header: "Base Currency", field: "baseCurrency" },
  { header: "Base Amount", field: "baseAmount" },
  { header: "Quote Currency (Optional)", field: "quoteCurrency" },
  { header: "Quote Amount (Optional)", field: "quoteAmount" },
  { header: "Fee Currency (Optional)", field: "feeCurrency" },
  { header: "Fee Amount (Optional)", field: "feeAmount" },
  { header: "From (Optional)", field: "from" },
  { header: "To (Optional)", field: "to" },
  { header: "Blockchain (Optional)", field: "blockchain" },
  { header: "ID (Optional)", field: "id" },
  { header: "Description (Optional)", field: "description" },
  { header: "Reference Price Per Unit (Optional)", field: "referencePricePerUnit" },
  { header: "Reference Price Currency (Optional)", field: "referencePriceCurrency" },
];

function createHeader(): string {
  return csvMapping.map((item) => item.header).join(",") + "\n";
}

export function txToCsv(tx: SummRow): string {
  return csvMapping.map((column) => csvField(formatValue((tx as any)[column.field]))).join(",");
}

function formatValue(value: Date | string | undefined): string {
  return value instanceof Date ? value.toISOString() : (value ?? "");
}

// Newlines become '; ' so every row stays on one line. A field with a comma or a double quote is
// quoted, with its quotes doubled (RFC 4180); every other field is written as it is.
export function csvField(value: string): string {
  const text = value.replaceAll("\n", "; ");
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// The text of one CSV file: the header, then the rows newest first
export function renderCsv(txs: SummRow[]): string {
  return (
    createHeader() +
    sortNewestFirst([...txs])
      .map(txToCsv)
      .join("\n")
  );
}

// A row's ID depends only on what the row is, never on its amounts or wording, so it is the same in every
// file and every run (docs/specs/periods.md, Row IDs): `<action time>.<role>.<hash>`, the hash being the first
// 12 hex digits of SHA-256 over the format version, the action's store record (a FIN swap's without its fill
// hash), the wallet, the role and the asset. It traces a row in Summ (its "Tx Hash") back to the action.
export function rowId(time: Date, wallet: string, trace: RowTrace): string {
  const identity = ["v1", trace.record ?? "", wallet, trace.role, trace.asset ?? ""].join("|");
  return `${time.toISOString()}.${trace.role}.${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

// Checks every row has an ID and no two share one: two rows with one identity are a mapper bug
export function assignRowIds(rows: SummRow[]): SummRow[] {
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.id) {
      throw new Error(`Row without an ID: ${txToCsv(row)}`);
    }

    if (seen.has(row.id)) {
      throw new Error(
        `Two rows with the ID ${row.id} (${row.trace?.record ?? "no record"}, ${row.trace?.role ?? "no role"})`,
      );
    }

    seen.add(row.id);
  }

  return rows;
}

export function writeCsv(filename: string, txs: SummRow[]) {
  if (txs.length === 0) {
    return;
  }

  console.log(`Write CSV: ${filename}`);
  fs.outputFileSync(filename, renderCsv(txs));
}

export const ROW_IDS_FILE = "row-ids.csv";

// What each row's ID is made from, newest first: to trace a row in Summ back to its action
export function renderRowIds(rows: SummRow[]): string {
  const lines = sortNewestFirst([...rows]).map((row) =>
    [row.id, formatValue(row.timestamp), row.type, row.wallet, row.trace?.record, row.trace?.role, row.trace?.asset]
      .map((value) => csvField(value ?? ""))
      .join(","),
  );
  return ["ID,Timestamp (UTC),Type,Wallet,Record,Role,Asset", ...lines].join("\n") + "\n";
}
