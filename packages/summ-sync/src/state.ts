// The sync's own tables in the state dir:
//
//   adopted.csv       Leg,ID: a leg uploaded with an old <file>:<n> ID, and the row it was adopted to
//   overrides.json    values the user set in Summ, kept over the run's (spec: Drift and overrides)
//   apply-log.jsonl   one line per call apply made; an edit's lines carry {legId, field, value, ...}
//
// plan only lists what it adopted and captured; apply adds those to the first two tables (mergeTables), so a
// plan that is never applied changes nothing later plans assume.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Value = string | number | null;

export interface Override {
  /** The row's ID. */
  id: string;
  /** Which of the row's legs: its base leg, the quote leg of a trade, or its fee leg. */
  leg: LegRole;
  field: string;
  /** The run's value when the override was captured. */
  run: Value;
  /** The user's value in Summ: kept. */
  summ: Value;
  seenAt: string;
  /** For the user to fill in. */
  reason: string;
  /** The user's decision on their value: yes keeps it, no plans the run's value; undecided keeps it and asks again. */
  retainUserEdit: RetainUserEdit;
}

export type RetainUserEdit = "yes" | "no" | "undecided";

export type LegRole = "base" | "quote" | "fee";

export interface AppliedEdit {
  legId: string;
  field: string;
  value: Value;
  /** A price edit: the local price Summ showed after it, which says whether the edit still stands; null unconfirmed. */
  after?: number | null;
  /** A price edit's line written before the call, so each edit has exactly one. */
  intent?: boolean;
}

export function readAdopted(stateDir: string): Map<string, string> {
  const file = join(stateDir, "adopted.csv");
  const adopted = new Map<string, string>();
  if (!existsSync(file)) return adopted;
  const [header, ...lines] = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (header !== "Leg,ID") throw new Error(`${file}: expected the header "Leg,ID"`);
  for (const line of lines) {
    const [legId, id] = line.split(",");
    adopted.set(legId, id);
  }
  return adopted;
}

export function writeAdopted(stateDir: string, adopted: Map<string, string>): void {
  const lines = [...adopted].sort(([a], [b]) => a.localeCompare(b)).map(([legId, id]) => `${legId},${id}`);
  writeFileSync(join(stateDir, "adopted.csv"), ["Leg,ID", ...lines].join("\n") + "\n");
}

export function readOverrides(stateDir: string): Override[] {
  const file = join(stateDir, "overrides.json");
  if (!existsSync(file)) return [];
  const overrides: Override[] = JSON.parse(readFileSync(file, "utf8"));
  // An entry from before retainUserEdit existed is undecided
  return overrides.map((o) => {
    const retainUserEdit = o.retainUserEdit ?? "undecided";
    if (!["yes", "no", "undecided"].includes(retainUserEdit)) {
      throw new Error(`${file}: retainUserEdit of ${o.id} ${o.field} must be "yes", "no" or "undecided"`);
    }
    return { ...o, retainUserEdit };
  });
}

export function writeOverrides(stateDir: string, overrides: Override[]): void {
  writeFileSync(join(stateDir, "overrides.json"), JSON.stringify(overrides, null, 2) + "\n");
}

export function readApplyLog(stateDir: string): AppliedEdit[] {
  const file = join(stateDir, "apply-log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => typeof e.legId === "string" && typeof e.field === "string");
}

/**
 * Adds a plan's adopted legs and captured overrides to the state dir's tables as they are now, so an edit made
 * by hand since the plan (an override deleted, a reason filled in) is kept. Returns the tables it changed.
 */
export function mergeTables(
  stateDir: string,
  adoptedNow: { legId: string; id: string }[],
  captured: Override[],
): string[] {
  const changed: string[] = [];
  const adopted = readAdopted(stateDir);
  const newLegs = adoptedNow.filter((a) => adopted.get(a.legId) !== a.id);
  if (newLegs.length) {
    for (const a of newLegs) adopted.set(a.legId, a.id);
    writeAdopted(stateDir, adopted);
    changed.push("adopted.csv");
  }
  // A capture replaces the override of its field when the user has set another value since, keeping its reason:
  // the decision was on the old value, so the new one is undecided
  let overrides = readOverrides(stateDir);
  let overridesChanged = false;
  for (const c of captured) {
    const old = overrides.find((o) => o.id === c.id && o.leg === c.leg && o.field === c.field);
    if (old && String(old.summ) === String(c.summ)) continue;
    overrides = [...overrides.filter((o) => o !== old), old ? { ...c, reason: old.reason } : c];
    overridesChanged = true;
  }
  if (overridesChanged) {
    writeOverrides(stateDir, overrides);
    changed.push("overrides.json");
  }
  return changed;
}
