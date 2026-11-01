// verify: whether Summ's legs hold what an applied plan said, and nothing else moved (spec: docs/specs/summ-sync.md,
// Verify). Compares the plan's snapshot with the latest. Calls nothing; writes <plan dir>/verify-<after>.md.

import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type LogLine, type PlanFile, readPlanFile, selected } from "./apply.ts";
import { isWriteLine, readLogLines } from "./journal.ts";
import { type Change, type EditEntry, same, sameValue, soldAmount } from "./plan.ts";
import {
  type Leg,
  latestSnapshot,
  normaliseTxid,
  readSnapshot,
  readSnapshotFile,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotFile,
} from "./snapshot.ts";

/** The fields of a leg that hold what a row said. Nothing Summ computes or moves on its own: not its action id,
 * `updatedAt`, or the balances and values kept beside it. */
const FIELDS = [
  "id",
  "trade",
  "currency",
  "quantity",
  "timestamp",
  "from",
  "to",
  "blockchain",
  "description",
  "price",
  "feeQuantity",
  "feeCurrency",
  "source",
  "importType",
  "comments",
] as const;
const IGNORED = new Set(["ignoreIn", "ignoreOut"]);
/** Summ issues these fee legs itself, and can issue them again under new ids. */
const SUMM_FEE = "assumed-fee";
/** What an uploaded row's legs carry. A leg Summ makes up can carry the ID of the row it pairs with. */
const UPLOADED = "manual-csv";
/** Set by a review session in Summ's app, on any number of actions. */
const SESSION_TAGS = new Set(["REVIEWED"]);

type EntryState = "landed" | "not selected" | "held back" | "not reached" | "NOT LANDED";

export interface EntryResult {
  key: string;
  state: EntryState;
  /** What does not hold, or what could not be confirmed. */
  problems: string[];
  /** Prices set, with their rate: a USD price stored as if local reads as a rate of 1. */
  rates: string[];
  /** A categorised leg's action as it now stands: a leg that failed to pair passes every field check. */
  action?: string;
}

export interface FieldChange {
  leg: Leg;
  field: string;
  before: unknown;
  after: unknown;
  history?: string;
  /** In an action a delete of the plan took a leg from. */
  besideDelete: boolean;
}

export interface Verification {
  flags: { approveDeletes: boolean; approveFiled: boolean };
  stop: string | null;
  entries: EntryResult[];
  uploaded: string[];
  notUploaded: string[];
  /** A row's ID on a new leg while an old leg of that ID stays: its disposal or acquisition counts twice. */
  besideOldCopy: Leg[];
  left: string[];
  changed: FieldChange[];
  gone: Leg[];
  added: Leg[];
  /** Fee legs Summ issued again under new ids with the same values, and those with no counterpart. */
  summFeesReissued: number;
  summFeesGone: Leg[];
  summFeesAdded: Leg[];
  /** Legs that left or entered the details this pull read: the snapshots cannot say what happened to them. */
  notRead: Leg[];
  newlyRead: Leg[];
  /** `beside`: a leg of the plan or an upload is among its other legs, which does not make this the right pair. */
  pairing: {
    leg: Leg;
    categoryBefore: string;
    categoryAfter: string;
    matesBefore: number;
    matesAfter: number;
    beside: boolean;
  }[];
  listBefore: string[];
  listAfter: string[];
}

export interface VerifyInput {
  plan: PlanFile;
  planName: string;
  before: Snapshot;
  beforeFile: SnapshotFile;
  after: Snapshot;
  afterFile: SnapshotFile;
  /** This plan's lines of the log. */
  lines: LogLine[];
}

const hashesOf = (entries: SnapshotEntry[]): Set<string> =>
  new Set(
    entries
      .filter((e) => !e.detail)
      .flatMap((e) => e.txHash.split(/[\s,]+/))
      .filter(Boolean)
      .map(normaliseTxid),
  );

/** When Summ created a leg, from its id. */
const createdBefore = (legId: string, time: string): boolean =>
  /^[0-9a-f]{24}$/i.test(legId) && parseInt(legId.slice(0, 8), 16) * 1000 < Date.parse(time);

const valueOf = (leg: Leg, field: string): unknown => {
  const value = (leg as unknown as Record<string, unknown>)[field];
  return Array.isArray(value) ? JSON.stringify(value) : (value ?? null);
};

const unchanged = (field: string, a: unknown, b: unknown): boolean =>
  field === "quantity" || field === "timestamp" || field === "trade"
    ? same(field, a as string, b as string)
    : a === b || String(a) === String(b);

const byLeg = (legs: Leg[]) => new Map(legs.map((l) => [l.legId, l]));

/** The legs sharing each action, leaving out the fees Summ issues itself. */
function matesOf(legs: Leg[]): Map<string, string[]> {
  const inAction = new Map<string, string[]>();
  for (const l of legs) {
    if (l.importType !== SUMM_FEE) inAction.set(l.actionId, [...(inAction.get(l.actionId) ?? []), l.legId]);
  }
  return new Map(
    legs.flatMap((l) =>
      l.importType === SUMM_FEE
        ? []
        : [
            [l.legId, (inAction.get(l.actionId) as string[]).filter((id) => id !== l.legId).sort()] as [
              string,
              string[],
            ],
          ],
    ),
  );
}

/** Pure, so that a test or a replay can give it any two snapshots. */
export function verifyPlan({ plan, before, beforeFile, after, afterFile, lines }: VerifyInput): Verification {
  const was = byLeg(before.legs);
  const now = byLeg(after.legs);

  // The flags of the run that wrote, as apply holds a plan to them
  const starts = lines.filter((l) => l.call === "apply-start");
  const wrote = lines.find(isWriteLine);
  const flagged = (starts.find((l) => wrote && l.run === wrote.run) ?? starts.at(-1))?.flags as
    Verification["flags"] | undefined;
  const flags = flagged ?? { approveDeletes: false, approveFiled: false };
  // The last run's stop: a run that died logs none, whatever an earlier run did
  const lastRun = starts.at(-1)?.run;
  const stopLine = lines.filter((l) => l.call === "apply-stop" && l.run === lastRun).at(-1);
  const stop = (stopLine?.reason as string | undefined) ?? null;

  const linesOf = (key: string) => lines.filter((l) => l.entry === key);
  /** The leg's price as apply last read it back, or undefined. */
  const readBack = (legId: string): number | null | undefined => {
    const line = lines.filter((l) => l.legId === legId && l.field === "price" && !l.intent).at(-1);
    return line ? ((line.after as number | null | undefined) ?? null) : undefined;
  };
  const uploadsSelected = selected(plan.upload, flags).length > 0;

  function changeProblem(c: Change, rates: string[]): string | null {
    const leg = now.get(c.legId);
    if (!leg) return `${c.field}: leg ${c.legId} is not in the snapshot`;
    if (c.field !== "price") {
      return same(c.field, valueOf(leg, c.field) as string, c.desired)
        ? null
        : `${c.field}: ${String(valueOf(leg, c.field))}, the plan said ${String(c.desired)} (leg ${c.legId})`;
    }
    // A USD price cannot be read back in USD: the local price apply read back, under the USD mark
    const back = readBack(c.legId);
    if (back === undefined) return `price: no write was logged for leg ${c.legId}`;
    if (back === null) return `price: apply read nothing back for leg ${c.legId}, so this is unconfirmed`;
    if (leg.price !== back) return `price: ${leg.price}, apply read back ${back} (leg ${c.legId})`;
    if (leg.priceValueCurrency !== "USD") return `price: no USD mark on leg ${c.legId}`;
    if (Number(c.desired)) rates.push(`${leg.currency} ${(back / Number(c.desired)).toFixed(4)}`);
    return null;
  }

  function matchProblem(entry: EditEntry): string | null {
    if (!entry.match) return null;
    const { legId, baseLegId } = entry.match;
    const [quote, base] = [now.get(legId), now.get(baseLegId)];
    if (!quote || !base) return `the value of leg ${legId}: it or its base leg is not in the snapshot`;
    const mates = after.legs.filter((l) => l.actionId === base.actionId);
    const [sold, bought] = [(base.price ?? 0) * soldAmount(base, mates), (quote.price ?? 0) * quote.quantity];
    return sold > 0 && sameValue(sold, bought) ? null : `value: sold ${sold}, bought ${bought} (leg ${legId})`;
  }

  const stateOf = (problems: string[], key: string, chosen: boolean, heldBack: boolean): EntryState => {
    if (!problems.length) return "landed";
    if (stopLine?.entry === key) return "NOT LANDED";
    if (!chosen) return "not selected";
    if (heldBack && !linesOf(key).length) return "held back";
    if (stop !== "complete" && !linesOf(key).length) return "not reached";
    return "NOT LANDED";
  };

  const left: string[] = [];
  const leftOf = (key: string) => {
    const legs = linesOf(key).flatMap((l) => (l.leftLeg ? [l.leftLeg as string] : []));
    for (const id of legs) if (!left.includes(id)) left.push(id);
    return new Set(legs);
  };
  const ignoreProblems = (legIds: string[], stays: Set<string>) =>
    legIds
      .filter((id) => !stays.has(id) && !IGNORED.has(now.get(id)?.trade ?? ""))
      .map((id) => `leg ${id}, to be ignored, is ${now.get(id)?.trade ?? "not in the snapshot"}`);
  const madeUpOf = (key: string) => [...new Set(linesOf(key).flatMap((l) => (l.madeUp as string[] | undefined) ?? []))];

  const entries: EntryResult[] = [];
  const deleted = new Set<string>();
  for (const [i, d] of plan.delete.entries()) {
    const key = `delete-${i}`;
    // Gone is not deleted: with no delete logged the leg is reported below, as apply itself would stop on it
    const logged = linesOf(key).some((l) => l.operation === "delete" || l.call === "found");
    if (logged) for (const id of d.legIds) deleted.add(id);
    const problems = d.legIds.flatMap((id) =>
      now.has(id) ? [`leg ${id} is still there`] : logged ? [] : [`leg ${id} is gone, with no delete logged`],
    );
    problems.push(...ignoreProblems(madeUpOf(key), leftOf(key)));
    const chosen = flags.approveDeletes && d.filed === flags.approveFiled;
    entries.push({ key, state: stateOf(problems, key, chosen, false), problems, rates: [] });
  }
  for (const kind of ["edit", "categorise"] as const) {
    for (const [i, e] of plan[kind].entries()) {
      const key = `${kind}-${i}`;
      const rates: string[] = [];
      const problems = e.changes.flatMap((c) => changeProblem(c, rates) ?? []);
      const unmatched = matchProblem(e);
      if (unmatched) problems.push(unmatched);
      problems.push(...ignoreProblems(e.ignore ?? [], leftOf(key)));
      const first = now.get(e.changes[0]?.legId);
      entries.push({
        key,
        state: stateOf(problems, key, e.filed === flags.approveFiled, kind === "categorise" && uploadsSelected),
        problems,
        rates,
        ...(kind === "categorise" && first
          ? {
              action: `${afterFile.actions.find((a) => a.id === first.actionId)?.category ?? "?"}, with ${after.legs.filter((l) => l.actionId === first.actionId).length - 1} other legs`,
            }
          : {}),
      });
    }
  }

  // Uploads
  const added0 = after.legs.filter((l) => !was.has(l.legId));
  const uploadIds = new Set(plan.upload.flatMap((u) => u.ids));
  const isUpload = (l: Leg | undefined) => l !== undefined && l.importType === UPLOADED && uploadIds.has(l.id);
  const newIds = new Set(added0.filter(isUpload).map((l) => l.id));
  const uploaded = [...uploadIds].filter((id) => newIds.has(id));
  const notUploaded = [...uploadIds].filter((id) => !newIds.has(id));
  const besideOldCopy = before.legs.filter(
    (l) => uploadIds.has(l.id) && newIds.has(l.id) && now.has(l.legId) && l.importType !== SUMM_FEE,
  );

  // What the plan explains: by field, as a leg named for one thing is not cleared for another; and only entries that
  // ran, as a leg of one held back or not reached that moves, moved on its own
  const explained = new Set<string>();
  const touched = new Set<string>();
  const explain = (legId: string, field: string) => {
    explained.add(`${legId}|${field}`);
    touched.add(legId);
  };
  for (const kind of ["edit", "categorise"] as const) {
    for (const [i, e] of plan[kind].entries()) {
      const key = `${kind}-${i}`;
      if (entries.find((x) => x.key === key)?.state !== "landed" && !linesOf(key).length) continue;
      for (const c of e.changes) explain(c.legId, c.field);
      for (const id of e.ignore ?? []) explain(id, "trade");
      if (e.match) explain(e.match.legId, "price");
    }
  }
  for (const l of lines) {
    if (l.legId && l.field) explain(l.legId as string, l.field as string);
    for (const id of (l.madeUp as string[] | undefined) ?? []) explain(id, "trade");
    if (l.operation === "ignore") for (const id of (l.legIds as string[] | undefined) ?? []) explain(id, "trade");
    if (l.operation === "delete") for (const id of (l.legIds as string[] | undefined) ?? []) deleted.add(id);
  }
  for (const id of deleted) touched.add(id);
  const besideDelete = new Set(plan.delete.flatMap((d) => (d.others ?? []).map((o) => o.legId)));

  const historyOf = (leg: Leg) => after.history.get(leg.actionId)?.at(-1);
  const changed: FieldChange[] = [];
  for (const b of before.legs) {
    const a = now.get(b.legId);
    if (!a) continue;
    for (const field of FIELDS) {
      const [x, y] = [valueOf(b, field), valueOf(a, field)];
      if (!unchanged(field, x, y) && !explained.has(`${b.legId}|${field}`)) {
        changed.push({
          leg: a,
          field,
          before: x,
          after: y,
          history: historyOf(a),
          besideDelete: besideDelete.has(b.legId),
        });
      }
    }
  }

  // Summ's own fee legs, issued again under new ids, are the same legs
  const content = (l: Leg) => [l.id, l.currency, l.quantity, l.timestamp].join("|");
  const fresh = new Map<string, Leg[]>();
  for (const l of added0) {
    if (l.importType === SUMM_FEE) fresh.set(content(l), [...(fresh.get(content(l)) ?? []), l]);
  }
  let summFeesReissued = 0;
  const reissued = new Set<string>();
  const gone0 = before.legs.filter((l) => !now.has(l.legId) && !deleted.has(l.legId));
  const summFeesGone: Leg[] = [];
  const unreadAfter = hashesOf(afterFile.actions);
  const unreadBefore = hashesOf(beforeFile.actions);
  const gone: Leg[] = [];
  const notRead: Leg[] = [];
  for (const l of gone0) {
    if (l.importType === SUMM_FEE) {
      const twin = fresh.get(content(l))?.pop();
      if (twin) {
        summFeesReissued++;
        reissued.add(twin.legId);
      } else summFeesGone.push(l);
    } else if (unreadAfter.has(normaliseTxid(l.id))) notRead.push(l);
    else gone.push(l);
  }
  const summFeesAdded: Leg[] = [];
  const added: Leg[] = [];
  const newlyRead: Leg[] = [];
  for (const l of added0) {
    if (reissued.has(l.legId) || isUpload(l)) continue;
    if (l.importType === SUMM_FEE) summFeesAdded.push(l);
    else if (unreadBefore.has(normaliseTxid(l.id)) || createdBefore(l.legId, beforeFile.takenAt)) newlyRead.push(l);
    else added.push(l);
  }

  // Summ's matcher pairs legs, which shows on no field of a leg: the legs an action holds, and its category
  const categories = (file: SnapshotFile) => new Map(file.actions.map((a) => [a.id, a.category]));
  const [catBefore, catAfter] = [categories(beforeFile), categories(afterFile)];
  const [matesBefore, matesAfter] = [matesOf(before.legs), matesOf(after.legs)];
  const inPlan = (id: string) => touched.has(id) || isUpload(now.get(id)) || isUpload(was.get(id));
  const pairing: Verification["pairing"] = [];
  for (const b of before.legs) {
    const a = now.get(b.legId);
    if (!a || b.importType === SUMM_FEE) continue;
    const [m0, m1] = [matesBefore.get(b.legId) ?? [], matesAfter.get(b.legId) ?? []];
    const [c0, c1] = [catBefore.get(b.actionId) ?? "", catAfter.get(a.actionId) ?? ""];
    if (m0.join() === m1.join() && c0 === c1) continue;
    // A row's own legs travel together: its fee beside its edited leg is that leg
    const sameRow = (id: string) => (now.get(id) ?? was.get(id))?.id === b.id;
    if (inPlan(b.legId) || [...m0, ...m1].some((id) => inPlan(id) && sameRow(id))) continue;
    pairing.push({
      leg: a,
      categoryBefore: c0,
      categoryAfter: c1,
      matesBefore: m0.length,
      matesAfter: m1.length,
      beside: [...m0, ...m1].some(inPlan),
    });
  }

  return {
    flags,
    stop,
    entries,
    uploaded,
    notUploaded,
    besideOldCopy,
    left,
    changed,
    gone,
    added,
    summFeesReissued,
    summFeesGone,
    summFeesAdded,
    notRead,
    newlyRead,
    pairing,
    ...listDifference(beforeFile, afterFile),
  };
}

/** Actions with no detail have nothing else to compare: by tx hash, category and tags, as multisets. */
function listDifference(a: SnapshotFile, b: SnapshotFile): { listBefore: string[]; listAfter: string[] } {
  const keys = (file: SnapshotFile) => {
    const counts = new Map<string, number>();
    for (const e of file.actions) {
      if (e.detail) continue;
      const key = `${e.txHash} ${e.category} ${e.tags
        .filter((t) => !SESSION_TAGS.has(t))
        .sort()
        .join(",")}`.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const [x, y] = [keys(a), keys(b)];
  const beyond = (p: Map<string, number>, q: Map<string, number>) =>
    [...p].flatMap(([k, n]) => Array<string>(Math.max(0, n - (q.get(k) ?? 0))).fill(k));
  return { listBefore: beyond(x, y), listAfter: beyond(y, x) };
}

const legLine = (l: Leg) =>
  `${l.timestamp} ${l.quantity} ${l.currency} ${l.trade}, ${l.source}/${l.importType} (leg ${l.legId}, ID ${l.id})`;

/** The verification as its report. */
export function verifyMarkdown(v: Verification, planName: string, beforeName: string, afterName: string): string {
  const out = [`# Verify ${planName}`, ""];
  out.push(`- Snapshots: ${beforeName} to ${afterName}`);
  out.push(`- Last apply stop: ${v.stop ?? "none logged"}; flags: ${JSON.stringify(v.flags)}`);
  out.push("- Next: `plan` compares the rows with these legs. `figures` and `compare` say what moved in tax.", "");

  const count = (state: EntryState) => v.entries.filter((e) => e.state === state).length;
  out.push("## The plan", "");
  out.push(
    `${count("landed")} landed, ${count("NOT LANDED")} not landed, ${count("not selected")} not selected, ${count("held back")} held back, ${count("not reached")} not reached. Rows uploaded: ${v.uploaded.length}, not yet: ${v.notUploaded.length}.`,
    "",
  );
  for (const e of v.entries.filter((x) => x.state === "NOT LANDED")) {
    out.push(`- **${e.key} NOT LANDED**`, ...e.problems.map((p) => `  - ${p}`));
  }
  for (const e of v.entries.filter((x) => x.state !== "NOT LANDED" && (x.rates.length || x.action))) {
    const notes = [e.action ? `action ${e.action}` : "", e.rates.length ? `rates ${e.rates.join(", ")}` : ""];
    out.push(`- ${e.key} ${e.state}: ${notes.filter(Boolean).join("; ")}`);
  }
  for (const id of v.left) out.push(`- Leg ${id} was left in place, as apply reported.`);
  for (const l of v.besideOldCopy) out.push(`- **Uploaded beside its old copy, so counted twice:** ${legLine(l)}`);
  out.push("");

  const section = (title: string, lines: string[]) =>
    out.push(`## ${title}`, "", ...(lines.length ? lines : ["None."]), "");
  section(
    "Fields changed outside the plan",
    v.changed.map(
      (c) =>
        `- ${c.field}: ${String(c.before)} to ${String(c.after)}, on ${legLine(c.leg)}${c.besideDelete ? " (beside a delete of the plan)" : ""}${c.history ? `. Last in Summ: ${c.history}` : ""}`,
    ),
  );
  section(
    "Legs gone outside the plan",
    v.gone.map((l) => `- ${legLine(l)}`),
  );
  section(
    "New legs in no upload",
    v.added.map((l) => `- ${legLine(l)}`),
  );
  const pairLine = (p: Verification["pairing"][number]) =>
    `- ${legLine(p.leg)}: action ${p.categoryBefore} to ${p.categoryAfter}, other legs ${p.matesBefore} to ${p.matesAfter}`;
  section("Pairing changed outside the plan", v.pairing.filter((p) => !p.beside).map(pairLine));
  section(
    "Paired beside the plan: a leg outside it now shares an action with one in it. Check it is the right pair",
    v.pairing.filter((p) => p.beside).map(pairLine),
  );
  section("Summ's own fee legs", [
    ...(v.summFeesReissued ? [`${v.summFeesReissued} issued again under new ids, with the same values.`] : []),
    ...v.summFeesGone.map((l) => `- Gone: ${legLine(l)}`),
    ...v.summFeesAdded.map((l) => `- New: ${legLine(l)}`),
  ]);
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

/** Refuses what cannot be compared; a plan is verified between its own snapshot and the latest. */
export function runVerify(stateDir: string, planPath: string, afterSnapshot?: string): string {
  if (existsSync(join(stateDir, ".lock"))) {
    throw new Error("verify: an apply holds the lock; if none is running, apply clears it");
  }
  if (!existsSync(join(planPath, "plan.json"))) throw new Error(`verify: ${planPath} holds no plan.json`);
  const { dir, plan } = readPlanFile(planPath);
  const planName = basename(resolve(dir));
  const snapshotFile = (name: string) => join(stateDir, "snapshots", `${name}.json`);
  if (!existsSync(snapshotFile(plan.snapshot))) {
    throw new Error(`verify: snapshot ${plan.snapshot} of this plan is gone (prune?)`);
  }
  const latest = afterSnapshot ? snapshotFile(afterSnapshot) : latestSnapshot(stateDir);
  if (!existsSync(latest)) throw new Error(`verify: no snapshot ${afterSnapshot}`);
  const afterName = basename(latest, ".json");
  if (afterName === plan.snapshot) throw new Error("verify: that snapshot is the plan's own: pull first");
  const beforeFile = readSnapshotFile(snapshotFile(plan.snapshot));
  const afterFile = readSnapshotFile(latest);
  for (const file of [beforeFile, afterFile]) {
    if (file.version !== 2)
      throw new Error("verify: a snapshot from before pulls kept their details: its store has moved on");
  }
  for (const k of ["run", "managedSources", "managedChains", "range"]) {
    if (JSON.stringify(beforeFile[k]) !== JSON.stringify(afterFile[k])) {
      throw new Error(`verify: the two snapshots differ in ${k}: pull with the plan's run and range`);
    }
  }
  const all = readLogLines<LogLine>(stateDir);
  const lines = all.filter((l) => l.plan === planName);
  const last = lines.at(-1)?.time;
  if (last && last >= afterFile.takenAt)
    throw new Error("verify: this plan wrote after the latest pull began: pull again");
  const foreign = all.filter(
    (l) =>
      l.plan !== planName &&
      isWriteLine(l) &&
      l.time >= beforeFile.takenAt &&
      l.time <= (afterFile.finishedAt as string),
  );
  if (foreign.length) {
    throw new Error(
      `verify: ${[...new Set(foreign.map((l) => l.plan))].join(", ")} also wrote between these snapshots: verify each between its own pulls`,
    );
  }
  const before = readSnapshot(snapshotFile(plan.snapshot));
  const after = readSnapshot(latest);
  const uploads = new Set(plan.upload.flatMap((u) => u.ids));
  const known = new Set(before.legs.map((l) => l.legId));
  if (
    !lines.some((l) => l.call === "apply-start") &&
    !after.legs.some((l) => !known.has(l.legId) && l.importType === UPLOADED && uploads.has(l.id))
  ) {
    throw new Error(`verify: ${planName} has not been applied`);
  }
  const verification = verifyPlan({ plan, planName, before, beforeFile, after, afterFile, lines });
  const text = verifyMarkdown(verification, planName, plan.snapshot, afterName);
  const file = join(dir, `verify-${afterName}.md`);
  writeFileSync(file, text);
  console.log(text);
  console.log(`Written to ${file}`);
  return file;
}
