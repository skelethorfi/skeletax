// What changed in Summ between two pulls of the same scope (spec: Changes on pull). verify's comparison of two snapshots
// with an empty plan: summ-sync's own writes between the pulls (the apply log) explain the fields and legs they name, and
// what is left is Summ's (some of it in answer to those writes, marked where it can tell), or a write in Summ's app.

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LogLine, PlanFile } from "./apply.ts";
import { isWriteLine, readLogLines } from "./journal.ts";
import {
  type Leg,
  readSnapshot,
  readSnapshotFile,
  type Snapshot,
  type SnapshotFile,
  snapshotNames,
} from "./snapshot.ts";
import { type Verification, verifyPlan } from "./verify.ts";

/** A leg of an upload: our rows, which Summ does not make. */
const UPLOADED = "manual-csv";

/**
 * What two pulls must share to be compared, as verify requires: the same run, range and managed sources and chains, so
 * both read the same actions' details. Another run reads others, whose legs would read as gone or added.
 */
const SCOPE = ["run", "range", "managedSources", "managedChains"] as const;
const scopeValue = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : (v ?? null));

export const changesFile = (snapshotFile: string): string => snapshotFile.replace(/\.json$/, ".changes.md");

/** The latest earlier snapshot of the same scope that began before this one, or null. */
export function previousSnapshot(stateDir: string, name: string): string | null {
  const file = (n: string) => join(stateDir, "snapshots", `${n}.json`);
  const current = readSnapshotFile(file(name));
  const earlier = snapshotNames(stateDir).filter((n) => n < name);
  for (const n of earlier.reverse()) {
    const other = readSnapshotFile(file(n));
    if (
      other.version === 2 &&
      other.takenAt < current.takenAt &&
      SCOPE.every((k) => scopeValue(other[k]) === scopeValue(current[k]))
    )
      return n;
  }
  return null;
}

export interface Changes {
  before: string | null;
  /** summ-sync's write calls between the pulls (their result or error lines), which explain the fields and legs they name. */
  writes: number;
  verification: Verification | null;
  /** New legs of our uploads, apart from the legs Summ added. */
  uploaded: Leg[];
  /** Legs whose pairing changed with a new leg of our uploads in their action: an upload, not in the log, paired them. */
  besideUpload: string[];
  /** A first pull: the actions sharing a tx hash with legs created over a day apart (a later import may have added a tx again). */
  sharedTx: string[];
}

const EMPTY_PLAN = { delete: [], edit: [], upload: [], categorise: [] } as unknown as PlanFile;

/** The changes between two read snapshots, apart from summ-sync's writes in `lines` (the apply log between them). */
export function compareSnapshots(
  before: Snapshot,
  beforeFile: SnapshotFile,
  after: Snapshot,
  afterFile: SnapshotFile,
  lines: LogLine[],
): Omit<Changes, "before" | "sharedTx"> {
  const v = verifyPlan({ plan: EMPTY_PLAN, planName: "", before, beforeFile, after, afterFile, lines });
  const uploaded = v.added.filter((l) => l.importType === UPLOADED);
  const verification = { ...v, added: v.added.filter((l) => l.importType !== UPLOADED) };
  // One call's lines: intents, a line per change, and its result (or its error); the result or error counts it
  const writes = lines.filter((l) => isWriteLine(l) && ("result" in l || "error" in l)).length;
  const uploadActions = new Set(uploaded.map((l) => l.actionId));
  const besideUpload = verification.pairing.filter((p) => uploadActions.has(p.leg.actionId)).map((p) => p.leg.legId);
  return { writes, verification, uploaded, besideUpload };
}

/** Compares the snapshot with the previous one of its scope; with none, lists the actions sharing a tx hash. */
export function snapshotChanges(stateDir: string, name: string, sharedTx: string[]): Changes {
  const before = previousSnapshot(stateDir, name);
  if (!before) return { before, writes: 0, verification: null, uploaded: [], besideUpload: [], sharedTx };
  const file = (n: string) => join(stateDir, "snapshots", `${n}.json`);
  const [beforeFile, afterFile] = [readSnapshotFile(file(before)), readSnapshotFile(file(name))];
  const lines = readLogLines<LogLine>(stateDir).filter(
    (l) => l.time >= beforeFile.takenAt && l.time <= (afterFile.finishedAt as string),
  );
  const changes = compareSnapshots(readSnapshot(file(before)), beforeFile, readSnapshot(file(name)), afterFile, lines);
  return { before, ...changes, sharedTx: [] };
}

const legLine = (l: Leg) =>
  `${l.timestamp} ${l.quantity} ${l.currency} ${l.trade}, ${l.source}/${l.importType} (leg ${l.legId}, ID ${l.id})`;

/** How many changes, for the pull's last line. */
export function changeCount(c: Changes): number {
  const v = c.verification;
  return v
    ? v.changed.length +
        v.gone.length +
        v.added.length +
        v.pairing.length +
        v.summFeesGone.length +
        v.summFeesAdded.length +
        v.listBefore.length +
        v.listAfter.length
    : c.sharedTx.length;
}

export function changesMarkdown(c: Changes, name: string): string {
  const out = [`# Changes in Summ up to ${name}`, ""];
  const section = (title: string, lines: string[]) =>
    out.push(`## ${title}`, "", ...(lines.length ? lines : ["None."]), "");
  const v = c.verification;
  if (!v) {
    out.push("- First pull of this run, range and managed sources and chains: nothing earlier to compare with.", "");
    section(
      "Actions sharing a tx hash, their legs created over a day apart (a later import may have added a tx again; plan decides)",
      c.sharedTx.map((id) => `- action ${id}`),
    );
    return out.join("\n");
  }
  out.push(`- Since: ${c.before}`);
  out.push(
    `- summ-sync's own writes between the pulls (apply log): ${c.writes}; the fields and legs they name are left out. What Summ did in answer (a leg beside a written one re-paired or re-typed, its fee legs) still shows, marked where it can tell. A write in Summ's app is not in the log and shows here.`,
    "",
  );
  section(
    "Fields changed",
    v.changed.map(
      (x) =>
        `- ${x.field}: ${String(x.before)} to ${String(x.after)}, on ${legLine(x.leg)}${x.history ? `. Last in Summ: ${x.history}` : ""}`,
    ),
  );
  section(
    "Legs gone",
    v.gone.map((l) => `- ${legLine(l)}`),
  );
  section(
    "Legs Summ added (a re-import, or a leg its matcher made up)",
    v.added.map((l) => `- ${legLine(l)}`),
  );
  section(
    "Pairing changed: a leg's other legs, or its action's category",
    v.pairing.map(
      (p) =>
        `- ${legLine(p.leg)}: action ${p.categoryBefore} to ${p.categoryAfter}, other legs ${p.matesBefore} to ${p.matesAfter}${p.beside ? " (beside a leg summ-sync wrote)" : p.parted ? " (a leg summ-sync wrote left it)" : c.besideUpload.includes(p.leg.legId) ? " (beside a new leg of our uploads)" : ""}`,
    ),
  );
  section("Summ's own fee legs", [
    ...(v.summFeesReissued ? [`${v.summFeesReissued} issued again under new ids, with the same values.`] : []),
    ...v.summFeesGone.map((l) => `- Gone: ${legLine(l)}`),
    ...v.summFeesAdded.map((l) => `- New: ${legLine(l)}`),
  ]);
  section(
    "New legs of our uploads (manual CSV)",
    c.uploaded.map((l) => `- ${legLine(l)}`),
  );
  section("Not read by one of the pulls: gone or moved, these snapshots cannot say", [
    ...v.notRead.map((l) => `- Left the details: ${legLine(l)}`),
    ...v.newlyRead.map((l) => `- Entered the details: ${legLine(l)}`),
  ]);
  section("Listed actions with no detail: by tx hash, category and tags, no values", [
    ...v.listBefore.map((k) => `- Before only: ${k}`),
    ...v.listAfter.map((k) => `- After only: ${k}`),
  ]);
  return out.join("\n");
}

/** Writes `<snapshot>.changes.md` next to the snapshot and returns a line for the pull's output. */
export function writeChanges(stateDir: string, snapshotFile: string, sharedTx: string[]): string {
  const name = basename(snapshotFile, ".json");
  const changes = snapshotChanges(stateDir, name, sharedTx);
  const out = changesFile(snapshotFile);
  writeFileSync(out, changesMarkdown(changes, name));
  const n = changeCount(changes);
  const notRead = (changes.verification?.notRead.length ?? 0) + (changes.verification?.newlyRead.length ?? 0);
  return changes.before
    ? `Changes in Summ since ${changes.before}: ${n}; new legs of our uploads: ${changes.uploaded.length}; legs not read by one of the pulls: ${notRead}; ${out}`
    : `First pull of this scope: ${n} actions share a tx hash with legs created over a day apart; ${out}`;
}
