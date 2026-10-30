// apply: carries out a reviewed plan through Summ's MCP (spec: docs/specs/summ-sync.md, Apply).
//
//   1. refuse a plan whose snapshot is not the latest, or that Summ changed under since (apply-log.jsonl)
//   2. deletes (--approve-deletes): each leg looked up by _id, and only actions that hold nothing but the
//      entry's legs are deleted, by action id. A leg that shares its action with legs that stay is first
//      split off: edited alone to ignoreIn/ignoreOut, which Summ moves to an action of its own; if Summ does
//      not, apply skips that entry there (the leg stays ignored) and reports it with the undo handle. A
//      receive Summ made up to pair the leg as a transfer is ignored once the leg is deleted.
//      Summ's delete has no undo, so each action is first saved as just inspected (the detail and change
//      history) to the action store, <state dir>/actions/<action id>.json, unless the store holds that id
//   3. edits and categorisation, each action looked up again by leg _id and checked against the plan's Summ value;
//      then the receive Summ made up to pair a categorised send as a transfer is ignored, once it is alone.
//      Categorisation waits while the plan has uploads: Summ pairs a categorised leg with the uploaded other
//      side of the swap only when that side is already there
//   4. list the upload files for the user
//   5. every call, its result and undo handle go to <state dir>/apply-log.jsonl as they happen
//   6. the legs the plan adopted and the overrides it captured are added to adopted.csv and overrides.json
//      (not on a dry run)
//
// Filed-year entries are applied only with --approve-filed, and then only they: a separate apply.

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type ActionDetail, parseActions, parseDetail } from "./parse.ts";
import { type DeleteEntry, type EditEntry, type Plan, same } from "./plan.ts";
import { type Leg, latestSnapshot, legsOf, readSnapshotFile, storeAction } from "./snapshot.ts";
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

export interface ApplyResult {
  deleted: number;
  /** Edits that split a leg to delete off an action whose other legs stay. */
  split: number;
  edited: number;
  /** Categorisations held back until the plan's uploads are in Summ. */
  heldBack: number;
  skipped: { id: string | null; reason: string }[];
  uploads: { file: string; rows: number }[];
}

/** The plan's folder and plan.json, given either. */
export function readPlanFile(path: string): { dir: string; plan: PlanFile } {
  const file = existsSync(join(path, "plan.json")) ? join(path, "plan.json") : path;
  return { dir: dirname(file), plan: JSON.parse(readFileSync(file, "utf8")) };
}

/** Refuses a plan made from an older snapshot, or one Summ was written to after the snapshot was taken. */
export function checkFresh(stateDir: string, plan: PlanFile): void {
  const latest = latestSnapshot(stateDir);
  if (basename(latest, ".json") !== plan.snapshot) {
    throw new Error(
      `The plan is from snapshot ${plan.snapshot}, the latest is ${basename(latest, ".json")}: plan again`,
    );
  }
  const takenAt = readSnapshotFile(latest).takenAt;
  const log = join(stateDir, "apply-log.jsonl");
  const later = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
        .filter((l) => l.time > takenAt && l.call !== "skip")
    : [];
  if (later.length)
    throw new Error(
      `apply-log.jsonl has ${later.length} writes since snapshot ${plan.snapshot} was taken: pull and plan again`,
    );
}

/** The plan's entries this apply carries out: the current year's, or with approveFiled only the filed years'. */
export function selected<T extends { filed: boolean }>(entries: T[], opts: ApplyOptions): T[] {
  return entries.filter((e) => e.filed === opts.approveFiled);
}

/** The bulk edit id (undo handle) in an edit's result text, if it has one. */
export function undoHandle(text: string): string | null {
  return text.match(/Bulk Edit ID\W*([A-Za-z0-9_-]{8,})/i)?.[1] ?? null;
}

// Candidates only: the id filter lists the leg's action but can list unrelated actions too, even with
// showAssociated 0, so each is inspected, and a write never selects by this filter
const idFilter = (legIds: string[]) => ({ type: "id", value: legIds, showAssociated: 0 });

type Found = { actionId: string; legs: Leg[]; detail: ActionDetail };

/** The action that holds a leg now (action ids change on every write) and its legs. */
async function lookUp(client: ToolCaller, legId: string): Promise<Found | null> {
  const listed = parseActions(
    await client.callTool("query_summ_transactions", { filter: idFilter([legId]), includeHidden: true, count: 50 }),
  );
  for (const actionId of new Set(listed.map((a) => a["Action ID"] as string))) {
    const detail = parseDetail(await client.callTool("inspect_transaction", { actionId }));
    const legs = legsOf(detail);
    if (legs.some((l) => l.legId === legId)) return { actionId, legs, detail };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function applyPlan(
  client: ToolCaller,
  plan: PlanFile,
  opts: ApplyOptions,
  log: (line: Omit<LogLine, "time" | "plan">) => void,
  say: (text: string) => void = console.log,
  /** Summ rebuilds actions and refreshes its search a few seconds after a write. */
  settleMs = 3000,
  /** The state dir, whose action store keeps each action before it is deleted. */
  stateDir: string | null = null,
): Promise<ApplyResult> {
  const result: ApplyResult = { deleted: 0, split: 0, edited: 0, heldBack: 0, skipped: [], uploads: [] };
  const write = opts.dryRun ? null : log;
  const skip = (id: string | null, reason: string, extra: Record<string, unknown> = {}): false => {
    result.skipped.push({ id, reason });
    say(`  skipped ${id ?? "(no row)"}: ${reason}`);
    write?.({ call: "skip", id, reason, ...extra });
    return false;
  };

  // ---- Deletes
  const deletes = selected(plan.delete, opts);
  if (deletes.length && !opts.approveDeletes) say(`Deletes: ${deletes.length} not applied (needs --approve-deletes)`);
  else if (deletes.length) say(`Deletes: ${deletes.length}`);
  for (const entry of opts.approveDeletes ? deletes : []) await applyDelete(entry);

  async function applyDelete(entry: DeleteEntry) {
    const lookUpAll = async (): Promise<Map<string, Found> | string> => {
      const found = new Map<string, Found>();
      for (const legId of entry.legIds) {
        const f = await lookUp(client, legId);
        if (!f) return `leg ${legId} is no longer in Summ`;
        found.set(legId, f);
      }
      return found;
    };
    const sharing = (found: Map<string, Found>) =>
      [...found.values()].filter((f) => f.legs.some((l) => !entry.legIds.includes(l.legId)));
    let found = await lookUpAll();
    if (typeof found === "string") return skip(entry.id, found, { legIds: entry.legIds });

    // A leg that shares its action with legs that stay is split off first: edited alone to an ignore type
    // (undoable, and it no longer counts), which Summ moves to an action of its own. Never a delete by filter.
    const shared = new Map(sharing(found).map((f) => [f.actionId, f]));
    // Summ's made-up other side of a transfer would be left alone once the leg is gone: ignored after the delete
    const madeUp = [...shared.values()].flatMap((f) =>
      f.legs.filter((l) => l.importType === "soft-transfer" && !entry.legIds.includes(l.legId)).map((l) => l.legId),
    );
    const isIgnored = (l: Leg) => l.trade === "ignoreIn" || l.trade === "ignoreOut";
    if (shared.size) {
      if (!write)
        return say(`  would split ${entry.legIds.length} legs of ${entry.summId} off their actions, then delete them`);
      if (!stateDir) throw new Error("apply needs the state dir to save actions to before splitting them");
      const undos: string[] = [];
      for (const f of shared.values()) {
        const saved = storeAction(stateDir, f.detail);
        // An edit to the type a leg already has changes nothing, so Summ would not split it
        const legs = f.legs.filter((l) => entry.legIds.includes(l.legId) && !isIgnored(l));
        if (!legs.length)
          return skip(entry.id, `leg already ignored but still shares action ${f.actionId} with other legs`, {
            legIds: entry.legIds,
          });
        const edits = legs.map((l) => ({
          transactionId: l.legId,
          updates: { trade: l.side === "incoming" ? "ignoreIn" : "ignoreOut" },
        }));
        const text = await client.callTool("edit_transaction", { actionId: f.actionId, edits });
        result.split++;
        const undo = undoHandle(text);
        if (undo) undos.push(undo);
        for (const [i, l] of legs.entries()) {
          write({
            call: "edit_transaction",
            kind: "split",
            id: entry.id,
            actionId: f.actionId,
            legId: l.legId,
            field: "trade",
            from: l.trade,
            value: edits[i].updates.trade,
            undo,
            saved,
          });
        }
        write({ call: "edit_transaction", kind: "split", id: entry.id, actionId: f.actionId, undo, result: text });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(settleMs);
        found = await lookUpAll();
        if (typeof found === "string") return skip(entry.id, `${found} after the split`, { legIds: entry.legIds });
        if (!sharing(found).length) break;
      }
      // Once more after Summ has settled: a split-off action is deleted only when two look-ups agree it is alone
      if (!sharing(found as Map<string, Found>).length) {
        await sleep(settleMs);
        found = await lookUpAll();
        if (typeof found === "string") return skip(entry.id, `${found} after the split`, { legIds: entry.legIds });
      }
      const still = sharing(found);
      if (still.length) {
        const others = still.flatMap((f) => f.legs.filter((l) => !entry.legIds.includes(l.legId))).length;
        return skip(
          entry.id,
          `Summ did not split the legs off (still with ${others} other legs); left ignored, undo ${undos.join(", ")}`,
          { legIds: entry.legIds },
        );
      }
    }
    const actions = new Map([...(found as Map<string, Found>).values()].map((f) => [f.actionId, f.detail]));
    // By the actions just inspected, which hold only the entry's legs: never by a filter
    const args = { actionIds: [...actions.keys()], operation: { type: "delete" } };
    if (!write) return say(`  would delete ${entry.legIds.length} legs of ${entry.summId}`);
    if (!stateDir) throw new Error("apply needs the state dir to save actions to before deleting them");
    const saved = [...actions.values()].map((detail) => storeAction(stateDir, detail));
    const text = await client.callTool("bulk_edit_transactions", args);
    result.deleted++;
    write({
      call: "bulk_edit_transactions",
      operation: "delete",
      id: entry.id,
      summId: entry.summId,
      legIds: entry.legIds,
      actionIds: [...actions.keys()],
      saved,
      result: text,
    });
    for (const legId of madeUp) await ignoreMadeUp(entry.id, legId, true);
  }

  // ---- Edits, then categorisation: the same call on a managed row's legs or on Summ's own leg
  const uploads = selected(plan.upload, opts);
  const categorise = selected(plan.categorise, opts);
  if (uploads.length && categorise.length) {
    result.heldBack = categorise.length;
    say(`Categorisation: ${categorise.length} held back until the uploads are in Summ`);
  }
  const edits = [
    ...selected(plan.edit, opts).map((e) => ["edit", e] as const),
    ...(uploads.length ? [] : categorise).map((e) => ["categorise", e] as const),
  ];
  if (edits.length) say(`Edits and categorisation: ${edits.length}`);
  for (const [kind, entry] of edits) await applyEdit(kind, entry);

  async function applyEdit(kind: string, entry: EditEntry) {
    if (entry.changes.length && !(await editLegs(kind, entry))) return;
    for (const legId of entry.ignore ?? []) await ignoreMadeUp(entry.id, legId, entry.changes.length > 0);
  }

  /** Summ's made-up other side of a transfer, once the categorised leg is split off: ignored, by action id. */
  async function ignoreMadeUp(id: string | null, legId: string, afterEdit: boolean) {
    if (!write) return say(`  would ignore the made-up leg ${legId} of ${id}`);
    let found: Found | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (afterEdit || attempt > 0) await sleep(settleMs);
      found = await lookUp(client, legId);
      if (found && found.legs.length === 1) break;
    }
    if (!found) return skip(id, `made-up leg ${legId} is no longer in Summ`);
    const leg = found.legs.find((l) => l.legId === legId) as Leg;
    if (found.legs.length !== 1)
      return skip(id, `made-up leg ${legId} still shares its action with ${found.legs.length - 1} other legs`);
    if (leg.importType !== "soft-transfer") return skip(id, `leg ${legId} is not a made-up leg (${leg.importType})`);
    if (leg.trade === "ignoreIn" || leg.trade === "ignoreOut")
      return say(`  made-up leg ${legId} of ${id} is already ignored`);
    const text = await client.callTool("bulk_edit_transactions", {
      actionIds: [found.actionId],
      operation: { type: "ignore" },
    });
    const undo = undoHandle(text);
    write({
      call: "bulk_edit_transactions",
      operation: "ignore",
      id,
      legIds: [legId],
      actionIds: [found.actionId],
      undo,
      result: text,
    });
    say(`  ignored the made-up leg of ${id}${undo ? ` (undo ${undo})` : ""}`);
  }

  /** True when the edit was made. */
  async function editLegs(kind: string, entry: EditEntry): Promise<boolean> {
    const found = await lookUp(client, entry.changes[0].legId);
    if (!found) return skip(entry.id, `leg ${entry.changes[0].legId} is no longer in Summ`);
    for (const change of entry.changes) {
      const leg = found.legs.find((l) => l.legId === change.legId);
      if (!leg)
        return skip(entry.id, `leg ${change.legId} is no longer in the action of leg ${entry.changes[0].legId}`);
      const now = leg[change.field as keyof Leg] as string | number;
      if (!same(change.field, now, change.summ)) {
        return skip(
          entry.id,
          `${change.field} of leg ${change.legId} is ${JSON.stringify(now)} in Summ, the plan expected ${JSON.stringify(change.summ)}`,
        );
      }
    }
    const byLeg = new Map<string, Record<string, unknown>>();
    for (const c of entry.changes)
      byLeg.set(c.legId, {
        ...byLeg.get(c.legId),
        [c.field]: c.desired,
        // Summ converts a USD price at its own rate (spec: Prices)
        ...(c.field === "price" ? { priceValueCurrency: "USD" } : {}),
      });
    const args = {
      actionId: found.actionId,
      edits: [...byLeg].map(([transactionId, updates]) => ({ transactionId, updates })),
    };
    const summary = entry.changes
      .map((c) => `${c.field} ${JSON.stringify(c.summ)} -> ${JSON.stringify(c.desired)}`)
      .join(", ");
    if (!write) {
      say(`  would ${kind} ${entry.id}: ${summary}`);
      return true;
    }
    const text = await client.callTool("edit_transaction", args);
    result.edited++;
    const undo = undoHandle(text);
    // Summ keeps no USD figure: the local price it now shows is what says, later, that this edit still stands.
    // The edit is made, so a failed read must not stop the log line
    const priced = entry.changes.filter((c) => c.field === "price");
    if (priced.length) await sleep(settleMs);
    const after = priced.length ? await lookUp(client, priced[0].legId).catch(() => null) : null;
    // One line per change, in the shape plan reads back (legId, field, value) to tell the sync's own edits from drift
    for (const c of entry.changes)
      write({
        call: "edit_transaction",
        kind,
        id: entry.id,
        actionId: found.actionId,
        legId: c.legId,
        field: c.field,
        from: c.summ,
        value: c.desired,
        ...(c.field === "price" ? { after: after?.legs.find((l) => l.legId === c.legId)?.price ?? null } : {}),
        undo,
      });
    write({ call: "edit_transaction", kind, id: entry.id, actionId: found.actionId, undo, result: text });
    say(`  ${kind} ${entry.id}: ${summary}${undo ? ` (undo ${undo})` : ""}`);
    return true;
  }

  for (const u of uploads)
    result.uploads.push({ file: u.filed ? u.file.replace(/\.csv$/, "_filed.csv") : u.file, rows: u.ids.length });
  return result;
}

export async function runApply(
  client: ToolCaller & { connect(): Promise<void> },
  stateDir: string,
  planPath: string,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const { dir, plan } = readPlanFile(planPath);
  checkFresh(stateDir, plan);
  const planName = basename(dir);
  const logFile = join(stateDir, "apply-log.jsonl");
  const log = (line: Omit<LogLine, "time" | "plan">) =>
    appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), plan: planName, ...line }) + "\n");
  console.log(
    `${opts.dryRun ? "Dry run of" : "Applying"} ${planName} (${opts.approveFiled ? "filed years only" : "current years only"})`,
  );
  await client.connect();
  let result: ApplyResult;
  try {
    result = await applyPlan(client, plan, opts, log, console.log, 3000, stateDir);
  } catch (e) {
    // Stop at the first failure; a failed write may still have changed Summ, so it counts as a write
    if (!opts.dryRun) log({ call: "error", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  if (!opts.dryRun) {
    const captured = plan.overridden.filter((o) => o.kind === "captured").map((o) => o.override);
    const changed = mergeTables(stateDir, plan.adopted, captured);
    if (changed.length) console.log(`Added the plan's adoptions and captured overrides to ${changed.join(" and ")}`);
  }

  const uploadDir = join(dir, "upload");
  const present = new Set(existsSync(uploadDir) ? readdirSync(uploadDir) : []);
  console.log(
    `\nDeleted ${result.deleted} (${result.split} split edits first), edited ${result.edited}, skipped ${result.skipped.length}, held back ${result.heldBack}`,
  );
  if (result.uploads.length) {
    console.log(`Upload these files in Summ (${uploadDir}):`);
    for (const u of result.uploads)
      console.log(`  ${u.file}: ${u.rows} rows${present.has(u.file) ? "" : " (missing!)"}`);
    console.log("Then pull, plan and apply again.");
  } else
    console.log(
      opts.dryRun
        ? "Then pull and plan again."
        : "Then pull and plan again, and recalculate in Summ before reading any figures.",
    );
  return result;
}
