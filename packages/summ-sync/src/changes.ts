// What changed in Summ between two pulls of the same scope (spec: Changes on pull). verify's comparison of two snapshots
// with an empty plan: summ-sync's own writes between the pulls (the apply log) explain their changes, and what is left
// is Summ's, or a write in Summ's app.

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
 * What two pulls must share to be compared: the same range and managed sources and chains. Another run only adds the
 * details of its categorised rows' txs; a leg that enters or leaves the details so is listed as not read.
 */
const SCOPE = ["range", "managedSources", "managedChains"] as const;

export const changesFile = (snapshotFile: string): string => snapshotFile.replace(/\.json$/, ".changes.md");

/** The latest earlier snapshot of the same scope, or null. */
export function previousSnapshot(stateDir: string, name: string): string | null {
  const file = (n: string) => join(stateDir, "snapshots", `${n}.json`);
  const current = readSnapshotFile(file(name));
  const earlier = snapshotNames(stateDir).filter((n) => n < name);
  for (const n of earlier.reverse()) {
    const other = readSnapshotFile(file(n));
    if (other.version === 2 && SCOPE.every((k) => JSON.stringify(other[k]) === JSON.stringify(current[k]))) return n;
  }
  return null;
}

export interface Changes {
  before: string | null;
  /** summ-sync's write lines between the pulls, which explain their own changes. */
  writes: number;
  verification: Verification | null;
  /** New legs of our uploads, apart from the legs Summ added. */
  uploaded: Leg[];
  /** A first pull: the actions sharing a tx hash across imports (a later import may have added a tx again). */
  heldTwice: string[];
}

const EMPTY_PLAN = { delete: [], edit: [], upload: [], categorise: [] } as unknown as PlanFile;

/** The changes between two read snapshots, apart from summ-sync's writes in `lines` (the apply log between them). */
export function compareSnapshots(
  before: Snapshot,
  beforeFile: SnapshotFile,
  after: Snapshot,
  afterFile: SnapshotFile,
  lines: LogLine[],
): Omit<Changes, "before" | "heldTwice"> {
  const verification = verifyPlan({ plan: EMPTY_PLAN, planName: "", before, beforeFile, after, afterFile, lines });
  const uploaded = verification.added.filter((l) => l.importType === UPLOADED);
  verification.added = verification.added.filter((l) => l.importType !== UPLOADED);
  return { writes: lines.filter(isWriteLine).length, verification, uploaded };
}

/** Compares the snapshot with the previous one of its scope; with none, lists what is held more than once. */
export function snapshotChanges(stateDir: string, name: string, heldTwice: string[]): Changes {
  const before = previousSnapshot(stateDir, name);
  if (!before) return { before, writes: 0, verification: null, uploaded: [], heldTwice };
  const file = (n: string) => join(stateDir, "snapshots", `${n}.json`);
  const [beforeFile, afterFile] = [readSnapshotFile(file(before)), readSnapshotFile(file(name))];
  const lines = readLogLines<LogLine>(stateDir).filter(
    (l) => l.time >= beforeFile.takenAt && l.time <= (afterFile.finishedAt as string),
  );
  const changes = compareSnapshots(readSnapshot(file(before)), beforeFile, readSnapshot(file(name)), afterFile, lines);
  return { before, ...changes, heldTwice: [] };
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
    : c.heldTwice.length;
}

export function changesMarkdown(c: Changes, name: string): string {
  const out = [`# Changes in Summ up to ${name}`, ""];
  const section = (title: string, lines: string[]) =>
    out.push(`## ${title}`, "", ...(lines.length ? lines : ["None."]), "");
  const v = c.verification;
  if (!v) {
    out.push("- First pull of this range and managed sources and chains: nothing earlier to compare with.", "");
    section(
      "Actions sharing a tx hash across imports (a later import may have added a tx again; plan decides)",
      c.heldTwice.map((id) => `- action ${id}`),
    );
    return out.join("\n");
  }
  out.push(`- Since: ${c.before}`);
  out.push(
    `- summ-sync's own writes between the pulls (apply log): ${c.writes}; their changes are left out. A write in Summ's app is not in the log and shows here.`,
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
        `- ${legLine(p.leg)}: action ${p.categoryBefore} to ${p.categoryAfter}, other legs ${p.matesBefore} to ${p.matesAfter}`,
    ),
  );
  section("Summ's own fee legs", [
    ...(v.summFeesReissued ? [`${v.summFeesReissued} issued again under new ids, with the same values.`] : []),
    ...v.summFeesGone.map((l) => `- Gone: ${legLine(l)}`),
    ...v.summFeesAdded.map((l) => `- New: ${legLine(l)}`),
  ]);
  section(
    "Uploaded rows (ours)",
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
export function writeChanges(stateDir: string, snapshotFile: string, heldTwice: string[]): string {
  const name = basename(snapshotFile, ".json");
  const changes = snapshotChanges(stateDir, name, heldTwice);
  const out = changesFile(snapshotFile);
  writeFileSync(out, changesMarkdown(changes, name));
  const n = changeCount(changes);
  return changes.before
    ? `Changes since ${changes.before}: ${n}${n ? "" : " (nothing moved in Summ apart from summ-sync's writes)"}; ${out}`
    : `First pull of this scope: ${n} actions share a tx hash across imports; ${out}`;
}
