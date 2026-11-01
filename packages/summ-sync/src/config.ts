// <state dir>/summ-sync.json: the sync's settings (docs: README.md).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Config {
  /** Chains whose CSV files the user uploads; the sync manages their rows. */
  managedChains: string[];
  /** Summ's source names of the uploaded rows. */
  managedSources: string[];
  /** Rows before this date (YYYY-MM-DD) are in filed years. */
  filedBefore: string | null;
  /** Summ's account timezone (IANA name): the days of the run's periods and of filedBefore. */
  timezone: string;
  /** Folders (relative to the state dir) of hand-made period files, e.g. manual rows; read with the run. */
  extraDirs: string[];
  /** IDs of extra rows that are right beside the run's rows they overlap: not reported, and nothing held back. */
  keepExtra: string[];
  /** Rows the plan leaves alone while a decision outside the sync is pending: nothing is planned for them. */
  hold: Hold[];
  /** Manual entries the user has decided to delete: planned like any delete. Any other manual entry still holds. */
  deleteManualEntries: DeleteManualEntry[];
  /** Decisions of a plan the user has read and goes ahead with, by key. */
  accept: Accept[];
}

/** What a snippet in plan.md prints for the user's own reason: a config holding it was not finished. */
export const WHY = "<why>";

/** A decision to go ahead with: closed while the event is what its key says. */
export interface Accept {
  key: string;
  reason: string;
}

/** A held row by its ID, or every row naming a txid. */
export type Hold = ({ id: string; txid?: undefined } | { txid: string; id?: undefined }) & { reason: string };

/** A manual entry by its leg, with what it must still hold, so an entry that changed or a wrong id stops the plan. */
export interface DeleteManualEntry {
  legId: string;
  currency: string;
  quantity: number;
  reason: string;
}

export const DEFAULTS: Config = {
  managedChains: ["THOR", "MAYA"],
  managedSources: [],
  filedBefore: null,
  timezone: "UTC",
  extraDirs: [],
  keepExtra: [],
  hold: [],
  deleteManualEntries: [],
  accept: [],
};

export function parseConfig(text: string): Config {
  const config: Config = { ...DEFAULTS, ...JSON.parse(text) };
  for (const key of ["managedChains", "managedSources", "extraDirs", "keepExtra"] as const) {
    const value: unknown = config[key];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new Error(`summ-sync.json: ${key} must be a list of strings`);
    }
  }
  if (
    !Array.isArray(config.hold) ||
    !config.hold.every(
      (h) =>
        (typeof h?.id === "string") !== (typeof h?.txid === "string") &&
        (h.txid === undefined || (/^(0x)?[0-9a-fA-F]{64}$/.test(h.txid) && !/^(0x)?0+$/.test(h.txid))) &&
        typeof h.reason === "string" &&
        h.reason.trim() !== "",
    )
  ) {
    throw new Error(
      'summ-sync.json: hold must be a list of {"id": "<row ID>", "reason": "<why>"} or {"txid": "<txid>", "reason": "<why>"}, each with a reason',
    );
  }
  if (
    !Array.isArray(config.deleteManualEntries) ||
    !config.deleteManualEntries.every(
      (m) =>
        typeof m?.legId === "string" &&
        m.legId !== "" &&
        typeof m.currency === "string" &&
        m.currency !== "" &&
        typeof m.quantity === "number" &&
        typeof m.reason === "string" &&
        m.reason.trim() !== "",
    )
  ) {
    throw new Error(
      'summ-sync.json: deleteManualEntries must be a list of {"legId": "<leg>", "currency": "<symbol>", "quantity": <number>, "reason": "<why>"}',
    );
  }
  if (
    !Array.isArray(config.accept) ||
    !config.accept.every(
      (a) => typeof a?.key === "string" && a.key !== "" && typeof a.reason === "string" && a.reason.trim() !== "",
    )
  ) {
    throw new Error('summ-sync.json: accept must be a list of {"key": "<decision key>", "reason": "<why>"}');
  }
  const unfinished = [...config.hold, ...config.deleteManualEntries, ...config.accept].filter(
    (e) => e.reason.trim() === WHY,
  );
  if (unfinished.length)
    throw new Error(`summ-sync.json: ${unfinished.length} entries still say ${WHY}: write the reason`);
  const named = config.deleteManualEntries.map((m) => m.legId);
  if (new Set(named).size !== named.length) throw new Error("summ-sync.json: deleteManualEntries names a leg twice");
  if (config.filedBefore !== null && !/^\d{4}-\d{2}-\d{2}$/.test(config.filedBefore)) {
    throw new Error("summ-sync.json: filedBefore must be a date (YYYY-MM-DD) or null");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
  } catch {
    throw new Error(
      `summ-sync.json: timezone must be an IANA name such as "Europe/London" (got ${JSON.stringify(config.timezone)})`,
    );
  }
  return config;
}

export function loadConfig(stateDir: string): Config {
  const file = join(stateDir, "summ-sync.json");
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8")) : { ...DEFAULTS };
}

/** What summ-sync.json holds now, to tell whether a plan was made from it. */
export function configSha(stateDir: string): string {
  const file = join(stateDir, "summ-sync.json");
  return createHash("sha256")
    .update(existsSync(file) ? readFileSync(file) : "")
    .digest("hex");
}

/** config.extraDirs as paths: each is relative to the state dir. */
export function extraDirsOf(stateDir: string, config: Config): string[] {
  return config.extraDirs.map((dir) => resolve(stateDir, dir));
}
