// prune: removes snapshot files older than `days` (never the latest), and action store files that no remaining
// snapshot lists and no delete in apply-log.jsonl saved, but only files git holds as committed (spec:
// docs/specs/summ-sync.md, State dir).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readSnapshotFile, snapshotNames } from "./snapshot.ts";

function git(stateDir: string, args: string[]): string[] {
  try {
    return execFileSync("git", ["-C", stateDir, ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\0")
      .filter(Boolean);
  } catch (e) {
    throw new Error(
      `prune needs the state dir in a git repo with at least one commit (git: ${String((e as { stderr?: string }).stderr ?? e).trim()})`,
    );
  }
}

/** The actions apply saved before deleting them: kept, as the record of what Summ held. */
function savedByApply(stateDir: string): Set<string> {
  const file = join(stateDir, "apply-log.jsonl");
  if (!existsSync(file)) return new Set();
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return new Set(
    lines.filter((l) => l.operation === "delete" && Array.isArray(l.actionIds)).flatMap((l) => l.actionIds as string[]),
  );
}

export interface PruneResult {
  removed: string[];
  /** Files that would be removed but are not committed: nothing is removed while there are any. */
  uncommitted: string[];
}

/** A snapshot's time, from its name (`2024-01-02T03-04-05`, UTC). */
export const snapshotTime = (name: string): number =>
  Date.parse(`${name.replace(/T(\d\d)-(\d\d)-(\d\d)$/, "T$1:$2:$3")}Z`);

export function prune(stateDir: string, days = 30, now = Date.now()): PruneResult {
  if (!(days >= 0)) throw new Error("--older-than must be a number of days");
  const names = snapshotNames(stateDir);
  if (names.length === 0) throw new Error(`No snapshot in ${join(stateDir, "snapshots")}: nothing to prune against`);
  const cutoff = now - days * 86_400_000;
  const old = names.slice(0, -1).filter((n) => snapshotTime(n) < cutoff);
  const kept = names.filter((n) => !old.includes(n));
  const listed = new Set(savedByApply(stateDir));
  for (const id of kept.flatMap((n) =>
    readSnapshotFile(join(stateDir, "snapshots", `${n}.json`)).actions.map((a) => a.id),
  ))
    listed.add(id);
  const actionsDir = join(stateDir, "actions");
  const candidates = [
    ...old.flatMap((n) => [
      `snapshots/${n}.json`,
      ...(existsSync(join(stateDir, "snapshots", `${n}.details.jsonl`)) ? [`snapshots/${n}.details.jsonl`] : []),
    ]),
    ...(existsSync(actionsDir) ? readdirSync(actionsDir) : [])
      .filter((f) => f.endsWith(".json") && !listed.has(f.replace(/\.json$/, "")))
      .map((f) => `actions/${f}`),
  ];
  if (candidates.length === 0) return { removed: [], uncommitted: [] };

  // Paths relative to the state dir: committed in HEAD, and unchanged since (staged or not)
  const committed = new Set(
    git(stateDir, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "snapshots", "actions"]),
  );
  const changed = new Set(
    git(stateDir, ["diff", "-z", "--name-only", "--relative", "HEAD", "--", "snapshots", "actions"]),
  );
  const uncommitted = candidates.filter((f) => !committed.has(f) || changed.has(f));
  if (uncommitted.length) return { removed: [], uncommitted };
  for (const f of candidates) unlinkSync(join(stateDir, f));
  return { removed: candidates, uncommitted: [] };
}

export function runPrune(stateDir: string, days?: number): void {
  const { removed, uncommitted } = prune(stateDir, days);
  if (uncommitted.length) {
    console.log(`Removed nothing: ${uncommitted.length} files to prune are not committed (commit them first):`);
    for (const f of uncommitted.slice(0, 20)) console.log(`  ${f}`);
    if (uncommitted.length > 20) console.log(`  ... and ${uncommitted.length - 20} more`);
    process.exitCode = 1;
    return;
  }
  const snapshots = removed.filter((f) => f.startsWith("snapshots/")).length;
  console.log(
    `Removed ${snapshots} snapshots and ${removed.length - snapshots} stored actions (git keeps them; commit the removal)`,
  );
}
