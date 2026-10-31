// apply: carries out a reviewed plan through Summ's MCP (spec: docs/specs/summ-sync.md, Apply). It can always go on from
// where it stopped, and stops rather than guesses.
//
//   1. take <state dir>/.lock, and refuse a plan that is not safe to start or to go on with (startState)
//   2. every entry, on every run, is classified by a fresh read of its legs (inspect by transactionId):
//      before-values: proceed; after-values: done (`via: found`); anything else: stop and report
//   3. deletes (--approve-deletes), each a state machine (applyDelete): a leg sharing its action is split off by an
//      ignore edit; an action holding only the entry's legs is deleted after two reads agree. Summ's delete has no
//      undo: its pre-image also holds the row's CSV line when one can be found
//   4. edits and categorisation; then the receive Summ made up to pair a categorised send as a transfer is ignored,
//      once it is alone. Categorisation waits while the plan has uploads: Summ pairs a categorised leg with the
//      uploaded other side of the swap only when that side is already there
//   5. each write: read fresh, save that as a pre-image (<plan dir>/pre/<entry>.<step>.json), log an intent, call, log
//      the result and undo handle in <state dir>/apply-log.jsonl (journal.ts), check the result's count, read the
//      write back by the ids the result names. A write that fails or disagrees stops the run, and is never retried in
//      it: the next run classifies the leg
//   6. only when every entry is done: the legs the plan adopted and the overrides it captured are added to adopted.csv
//      and overrides.json, and the upload files are listed
//
// Filed-year entries are applied only with --approve-filed, and then only they: a separate apply.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type ActionDetail, parseDetail } from "./parse.ts";
import { type Change, type DeleteEntry, type EditEntry, type Plan, same } from "./plan.ts";
import {
  appendLogLine,
  isWriteLine,
  logPath,
  type PreImage,
  readLogLines,
  releaseLock,
  repairLog,
  type RowLine,
  rowLines,
  takeLock,
  writePreImage,
} from "./journal.ts";
import { type Leg, latestSnapshot, legsOf, readSnapshot, readSnapshotFile } from "./snapshot.ts";
import { mergeTables } from "./state.ts";

export const WRITE_TOOLS = ["edit_transaction", "bulk_edit_transactions"];

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface ApplyOptions {
  approveDeletes: boolean;
  approveFiled: boolean;
  /** Look everything up and check it, but write nothing to Summ and nothing to the log. */
  dryRun: boolean;
}

export type PlanFile = Plan & { snapshot: string; run: string };

export interface LogLine {
  time: string;
  plan: string;
  call: string;
  [key: string]: unknown;
}

type NewLine = Omit<LogLine, "time" | "plan">;

/** Where an apply keeps its journal. */
export interface ApplyDirs {
  stateDir: string;
  planDir: string;
}

export interface ApplyResult {
  deleted: number;
  /** Edits that split a leg to delete off an action whose other legs stay. */
  split: number;
  edited: number;
  /** Entries found already done: by an earlier run, or by hand. */
  found: number;
  /** Categorisations held back until the plan's uploads are in Summ. */
  heldBack: number;
  /** What a dry run would stop at; in any run, a made-up leg left in place and reported. */
  skipped: { id: string | null; reason: string }[];
  uploads: { file: string; rows: number }[];
  /** A signal stopped it between entries. */
  stopped?: boolean;
  /** The plan had already finished: nothing was done. */
  alreadyComplete?: boolean;
}

export type StopReason = "complete" | "signal" | "conflict" | "bad-result" | "read-back" | "write-failed" | "error";

/** Why a run stopped, with what it found. */
export class ApplyStop extends Error {
  readonly reason: StopReason;
  readonly entry: string | undefined;
  constructor(reason: StopReason, message: string, entry?: string) {
    super(message);
    this.reason = reason;
    this.entry = entry;
  }
}

/** What applyPlan knows besides the plan. */
export interface ApplyContext {
  /** This plan's lines in the log, from earlier runs. */
  prior?: LogLine[];
  /** The legs of the plan's snapshot: what an entry's action-mates are compared with. */
  baseline?: Leg[];
  /** Set by a signal: the run stops before the next entry. */
  signal?: { requested: boolean };
  /** Called before each durable file operation (tests stop the world here). */
  tick?: (what: string) => void;
}

/** The plan's folder, plan.json and that file's hash, given either. */
export function readPlanFile(path: string): { dir: string; plan: PlanFile; sha: string } {
  const file = existsSync(join(path, "plan.json")) ? join(path, "plan.json") : path;
  const text = readFileSync(file);
  return {
    dir: dirname(file),
    plan: JSON.parse(text.toString("utf8")),
    sha: createHash("sha256").update(text).digest("hex"),
  };
}

/** Refuses a plan made from an older snapshot. */
function checkLatest(stateDir: string, plan: PlanFile): string {
  const latest = latestSnapshot(stateDir);
  if (basename(latest, ".json") !== plan.snapshot) {
    throw new Error(
      `The plan is from snapshot ${plan.snapshot}, the latest is ${basename(latest, ".json")}: pull and plan again`,
    );
  }
  return readSnapshotFile(latest).takenAt;
}

/** Refuses a plan made from an older snapshot, or one Summ was written to after the snapshot was taken. */
export function checkFresh(stateDir: string, plan: PlanFile): void {
  const takenAt = checkLatest(stateDir, plan);
  const later = readLogLines<LogLine>(stateDir).filter((l) => l.time > takenAt && isWriteLine(l));
  if (later.length)
    throw new Error(
      `apply-log.jsonl has ${later.length} writes since snapshot ${plan.snapshot} was taken: pull and plan again`,
    );
}

export type Flags = Pick<ApplyOptions, "approveDeletes" | "approveFiled">;

/**
 * Whether this plan may start, or go on. A plan with no apply-start starts only from the latest snapshot with no write
 * since it was taken. One with an apply-start goes on only with the same plan.json, and flags once it has written, from
 * a snapshot still the latest, when every write since it was taken is this plan's own. There is no flag past this: pull and plan.
 */
export function startState(
  stateDir: string,
  plan: PlanFile,
  planName: string,
  sha: string,
  flags: Flags,
): "first" | "resume" | "complete" {
  const lines = readLogLines<LogLine>(stateDir);
  const starts = lines.filter((l) => l.plan === planName && l.call === "apply-start");
  if (!starts.length) {
    checkFresh(stateDir, plan);
    return "first";
  }
  const last = starts[starts.length - 1];
  if (last.planSha !== sha)
    throw new Error(`plan.json of ${planName} changed since its apply began: pull and plan again`);
  // The flags bind once the plan has written: run without its flag, a delete-only plan wrote nothing
  const flagsOf = (run: unknown) => starts.find((l) => l.run === run)?.flags as Flags | undefined;
  const sameFlags = (was: Flags | undefined) =>
    was?.approveDeletes === flags.approveDeletes && was?.approveFiled === flags.approveFiled;
  const wrote = lines.find((l) => l.plan === planName && isWriteLine(l));
  if (wrote && !sameFlags(flagsOf(wrote.run)))
    throw new Error(
      `${planName} was applied with ${JSON.stringify(flagsOf(wrote.run))}, not ${JSON.stringify(flags)}: pull and plan again`,
    );
  const finished = lines.filter((l) => l.plan === planName && l.call === "apply-stop" && l.reason === "complete");
  if (finished.some((l) => sameFlags(flagsOf(l.run)))) return "complete";
  const takenAt = checkLatest(stateDir, plan);
  const runs = new Set(starts.map((l) => l.run));
  const foreign = lines.filter((l) => l.time > takenAt && isWriteLine(l) && !(l.plan === planName && runs.has(l.run)));
  if (foreign.length)
    throw new Error(
      `apply-log.jsonl has ${foreign.length} writes since snapshot ${plan.snapshot} that are not this plan's: pull and plan again`,
    );
  return "resume";
}

/** The plan's entries this apply carries out: the current year's, or with approveFiled only the filed years'. */
export function selected<T extends { filed: boolean }>(entries: T[], opts: ApplyOptions): T[] {
  return entries.filter((e) => e.filed === opts.approveFiled);
}

/** The bulk edit id (undo handle) in an edit's result text, if it has one. */
export function undoHandle(text: string): string | null {
  return text.match(/Bulk Edit ID\W*([A-Za-z0-9_-]{8,})/i)?.[1] ?? null;
}

type Found = { actionId: string; legs: Leg[]; detail: ActionDetail };

// How Summ's tool answers a transaction id it does not hold, for this very id. Any other failure, a gateway's 404 too,
// is a failed read, which says nothing of the leg
const isAbsent = (message: string, legId: string) =>
  message.startsWith(`inspect_transaction: Transaction '${legId}' was not found`);

/** The action that holds a leg now (an action id can change on any write) and its legs; null when Summ has no such leg. */
async function lookUp(client: ToolCaller, legId: string): Promise<Found | null> {
  let text: string;
  try {
    text = await client.callTool("inspect_transaction", { transactionId: legId });
  } catch (e) {
    if (isAbsent((e as Error).message, legId)) return null;
    throw e;
  }
  const detail = parseDetail(text);
  const legs = legsOf(detail);
  if (!legs.some((l) => l.legId === legId))
    throw new ApplyStop(
      "bad-result",
      `Summ answered for leg ${legId} with action ${detail.action._id}, which lacks it`,
    );
  return { actionId: detail.action._id, legs, detail };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The rebuilt actions an edit's result names (one line, ids after the colon). */
export function affectedActions(text: string): string[] {
  const ids = text.match(/Affected Action IDs[^\n:]*:\**\s*([^\n]+)/i)?.[1] ?? "";
  return ids.split(/[\s,]+/).filter(Boolean);
}

const PATCHED = /Patched (\d+) transaction leg/i;
const REMOVED = /Bulk delete removed (\d+) transaction leg/i;
const IGNORED = /Bulk ignore updated (\d+) action/i;

/** What is wrong with a write's result: Summ reports a wrong id as a success that changed nothing. */
function countProblem(text: string, pattern: RegExp, expected: number): string | null {
  const count = text.match(pattern)?.[1];
  if (count === undefined) return `the result reports no count: ${JSON.stringify(text.slice(0, 200))}`;
  return Number(count) === expected ? null : `the result reports ${count}, expected ${expected}`;
}

const isIgnored = (l: Leg) => l.trade === "ignoreIn" || l.trade === "ignoreOut";
const WAITS = 5;
const READ_BACKS = 3;
// What an action-mate must still hold. Not updatedAt, which rebuilds move
const MATE_FIELDS = ["trade", "currency", "quantity", "timestamp", "from", "to", "blockchain", "price"] as const;

export async function applyPlan(
  client: ToolCaller,
  plan: PlanFile,
  opts: ApplyOptions,
  log: (line: NewLine) => void,
  say: (text: string) => void = console.log,
  /** Summ rebuilds actions and refreshes its search a few seconds after a write. */
  settleMs = 3000,
  dirs: ApplyDirs | null = null,
  context: ApplyContext = {},
): Promise<ApplyResult> {
  const edited = new Set<string>();
  const result: ApplyResult = { deleted: 0, split: 0, edited: 0, found: 0, heldBack: 0, skipped: [], uploads: [] };
  // This plan's lines, earlier runs' and this run's: what classifying a leg asks of the log
  const journal: NewLine[] = [...(context.prior ?? [])];
  const write = opts.dryRun
    ? null
    : (line: NewLine) => {
        log(line);
        journal.push(line);
      };

  /** Stops the run; a dry run reports it and goes on to the next entry. */
  const conflict = (entry: string, id: string | null, reason: string): void => {
    if (!opts.dryRun) throw new ApplyStop("conflict", `${entry} (${id ?? "no row"}): ${reason}`, entry);
    result.skipped.push({ id, reason });
    say(`  would stop at ${id ?? "(no row)"}: ${reason}`);
  };

  const found = (entry: string, id: string | null, extra: Record<string, unknown> = {}): void => {
    result.found++;
    say(`  ${entry} (${id ?? "no row"}) is already done`);
    write?.({ call: "found", via: "found", entry, id, ...extra });
  };

  /** Saves what was just read, before the intent line and the write; returns the file as the log names it. */
  const savePre = (
    entry: string,
    step: string,
    id: string | null,
    actions: ActionDetail[],
    line?: RowLine | null,
  ): string => {
    if (!dirs) throw new Error("apply needs the state and plan dirs to save the state before a write");
    const image: PreImage = {
      plan: basename(dirs.planDir),
      entry,
      step,
      id,
      capturedAt: new Date().toISOString(),
      actions,
      ...(line === undefined
        ? {}
        : { line: line?.line ?? null, lineHeader: line?.lineHeader ?? null, lineSource: line?.lineSource ?? null }),
    };
    context.tick?.("pre-image");
    return logPath(dirs.stateDir, writePreImage(dirs.planDir, image));
  };

  /** A write. If it throws it may still have landed, so the failure gets a result line; it carries no legId or field,
   * so it never reads back as an edit. Never retried: the next run classifies the leg. */
  const callWrite = async (
    log: (line: NewLine) => void,
    entry: string,
    tool: string,
    args: Record<string, unknown>,
    tag: Record<string, unknown>,
  ): Promise<string> => {
    try {
      return await client.callTool(tool, args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log({ call: tool, ...tag, error: message });
      throw new ApplyStop("write-failed", `${entry}: ${message}`, entry);
    }
  };

  /** The legs as the actions a result names show them, once they agree (Summ settles a few seconds after a write). */
  async function readBack(
    text: string,
    legIds: string[],
    agrees: (l: Leg) => boolean,
  ): Promise<Map<string, Leg> | null> {
    for (let i = 0; i < READ_BACKS; i++) {
      if (i) await sleep(settleMs);
      const seen = new Map<string, Leg>();
      for (const actionId of affectedActions(text)) {
        const legs = await client
          .callTool("inspect_transaction", { actionId })
          .then((t) => legsOf(parseDetail(t)))
          .catch(() => []);
        for (const l of legs) if (legIds.includes(l.legId)) seen.set(l.legId, l);
      }
      if (legIds.every((id) => seen.has(id) && agrees(seen.get(id) as Leg))) return seen;
    }
    return null;
  }

  // Read when the first delete needs them
  let lines: Map<string, RowLine> | null = null;
  const lineOf = (entry: DeleteEntry): RowLine | null => {
    if (!dirs) return null;
    lines ??= rowLines(plan.run, dirs.planDir);
    return lines.get(entry.summId) ?? (entry.id === null ? undefined : lines.get(entry.id)) ?? null;
  };

  const deletes = selected(plan.delete, opts);
  const uploads = selected(plan.upload, opts);
  const categorise = selected(plan.categorise, opts);
  const edits = [
    ...selected(plan.edit, opts).map((e) => ["edit", e] as const),
    ...(uploads.length ? [] : categorise).map((e) => ["categorise", e] as const),
  ];

  const stopping = () => {
    if (!context.signal?.requested) return false;
    result.stopped = true;
    return true;
  };

  // ---- Deletes
  async function lookUpAll(legIds: string[]): Promise<(Found | null)[]> {
    const reads: (Found | null)[] = [];
    for (const legId of legIds) reads.push(await lookUp(client, legId));
    return reads;
  }

  /**
   * Read every leg, then by what that shows: all gone: done if a delete was logged, else stop. Sharing an action: split
   * it off (edited alone to an ignore type, undoable, which Summ moves to an action of its own; never a delete by
   * filter). Already ignored and sharing: wait if the split was logged, else stop. Alone: two reads must agree, then delete.
   */
  async function applyDelete(entry: DeleteEntry) {
    const key = `delete-${plan.delete.indexOf(entry)}`;
    const mine = () => journal.filter((l) => l.entry === key);
    const splitLogged = (legId: string) => mine().some((l) => l.kind === "split" && l.legId === legId);
    // Summ's made-up other side of a transfer would be left alone once the leg is gone: ignored after the delete.
    // On the split's lines, as after the delete nothing else names it
    const madeUp = () => [...new Set(mine().flatMap((l) => (l.madeUp as string[] | undefined) ?? []))];
    const splitThisRun = new Set<string>();
    let waits = 0;
    let splits = 0;
    let agreed: string | null = null;
    // A signal lets an entry finish what it began, but begins nothing permanent
    const holdForSignal = () => !splitThisRun.size && stopping();
    const pause = async (): Promise<void> => {
      waits++;
      await sleep(settleMs);
    };

    for (;;) {
      const reads = await lookUpAll(entry.legIds);
      const absent = entry.legIds.filter((_, i) => !reads[i]);
      if (absent.length === entry.legIds.length) {
        if (!mine().some((l) => l.operation === "delete"))
          return conflict(
            key,
            entry.id,
            `leg ${absent.join(", ")} is no longer in Summ, and this plan did not delete it`,
          );
        found(key, entry.id, { legIds: entry.legIds });
        break;
      }
      if (absent.length)
        return conflict(key, entry.id, `leg ${absent.join(", ")} is no longer in Summ, the others are`);

      const actions = new Map((reads as Found[]).map((f) => [f.actionId, f]));
      const shared = [...actions.values()].filter((f) => f.legs.some((l) => !entry.legIds.includes(l.legId)));
      const ownLegs = (f: Found) => f.legs.filter((l) => entry.legIds.includes(l.legId));
      if (shared.length) {
        agreed = null;
        const foreign = shared.flatMap(ownLegs).filter((l) => isIgnored(l) && !splitLogged(l.legId));
        if (foreign.length)
          return conflict(
            key,
            entry.id,
            `leg ${foreign[0].legId} is already ignored, by no write of this plan, and still shares its action with other legs`,
          );
        const next = shared.find((f) => ownLegs(f).some((l) => !isIgnored(l)));
        if (!next) {
          if (waits >= WAITS) {
            const others = shared.flatMap((f) => f.legs).filter((l) => !entry.legIds.includes(l.legId)).length;
            const undos = mine().flatMap((l) => (l.undo ? [String(l.undo)] : []));
            return conflict(
              key,
              entry.id,
              `Summ did not split the legs off (still with ${others} other legs); left ignored, undo ${[...new Set(undos)].join(", ")}`,
            );
          }
          if (opts.dryRun)
            return say(`  would wait for Summ to split ${entry.summId} off its other legs, then delete it`);
          await pause();
          continue;
        }
        if (!write)
          return say(
            `  would split ${entry.legIds.length} legs of ${entry.summId} off their actions, then delete them`,
          );
        if (holdForSignal()) return;
        const legs = ownLegs(next).filter((l) => !isIgnored(l));
        const repeat = legs.find((l) => splitThisRun.has(l.legId));
        if (repeat) return conflict(key, entry.id, `leg ${repeat.legId} is not ignored after its split was read back`);
        await split(key, entry, next, legs, splits++);
        for (const l of legs) splitThisRun.add(l.legId);
        waits = 0;
        await sleep(settleMs);
        continue;
      }

      if (!write) return say(`  would delete ${entry.legIds.length} legs of ${entry.summId}`);
      // Alone, and by two reads: an action just split off can still be settling
      const seen = JSON.stringify(
        [...actions.values()].map((f) => [f.actionId, f.legs.map((l) => l.legId).sort()]).sort(),
      );
      if (seen !== agreed) {
        if (waits >= WAITS) return conflict(key, entry.id, "Summ keeps changing the action holding these legs");
        agreed = seen;
        await pause();
        continue;
      }
      if (holdForSignal()) return;
      await remove(key, entry, actions);
      break;
    }
    for (const [n, legId] of madeUp().entries()) await ignoreMadeUp(key, `ignore-${n}`, entry.id, legId, true);
  }

  async function split(key: string, entry: DeleteEntry, f: Found, legs: Leg[], n: number) {
    if (!write) return;
    const edits = legs.map((l) => ({
      transactionId: l.legId,
      updates: { trade: l.side === "incoming" ? "ignoreIn" : "ignoreOut" },
    }));
    const soft = f.legs.filter((l) => l.importType === "soft-transfer" && !entry.legIds.includes(l.legId));
    const tag = {
      kind: "split",
      entry: key,
      pre: savePre(key, `split-${n}`, entry.id, [f.detail]),
      id: entry.id,
      actionId: f.actionId,
      ...(soft.length ? { madeUp: soft.map((l) => l.legId) } : {}),
    };
    const line = (l: Leg, i: number) => ({
      call: "edit_transaction",
      ...tag,
      legId: l.legId,
      field: "trade",
      from: l.trade,
      value: edits[i].updates.trade,
    });
    for (const [i, l] of legs.entries()) write({ ...line(l, i), intent: true });
    const text = await callWrite(write, key, "edit_transaction", { actionId: f.actionId, edits }, tag);
    result.split++;
    const undo = undoHandle(text);
    for (const [i, l] of legs.entries()) write({ ...line(l, i), undo });
    write({ call: "edit_transaction", ...tag, undo, result: text });
    checkResult(key, text, PATCHED, legs.length, true);
    const ids = legs.map((l) => l.legId);
    if (!(await readBack(text, ids, isIgnored)))
      throw new ApplyStop(
        "read-back",
        `${key}: the actions the split names do not show ${ids.join(", ")} ignored`,
        key,
      );
  }

  async function remove(key: string, entry: DeleteEntry, actions: Map<string, Found>) {
    if (!write) return;
    // By the actions just inspected, which hold only the entry's legs: never by a filter
    const args = { actionIds: [...actions.keys()], operation: { type: "delete" } };
    const tag = {
      operation: "delete",
      entry: key,
      pre: savePre(
        key,
        "delete",
        entry.id,
        [...actions.values()].map((f) => f.detail),
        lineOf(entry),
      ),
      id: entry.id,
      summId: entry.summId,
      legIds: entry.legIds,
      actionIds: [...actions.keys()],
    };
    write({ call: "bulk_edit_transactions", ...tag, intent: true });
    const text = await callWrite(write, key, "bulk_edit_transactions", args, tag);
    result.deleted++;
    write({ call: "bulk_edit_transactions", ...tag, result: text });
    checkResult(key, text, REMOVED, entry.legIds.length, false);
    for (let i = 0; ; i++) {
      const left = (await lookUpAll(entry.legIds)).filter(Boolean);
      if (!left.length) return;
      if (i + 1 >= READ_BACKS)
        throw new ApplyStop(
          "read-back",
          `${key}: Summ reported the delete, and still holds ${left.length} of its legs`,
          key,
        );
      await sleep(settleMs);
    }
  }

  function checkResult(key: string, text: string, pattern: RegExp, expected: number, namesActions: boolean) {
    const problem =
      countProblem(text, pattern, expected) ??
      (namesActions && !affectedActions(text).length ? "the result names no affected action" : null);
    if (problem) throw new ApplyStop("bad-result", `${key}: ${problem}`, key);
  }

  // ---- Edits, then categorisation: the same call on a managed row's legs or on Summ's own leg
  async function applyEdit(kind: "edit" | "categorise", entry: EditEntry) {
    const key = `${kind}-${plan[kind].indexOf(entry)}`;
    if (entry.changes.length && !(await editLegs(kind, key, entry))) return;
    for (const [n, legId] of (entry.ignore ?? []).entries())
      await ignoreMadeUp(key, `ignore-${n}`, entry.id, legId, entry.changes.length > 0);
  }

  /** Summ's made-up other side of a transfer, once the categorised leg is split off: ignored, by action id. */
  async function ignoreMadeUp(key: string, step: string, id: string | null, legId: string, afterEdit: boolean) {
    if (!write) return say(`  would ignore the made-up leg ${legId} of ${id}`);
    let now: Found | null = null;
    for (let attempt = 0; attempt < WAITS; attempt++) {
      if (afterEdit || attempt > 0) await sleep(settleMs);
      now = await lookUp(client, legId);
      if (!now || now.legs.length === 1 || isIgnored(now.legs.find((l) => l.legId === legId) as Leg)) break;
    }
    if (!now) {
      const ignoring = journal.some(
        (l) => l.entry === key && l.operation === "ignore" && (l.legIds as string[]).includes(legId),
      );
      if (ignoring) return found(key, id, { legIds: [legId] });
      return conflict(key, id, `made-up leg ${legId} is no longer in Summ, and this plan did not ignore it`);
    }
    const leg = now.legs.find((l) => l.legId === legId) as Leg;
    if (isIgnored(leg)) return found(key, id, { legIds: [legId] });
    // Its entry's own write stands, so this blocks nothing: reported here, and by the next plan while it lasts
    if (now.legs.length !== 1) {
      const reason = `made-up leg ${legId} still shares its action with ${now.legs.length - 1} other legs; not ignored`;
      result.skipped.push({ id, reason });
      say(`  skipped ${id ?? "(no row)"}: ${reason}`);
      return write({ call: "skip", entry: key, id, reason });
    }
    if (leg.importType !== "soft-transfer")
      return conflict(key, id, `leg ${legId} is not a made-up leg (${leg.importType})`);
    // No legId or field: as ever, plan does not read an ignore as an edit
    const tag = {
      operation: "ignore",
      entry: key,
      pre: savePre(key, step, id, [now.detail]),
      id,
      legIds: [legId],
      actionIds: [now.actionId],
    };
    write({ call: "bulk_edit_transactions", ...tag, intent: true });
    const text = await callWrite(
      write,
      key,
      "bulk_edit_transactions",
      { actionIds: [now.actionId], operation: { type: "ignore" } },
      tag,
    );
    const undo = undoHandle(text);
    write({ call: "bulk_edit_transactions", ...tag, undo, result: text });
    checkResult(key, text, IGNORED, 1, true);
    if (!(await readBack(text, [legId], isIgnored)))
      throw new ApplyStop("read-back", `${key}: the actions the ignore names do not show ${legId} ignored`, key);
    say(`  ignored the made-up leg of ${id}${undo ? ` (undo ${undo})` : ""}`);
  }

  // The state of one change. `either`: a price whose edit changed nothing and may or may not have landed
  type ChangeState = "before" | "after" | "either" | "other";

  /** The leg as the pre-image of a log line holds it. */
  function preLeg(line: NewLine, legId: string): Leg | undefined {
    if (!dirs || typeof line.pre !== "string") return undefined;
    try {
      const image: PreImage = JSON.parse(readFileSync(join(dirs.stateDir, line.pre), "utf8"));
      return image.actions.flatMap(legsOf).find((l) => l.legId === legId);
    } catch {
      return undefined;
    }
  }

  /**
   * A USD price cannot be read back in USD: only that the local price moved, and how. The local price the sync last
   * confirmed must still stand. Otherwise, away from the before-value it is the sync's only with an intent logged, the
   * USD mark, and updatedAt later than that intent's pre-image; at the before-value, re-sending it is harmless.
   */
  function priceState(c: Change, leg: Leg): ChangeState {
    const local = leg.price ?? null;
    const mine = journal.filter((l) => l.legId === c.legId && l.field === "price");
    const last = mine[mine.length - 1];
    if (typeof last?.after === "number") return same("price", local, last.after) ? "after" : "other";
    const intent = mine.filter((l) => l.intent).at(-1);
    const was = intent && preLeg(intent, c.legId)?.updatedAt;
    const landed =
      was && leg.updatedAt && leg.priceValueCurrency === "USD" && Date.parse(leg.updatedAt) > Date.parse(was);
    if (same("price", local, c.summ)) return landed ? "either" : "before";
    return landed ? "after" : "other";
  }

  function changeState(c: Change, leg: Leg): ChangeState {
    if (c.field === "price") return priceState(c, leg);
    const now = leg[c.field as keyof Leg] as string | number;
    if (same(c.field, now, c.summ)) return "before";
    return same(c.field, now, c.desired) ? "after" : "other";
  }

  // The legs this apply may itself change or move: their own entries check them. A Summ-made fee has no lasting id
  const ours = new Set([
    ...(opts.approveDeletes ? deletes : []).flatMap((e) => e.legIds),
    ...edits.flatMap(([, e]) => [...e.changes.map((c) => c.legId), ...(e.ignore ?? [])]),
  ]);
  const baseline = new Map((context.baseline ?? []).map((l) => [l.legId, l]));
  const mates = (legs: Leg[]) => legs.filter((l) => !ours.has(l.legId) && l.importType !== "assumed-fee");

  /** How the other legs of a leg's action differ from the snapshot, or null. */
  function matesChanged(legId: string, now: Leg[]): string | null {
    const base = baseline.get(legId);
    if (!base) return null;
    const was = mates((context.baseline as Leg[]).filter((l) => l.actionId === base.actionId));
    const held = mates(now);
    const moved = [
      ...was.filter((l) => !held.some((h) => h.legId === l.legId)).map((l) => `leg ${l.legId} has left the action`),
      ...held.filter((h) => !was.some((l) => l.legId === h.legId)).map((h) => `leg ${h.legId} has joined the action`),
    ];
    for (const h of held) {
      const l = was.find((w) => w.legId === h.legId);
      for (const field of l ? MATE_FIELDS : []) {
        const [a, b] = [(l as Leg)[field] ?? null, h[field] ?? null];
        if (!same(field, a, b))
          moved.push(`${field} of leg ${h.legId} is ${JSON.stringify(b)}, was ${JSON.stringify(a)}`);
      }
    }
    return moved.length ? moved.join("; ") : null;
  }

  /** True when the entry's legs now hold, or are planned to hold, the plan's values. */
  async function editLegs(kind: string, key: string, entry: EditEntry): Promise<boolean> {
    const stop = (reason: string) => {
      conflict(key, entry.id, reason);
      return false;
    };
    // An action just edited can still be settling
    if (edited.has(entry.actionId)) await sleep(settleMs);
    const first = entry.changes[0].legId;
    const now = await lookUp(client, first);
    if (!now) return stop(`leg ${first} is no longer in Summ`);
    const states: { c: Change; leg: Leg; state: ChangeState }[] = [];
    for (const c of entry.changes) {
      const leg = now.legs.find((l) => l.legId === c.legId);
      if (!leg) return stop(`leg ${c.legId} is no longer in the action of leg ${first}`);
      states.push({ c, leg, state: changeState(c, leg) });
    }
    const describe = ({ c, leg }: { c: Change; leg: Leg }) =>
      `${c.field} of leg ${c.legId} is ${JSON.stringify(leg[c.field as keyof Leg] as string | number)} in Summ, the plan expected ${JSON.stringify(c.summ)} and sets ${JSON.stringify(c.desired)}`;
    const other = states.filter((s) => s.state === "other");
    if (other.length) return stop(other.map(describe).join("; "));
    const has = (state: ChangeState) => states.some((s) => s.state === state);
    if (has("before") && has("after")) return stop(`partly applied: ${states.map(describe).join("; ")}`);
    if (has("after")) {
      found(key, entry.id, { legIds: [...new Set(entry.changes.map((c) => c.legId))] });
      // In the shape of the line after a price edit: plan reads from it what the sync's price is
      for (const { c, leg } of states)
        if (c.field === "price")
          write?.({
            call: "found",
            via: "found",
            entry: key,
            id: entry.id,
            legId: c.legId,
            field: "price",
            from: c.summ,
            value: c.desired,
            after: leg.price ?? null,
          });
      return true;
    }
    const changedMates = matesChanged(first, now.legs);
    if (changedMates) return stop(`the other legs of its action changed since the pull: ${changedMates}`);

    const byLeg = new Map<string, Record<string, unknown>>();
    for (const c of entry.changes)
      byLeg.set(c.legId, {
        ...byLeg.get(c.legId),
        [c.field]: c.desired,
        // Summ converts a USD price at its own rate (spec: Prices)
        ...(c.field === "price" ? { priceValueCurrency: "USD" } : {}),
      });
    const args = {
      actionId: now.actionId,
      edits: [...byLeg].map(([transactionId, updates]) => ({ transactionId, updates })),
    };
    const summary = entry.changes
      .map((c) => `${c.field} ${JSON.stringify(c.summ)} -> ${JSON.stringify(c.desired)}`)
      .join(", ");
    if (!write) {
      say(`  would ${kind} ${entry.id}: ${summary}`);
      return true;
    }
    const tag = {
      kind,
      entry: key,
      pre: savePre(key, "edit", entry.id, [now.detail]),
      id: entry.id,
      actionId: now.actionId,
    };
    // One line per change, in the shape plan reads back (legId, field, value) to tell the sync's own edits from drift.
    // Each is written before the edit too: a crash or a lost answer leaves it unconfirmed, not unrecorded
    const line = (c: Change) => ({
      call: "edit_transaction",
      ...tag,
      legId: c.legId,
      field: c.field,
      from: c.summ,
      value: c.desired,
    });
    for (const c of entry.changes) write({ ...line(c), intent: true });
    const text = await callWrite(write, key, "edit_transaction", args, tag);
    result.edited++;
    const undo = undoHandle(text);
    const priced = entry.changes.filter((c) => c.field === "price");
    for (const c of entry.changes) if (!priced.includes(c)) write({ ...line(c), undo });
    write({ call: "edit_transaction", ...tag, undo, result: text });
    edited.add(entry.actionId);

    // A price only says it moved: updatedAt moves in all of these only when the edit landed, and the mark must be there.
    // An unchanged price cannot tell an edit that moved nothing from a stale read or a lost edit
    const agrees = (l: Leg) =>
      entry.changes
        .filter((c) => c.legId === l.legId)
        .every((c) => {
          if (c.field !== "price") return same(c.field, l[c.field as keyof Leg] as string | number, c.desired);
          const before = now.legs.find((b) => b.legId === l.legId)?.updatedAt;
          return Boolean(
            l.updatedAt && before && Date.parse(l.updatedAt) > Date.parse(before) && l.priceValueCurrency === "USD",
          );
        });
    const problem = countProblem(text, PATCHED, byLeg.size);
    const seen = problem ? null : await readBack(text, [...byLeg.keys()], agrees);
    for (const c of priced) write({ ...line(c), undo, after: seen?.get(c.legId)?.price ?? null });
    if (problem) throw new ApplyStop("bad-result", `${key}: ${problem}`, key);
    if (!affectedActions(text).length)
      throw new ApplyStop("bad-result", `${key}: the result names no affected action`, key);
    if (!seen) throw new ApplyStop("read-back", `${key}: the actions the edit names do not show ${summary}`, key);
    say(`  ${kind} ${entry.id}: ${summary}${undo ? ` (undo ${undo})` : ""}`);
    return true;
  }

  // ---- The run: entries in order, each finished before a signal is looked at
  if (deletes.length && !opts.approveDeletes) say(`Deletes: ${deletes.length} not applied (needs --approve-deletes)`);
  else if (deletes.length) say(`Deletes: ${deletes.length}`);
  for (const entry of opts.approveDeletes ? deletes : []) {
    if (stopping()) return result;
    await applyDelete(entry);
    if (result.stopped) return result;
  }
  if (uploads.length && categorise.length) {
    result.heldBack = categorise.length;
    say(`Categorisation: ${categorise.length} held back until the uploads are in Summ`);
  }
  if (edits.length) say(`Edits and categorisation: ${edits.length}`);
  for (const [kind, entry] of edits) {
    if (stopping()) return result;
    await applyEdit(kind, entry);
  }
  result.uploads = listUploads(plan, opts);
  return result;
}

/** What a test puts in place of the process around an apply. */
export interface ApplyHooks {
  tick?: (what: string) => void;
  isAlive?: (pid: number) => boolean;
  /** In place of the real signal handlers. */
  signal?: { requested: boolean };
}

function listUploads(plan: PlanFile, opts: ApplyOptions): { file: string; rows: number }[] {
  return selected(plan.upload, opts).map((u) => ({
    file: u.filed ? u.file.replace(/\.csv$/, "_filed.csv") : u.file,
    rows: u.ids.length,
  }));
}

function printUploads(dir: string, uploads: { file: string; rows: number }[]): void {
  const uploadDir = join(dir, "upload");
  const present = new Set(existsSync(uploadDir) ? readdirSync(uploadDir) : []);
  console.log(`Upload these files in Summ (${uploadDir}):`);
  for (const u of uploads) console.log(`  ${u.file}: ${u.rows} rows${present.has(u.file) ? "" : " (missing!)"}`);
  console.log("Then pull, plan and apply again.");
}

export async function runApply(
  client: ToolCaller & { connect(): Promise<void> },
  stateDir: string,
  planPath: string,
  opts: ApplyOptions,
  settleMs = 3000,
  hooks: ApplyHooks = {},
): Promise<ApplyResult> {
  const { dir, plan, sha } = readPlanFile(planPath);
  const planName = basename(dir);
  const logFile = join(stateDir, "apply-log.jsonl");
  const tick = hooks.tick ?? (() => {});
  const flags = { approveDeletes: opts.approveDeletes, approveFiled: opts.approveFiled };
  const run = randomUUID().slice(0, 8);
  const log = (line: NewLine) => {
    tick("log");
    appendLogLine(logFile, { time: new Date().toISOString(), plan: planName, run, ...line });
  };

  if (!opts.dryRun) {
    tick("lock");
    takeLock(stateDir, hooks.isAlive);
  }
  // The first signal lets the current entry finish; the handler is then gone, so a second stops at once
  const signal = hooks.signal ?? { requested: false };
  const onSignal = () => {
    signal.requested = true;
    console.log(
      "\nStopping: waiting for the current entry to finish. A second signal stops at once; apply can resume.",
    );
  };
  const realSignals = !hooks.signal && !opts.dryRun;
  if (realSignals) for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, onSignal);
  try {
    if (!opts.dryRun) {
      tick("repair");
      repairLog(logFile, new Date().toISOString(), planName);
    }
    const state = startState(stateDir, plan, planName, sha, flags);
    if (state === "complete") {
      console.log(`${planName} is already complete: nothing to do.`);
      const uploads = listUploads(plan, opts);
      if (uploads.length) printUploads(dir, uploads);
      return { deleted: 0, split: 0, edited: 0, found: 0, heldBack: 0, skipped: [], uploads, alreadyComplete: true };
    }
    console.log(
      `${opts.dryRun ? "Dry run of" : state === "resume" ? "Resuming" : "Applying"} ${planName} (${opts.approveFiled ? "filed years only" : "current years only"})`,
    );
    const prior = readLogLines<LogLine>(stateDir).filter((l) => l.plan === planName);
    const baseline = readSnapshot(join(stateDir, "snapshots", `${plan.snapshot}.json`)).legs;
    if (!opts.dryRun)
      log({ call: "apply-start", planSha: sha, snapshot: plan.snapshot, flags, resumed: state === "resume" });

    let result: ApplyResult;
    try {
      await client.connect();
      result = await applyPlan(
        client,
        plan,
        opts,
        log,
        console.log,
        settleMs,
        { stateDir, planDir: dir },
        {
          prior,
          baseline,
          signal,
          tick,
        },
      );
      if (!opts.dryRun && !result.stopped) {
        const captured = plan.overridden.filter((o) => o.kind === "captured").map((o) => o.override);
        tick("tables");
        const changed = mergeTables(stateDir, plan.adopted, captured);
        if (changed.length)
          console.log(`Added the plan's adoptions and captured overrides to ${changed.join(" and ")}`);
      }
    } catch (e) {
      // A failed read changed nothing, and this line is no write. A failed write has its own line, which is
      if (!opts.dryRun) {
        try {
          log({
            call: "apply-stop",
            reason: e instanceof ApplyStop ? e.reason : "error",
            ...(e instanceof ApplyStop && e.entry ? { entry: e.entry } : {}),
            error: e instanceof Error ? e.message : String(e),
          });
        } catch {
          // The stop itself is the news; the next run reads the journal as it is
        }
        console.log(
          "Stopped. Nothing more was written. Check what it reports, then run apply again, or pull and plan.",
        );
      }
      throw e;
    }

    if (result.stopped) {
      log({ call: "apply-stop", reason: "signal" });
      console.log("Stopped by a signal. Run apply again to go on from here.");
    } else {
      if (!opts.dryRun) log({ call: "apply-stop", reason: "complete" });
      console.log(
        `\nDeleted ${result.deleted} (${result.split} split edits first), edited ${result.edited}, already done ${result.found}, held back ${result.heldBack}, ${opts.dryRun ? "would stop at or report" : "reported"} ${result.skipped.length}`,
      );
      for (const r of result.skipped) console.log(`  ${r.id ?? "(no row)"}: ${r.reason}`);
      if (result.uploads.length) printUploads(dir, result.uploads);
      else
        console.log(
          opts.dryRun
            ? "Then pull and plan again."
            : "Then pull and plan again, and recalculate in Summ before reading any figures.",
        );
    }
    return result;
  } finally {
    if (realSignals) {
      for (const s of ["SIGINT", "SIGTERM"] as const) process.removeListener(s, onSignal);
      if (signal.requested) process.exitCode = 130;
    }
    if (!opts.dryRun) {
      tick("unlock");
      releaseLock(stateDir);
    }
  }
}
