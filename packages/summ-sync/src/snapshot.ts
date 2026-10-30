// The action store and the snapshots pull writes (spec: docs/specs/summ-sync.md, State dir):
//
//   <state dir>/actions/<action id>.json   one action's JSON and change history, written once: Summ gives an
//                                          action a new id whenever it changes
//   <state dir>/snapshots/<time>.json      one pull: its counts and an entry per listed action
//
// A snapshot is read as legs: each incoming, outgoing and fee leg of every action it needs the detail of, plus
// the tx hashes of every listed action.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ActionDetail } from "./parse.ts";

export type LegSide = "incoming" | "outgoing" | "fees";

export interface Leg {
  /** The leg's database id: stable across edits. */
  legId: string;
  /** The action's id: changes on every write. */
  actionId: string;
  side: LegSide;
  /** Summ's "Tx Hash": the CSV row's ID, or the on-chain txid of Summ's own imports. */
  id: string;
  trade: string;
  currency: string;
  quantity: number;
  timestamp: string;
  from: string;
  to: string;
  blockchain: string;
  description: string;
  source: string;
  importType: string;
  comments: string[];
  /** Summ's price per unit, always in the user's local currency. */
  price?: number | null;
  /** Summ's mark that the price was given in USD. An undo leaves it behind, so it does not prove the price is. */
  priceValueCurrency?: string;
  /** A fee Summ keeps on the leg itself (`feeQuantity`); some imports hold it there with no fee leg. */
  feeQuantity?: number;
  feeCurrency?: string;
}

export interface Snapshot {
  name: string;
  legs: Leg[];
  /** Change history of each action with full detail. */
  history: Map<string, string[]>;
  /** Every listed action's tx hash, lower case without 0x. */
  txHashes: Set<string>;
}

const SIDES: LegSide[] = ["incoming", "outgoing", "fees"];

/** A tx hash as plan compares it: lower case, without 0x, and without the output index some imports append
 * (`<hash>__1`, `<hash>-0`). */
export function normaliseTxid(txid: string): string {
  const hex = txid.match(/^(?:0x)?([0-9a-fA-F]{64})(?:(?:__|-)\d+)?$/);
  return hex ? hex[1].toLowerCase() : txid.toLowerCase().replace(/^0x/, "");
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function legsOf(detail: ActionDetail): Leg[] {
  const action = detail.action;
  return SIDES.flatMap((side) =>
    ((action[side] as Record<string, unknown>[] | undefined) ?? []).map((leg) => ({
      legId: text(leg._id),
      actionId: action._id,
      side,
      id: text(leg.id),
      trade: text(leg.trade),
      currency: text((leg.currencyIdentifier as { symbol?: string } | undefined)?.symbol) || text(leg.currency),
      quantity: Number(leg.quantity),
      timestamp: text(leg.timestamp),
      from: text(leg.from),
      to: text(leg.to),
      blockchain: text(leg.blockchain),
      description: text(leg.description),
      source: text(leg.source),
      importType: text(leg.importType),
      comments: ((leg.comments as { comment?: string }[] | undefined) ?? []).map((c) => text(c.comment)),
      price: typeof leg.price === "number" ? leg.price : null,
      ...(leg.priceValueCurrency ? { priceValueCurrency: text(leg.priceValueCurrency) } : {}),
      ...(Number(leg.feeQuantity) > 0
        ? {
            feeQuantity: Number(leg.feeQuantity),
            feeCurrency:
              text((leg.feeCurrencyIdentifier as { symbol?: string } | undefined)?.symbol) || text(leg.feeCurrency),
          }
        : {}),
    })),
  );
}

/** One listed action in a snapshot. `detail` marks the actions whose detail the plan reads. */
export interface SnapshotEntry {
  id: string;
  txHash: string;
  category: string;
  tags: string[];
  detail?: true;
}

export interface SnapshotFile {
  takenAt: string;
  /** The total the list reported. */
  total: number;
  [count: string]: unknown;
  actions: SnapshotEntry[];
}

export const actionFile = (stateDir: string, actionId: string): string => join(stateDir, "actions", `${actionId}.json`);

export function readAction(stateDir: string, actionId: string): ActionDetail | null {
  const file = actionFile(stateDir, actionId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Writes an action to the store unless it holds the id already (or `replace`); returns the file. */
export function storeAction(stateDir: string, detail: ActionDetail, replace = false): string {
  const file = actionFile(stateDir, detail.action._id);
  if (replace || !existsSync(file)) {
    // Through a temporary file, so a pull that stops never leaves half a file under the id
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(detail, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  }
  return file;
}

/** What the sync reads of an action: its legs and change history entries. The fields that move under the same
 * id (lastModified, updatedAt, balanceSnapshot, sortPriority, the count of earlier versions) are left out. */
export function syncView(detail: ActionDetail): string {
  return JSON.stringify({
    legs: legsOf(detail),
    history: detail.history.filter((h) => !/earlier versions not read/.test(h)),
  });
}

/** The snapshot names (their times), oldest first. */
export function snapshotNames(stateDir: string): string[] {
  const dir = join(stateDir, "snapshots");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -5))
        .sort()
    : [];
}

/** The latest snapshot file. */
export function latestSnapshot(stateDir: string): string {
  const names = snapshotNames(stateDir);
  if (names.length === 0) throw new Error(`No snapshot in ${join(stateDir, "snapshots")}: run pull first`);
  return join(stateDir, "snapshots", `${names[names.length - 1]}.json`);
}

/** Written whole, one action per line, so a pull that stops leaves no snapshot. */
export function writeSnapshot(file: string, snapshot: SnapshotFile): void {
  const { actions, ...counts } = snapshot;
  const head = Object.entries(counts).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const text = [
    "{",
    ...head,
    '  "actions": [',
    actions.map((a) => `    ${JSON.stringify(a)}`).join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export function readSnapshotFile(file: string): SnapshotFile {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A snapshot file read with the stored details of the actions it marks. */
export function readSnapshot(file: string): Snapshot {
  const stateDir = dirname(dirname(file));
  const entries = readSnapshotFile(file).actions;
  const legs: Leg[] = [];
  const history = new Map<string, string[]>();
  for (const id of [...new Set(entries.filter((e) => e.detail).map((e) => e.id))].sort()) {
    const detail = readAction(stateDir, id);
    if (!detail) throw new Error(`${basename(file)} lists action ${id}, which is not in ${join(stateDir, "actions")}`);
    legs.push(...legsOf(detail));
    history.set(detail.action._id, detail.history);
  }
  const txHashes = new Set<string>();
  for (const { txHash } of entries) for (const h of txHash.split(/[\s,]+/)) if (h) txHashes.add(normaliseTxid(h));
  return { name: basename(file, ".json"), legs, history, txHashes };
}
