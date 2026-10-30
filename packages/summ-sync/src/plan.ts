// plan: the differences between a run (the desired state) and a snapshot of Summ. Pure: it reads nothing and
// calls nothing; the CLI (writePlan) reads the inputs and writes the plan. Spec: docs/specs/summ-sync.md.

import type { Config, Hold } from "./config.ts";
import { before, inPeriod } from "./dates.ts";
import { parseCsvLine, periodsOf, type Row, type RunFile } from "./run.ts";
import { type Leg, normaliseTxid } from "./snapshot.ts";
import type { AppliedEdit, LegRole, Override, Value } from "./state.ts";
import { type SummType, summBlockchain, summType } from "./summ-types.ts";

export interface PlanInput {
  files: RunFile[];
  rows: Row[];
  legs: Leg[];
  history: Map<string, string[]>;
  txHashes: Set<string>;
  config: Config;
  adopted: Map<string, string>;
  overrides: Override[];
  applyLog: AppliedEdit[];
  /** The USD price of each row in the newest upload file holding it (plans/<time>/upload). */
  uploadedPrices?: Map<string, number>;
  now: string;
  /** plan --only: the scope's entries (scopeMatch); the plan covers only the rows they match. */
  scope?: string[];
}

export interface Change {
  leg: LegRole;
  legId: string;
  field: string;
  summ: Value;
  desired: Value;
}

/** Edits of one row's legs (managed) or of Summ's own leg (categorised). */
export interface EditEntry {
  id: string;
  filed: boolean;
  actionId: string;
  changes: Change[];
  /**
   * Categorised only: the other side Summ made up to pair its leg as a transfer (importType soft-transfer), to
   * be ignored once the leg is categorised and Summ has split it off into an action of its own.
   */
  ignore?: string[];
}

export interface DeleteEntry {
  /** The row the legs belong to, or null when the run has no row for them. */
  id: string | null;
  /** The ID the legs carry in Summ. */
  summId: string;
  filed: boolean;
  legIds: string[];
  actionIds: string[];
  reason: string;
  /** Legs of other rows or sources in the same actions (deleting by action would remove them too). */
  otherLegs: number;
}

export interface UploadEntry {
  file: string;
  filed: boolean;
  ids: string[];
}

export interface ReportEntry {
  kind:
    | "no-leg"
    | "several-legs"
    | "duplicate-leg"
    | "leg-claimed-twice"
    | "not-in-snapshot"
    | "fee"
    | "ambiguous-adoption"
    | "legacy-lookalike"
    | "extra-overlap"
    | "manual-entry"
    | "other-source"
    | "foreign-pair"
    | "price-blank";
  filed: boolean;
  id?: string;
  legIds?: string[];
  /** The row's txids: the action's first, then, on an L1 payout or the L1 side of a symmetric add, the one Summ's import lists. */
  txids?: string[];
  detail: string;
}

/** A row nothing is planned for: held by the config, or in an event whose Summ actions hold a manual entry. */
export interface HeldEntry {
  kind: "hold" | "manual-pairing";
  filed: boolean;
  /** The row, or null for legs with no row in the run (then summId names them). */
  id: string | null;
  summId?: string;
  /** For manual-pairing: the manual legs; for a hold with no row: the held legs. */
  legIds?: string[];
  reason: string;
  /** What the plan would have done, left out. */
  held: string[];
}

export interface OverriddenEntry {
  kind: "captured" | "undecided" | "run-changed" | "gone";
  override: Override;
  /** For run-changed: the run's value now. */
  runNow?: Value;
}

export interface Plan {
  createdAt: string;
  managedChains: string[];
  managedSources: string[];
  filedBefore: string | null;
  timezone: string;
  periods: { from: string; to: string }[];
  /** plan --only: the scope's entries; absent for the whole run. */
  scope?: string[];
  counts: Record<string, number>;
  adopted: { legId: string; id: string }[];
  /** Extra rows left out because a run row is the same event: Summ's legs of the extra row adopt to the run row. */
  superseded: { extra: string; run: string }[];
  delete: DeleteEntry[];
  edit: EditEntry[];
  upload: UploadEntry[];
  categorise: EditEntry[];
  report: ReportEntry[];
  held: HeldEntry[];
  overridden: OverriddenEntry[];
  notes: string[];
}

export interface PlanResult {
  plan: Plan;
  /** adopted.csv after this plan: the input's plus the legs adopted now. */
  adopted: Map<string, string>;
  /** overrides.json after this plan: the input's plus the ones captured now. */
  overrides: Override[];
  /** The run's rows as planned, for upload files: a protocol row on an L1 file without its fee. */
  rows: Row[];
}

const SOFT_TRANSFER = "soft-transfer";
const IGNORED = new Set(["ignoreIn", "ignoreOut"]);

/** How far apart, in seconds, an old leg and its row may be when adopted by wallet instead of the exact second. */
export const ADOPT_WINDOW = 120;
/** How far apart, in seconds, an unadopted old leg and a row with its currency, amount and wallet are reported. */
export const LOOKALIKE_WINDOW = 86400;

const STABLE_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.[a-z-]+\.[0-9a-f]{12}$/;

// Change-history labels of the fields the plan edits (inspect_transaction, "## Change History")
const HISTORY_LABELS: Record<string, string> = {
  trade: "Category",
  quantity: "Quantity",
  timestamp: "Date",
  from: "From",
  to: "To",
  blockchain: "Blockchain",
};

/**
 * A difference below 1e-8 of the amount, or of one unit at the 8th decimal, is equal: the exporter's amounts
 * carry THORChain's 8 decimals, while Summ's own imports hold an L1 amount (e.g. ETH gas) in full.
 */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-8 * Math.max(Math.abs(a), Math.abs(b)), 1.000001e-8);
}

const seconds = (time: string) => Math.floor(Date.parse(time) / 1000);

export function same(field: string, a: Value, b: Value): boolean {
  if (a === null || b === null || a === "" || b === "") return (a ?? "") === (b ?? "");
  if (field === "quantity") return sameAmount(Number(a), Number(b));
  if (field === "timestamp") return seconds(String(a)) === seconds(String(b));
  if (field === "trade") return a === b;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

const sameCurrency = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The wallet of the leg's side: the sender of an outgoing leg, the receiver of an incoming one. */
const sameWallet = (leg: Leg, row: Row) =>
  leg.side === "outgoing" ? sameCurrency(leg.from, row.from) : sameCurrency(leg.to, row.to);
/** Legs of one tx where the user split a part off and ignored it: exactly one not ignored, and together the row's
 * amount (or its amount plus its fee). */
function isHandSplit(legs: Leg[], amount: number, gross: number): boolean {
  const total = legs.reduce((sum, l) => sum + l.quantity, 0);
  return (
    legs.length > 1 &&
    legs.filter((l) => !IGNORED.has(l.trade)).length === 1 &&
    (sameAmount(total, amount) || sameAmount(total, gross))
  );
}

const hasFee = (row: Row) => row.feeAmount !== "" && Number(row.feeAmount) !== 0;

/** Types whose amount never moves on an L1 chain: LP and savers tokens, price helpers, and what a refund kept (on an
 * L1 file the exporter writes `fee` and `lost` only for that). No import of the L1 holds them, so on an L1 file they
 * are managed (uploaded into the THORChain or Maya account). THORChain and Maya hold these types on chain, so a
 * user who leaves those chains to Summ's import leaves these rows to it too. */
export const PROTOCOL_TYPES = new Set(["receive-lp-token", "return-lp-token", "spam", "fee", "lost"]);
const NATIVE_CHAINS = new Set(["THOR", "MAYA"]);

export const isProtocolRow = (row: Row, managedChains: Set<string>) =>
  !managedChains.has(row.chain) && !NATIVE_CHAINS.has(row.chain) && PROTOCOL_TYPES.has(row.type);

/** A row the user uploads: on a managed chain, or one no import of its L1 chain can hold. */
export const isManaged = (row: Row, managedChains: Set<string>) =>
  managedChains.has(row.chain) || isProtocolRow(row, managedChains);

const FEE_COLUMNS = ["Fee Currency (Optional)", "Fee Amount (Optional)"];
const csvField = (value: string) => (/[",]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** A protocol row's fee is the L1 gas of its request (a withdraw sent from the L1 wallet): Summ's import of that
 * wallet holds the tx and its gas, so the row is matched and uploaded without it, or the gas would count twice.
 * `columns` are the indices of the fee columns in the row's file. */
function withoutFee(row: Row, columns: number[]): Row {
  const values = parseCsvLine(row.line);
  for (const i of columns) if (i >= 0) values[i] = "";
  return { ...row, feeCurrency: "", feeAmount: "", line: values.map(csvField).join(",") };
}

/** Rows plan matches to Summ's own imports: categorised rows, and protocol rows whose fee is the gas of a request
 * Summ's import holds. */
export const matchesOwnLegs = (row: Row, managedChains: Set<string>) =>
  !isManaged(row, managedChains) || (isProtocolRow(row, managedChains) && hasFee(row));

const hasQuote = (row: Row, type: SummType) => type.quote !== undefined && row.quoteCurrency !== "";
const typeOf = (row: Row) => summType(row.type) as SummType;
const txidsOf = (legs: Leg[]) =>
  legs.flatMap((l) => [...l.description.matchAll(/[0-9a-fA-F]{64}/g)].map((m) => m[0].toLowerCase()));

/** The row's base, quote and fee legs among `legs`, or why the legs do not have the row's shape. */
function shapeOf(row: Row, legs: Leg[]): { base: Leg; quote?: Leg; fee?: Leg } | string {
  const type = typeOf(row);
  const nonFee = legs.filter((l) => l.side !== "fees");
  const fees = legs.filter((l) => l.side === "fees");
  const base = nonFee.filter((l) => l.side === type.side);
  const quote = nonFee.filter((l) => l.side !== type.side);
  const wantQuote = hasQuote(row, type) ? 1 : 0;
  const wantFee = hasFee(row) ? 1 : 0;
  if (base.length !== 1 || quote.length !== wantQuote || fees.length !== wantFee) {
    return `shape: Summ has ${base.length} ${type.side}, ${quote.length} opposite and ${fees.length} fee legs; the row needs 1, ${wantQuote} and ${wantFee}`;
  }
  return { base: base[0], quote: quote[0], fee: fees[0] };
}

/**
 * Extra rows (hand-made files) that a run row now exports itself: the same txids, type, currency, amount, second
 * and wallet (the sender of an outgoing row, the receiver of an incoming one). They are left out, so Summ's legs of the extra row become legacy legs and adopt to the run row. An
 * extra row that shares a txid with run rows moving the same currency on the same side, and fits none of them in
 * the rest, is an overlap (unless its ID is in `keep`): it may be one of them in an older shape.
 */
export function supersede(
  rows: Row[],
  keep: string[] = [],
): { rows: Row[]; superseded: { extra: Row; run: Row }[]; overlaps: { extra: Row; run: Row[] }[] } {
  const own = rows.filter((r) => !r.extra);
  const superseded: { extra: Row; run: Row }[] = [];
  const overlaps: { extra: Row; run: Row[] }[] = [];
  const side = (row: Row) => summType(row.type)?.side;
  for (const extra of rows.filter((r) => r.extra && r.txids.length)) {
    const sharing = own.filter((r) => r.txids.some((t) => extra.txids.includes(t)));
    const same = sharing.filter(
      (r) =>
        extra.txids.every((t) => r.txids.includes(t)) &&
        r.type === extra.type &&
        sameCurrency(r.baseCurrency, extra.baseCurrency) &&
        sameAmount(Number(r.baseAmount), Number(extra.baseAmount)) &&
        seconds(r.timestamp) === seconds(extra.timestamp) &&
        // The wallet of the row's side; the other side is a label that changed between exports
        (side(r) === "outgoing" ? sameCurrency(r.from, extra.from) : sameCurrency(r.to, extra.to)),
    );
    const alike = sharing.filter((r) => side(r) === side(extra) && sameCurrency(r.baseCurrency, extra.baseCurrency));
    if (same.length === 1) superseded.push({ extra, run: same[0] });
    else if (alike.length && !keep.includes(extra.id)) overlaps.push({ extra, run: alike });
  }
  const left = new Set(superseded.map((s) => s.extra));
  return { rows: rows.filter((r) => !left.has(r)), superseded, overlaps };
}

export function makePlan(input: PlanInput): PlanResult {
  const { config, now } = input;
  const managedChains = new Set(config.managedChains);
  const feeColumns = new Map(
    input.files.map((f) => [f.name, FEE_COLUMNS.map((c) => parseCsvLine(f.header).indexOf(c))]),
  );
  const requestGas = input.rows.filter((r) => isProtocolRow(r, managedChains) && hasFee(r));
  const { rows, superseded, overlaps } = supersede(
    input.rows.map((r) => (requestGas.includes(r) ? withoutFee(r, feeColumns.get(r.file) ?? []) : r)),
    config.keepExtra,
  );
  const unmapped = [...new Set(rows.map((r) => r.type).filter((t) => !summType(t)))];
  if (unmapped.length) throw new Error(`No Summ type for CSV type ${unmapped.join(", ")}: add it to src/summ-types.ts`);

  const managedSources = new Set(config.managedSources);
  const periods = periodsOf(input.files);
  const inScope = (time: string) => periods.some((p) => inPeriod(time, p, config.timezone));
  const isFiled = (time: string) => config.filedBefore !== null && before(time, config.filedBefore, config.timezone);

  const adopted = new Map(input.adopted);
  // An override of a superseded extra row is kept for the run row that took its place
  const supersededBy = new Map(superseded.map((s) => [s.extra.id, s.run.id]));
  let overrides = input.overrides.map((o) =>
    supersededBy.has(o.id) ? { ...o, id: supersededBy.get(o.id) as string } : o,
  );
  const plan: Plan = {
    createdAt: now,
    managedChains: config.managedChains,
    managedSources: config.managedSources,
    filedBefore: config.filedBefore,
    timezone: config.timezone,
    periods,
    ...(input.scope ? { scope: input.scope } : {}),
    counts: {},
    adopted: [],
    superseded: [],
    delete: [],
    edit: [],
    upload: [],
    categorise: [],
    report: [],
    held: [],
    overridden: [],
    notes: [],
  };
  const legsByAction = new Map<string, Leg[]>();
  for (const leg of input.legs) legsByAction.set(leg.actionId, [...(legsByAction.get(leg.actionId) ?? []), leg]);
  const unmappedChains = new Set<string>();

  // Drift and overrides: a change the plan would make is kept as the user's when an override says so, or
  // when the action's history shows the user changed that field and apply-log has no such edit. An override
  // records the user's decision on the value they set (retainUserEdit): yes keeps it; undecided keeps it and
  // lists it on every plan; no plans the run's value. A value other than the one decided on is a new edit.
  function resolve(id: string, actionId: string, change: Change): Change | null {
    const found = overrides.find((o) => o.id === id && o.leg === change.leg && o.field === change.field);
    const decidedAgainst = found?.retainUserEdit === "no";
    const override = decidedAgainst ? undefined : found;
    if (decidedAgainst && same(change.field, change.summ, found.summ)) return change;
    const desired = override ? override.summ : change.desired;
    if (override && !same(change.field, override.run, change.desired)) {
      plan.overridden.push({ kind: "run-changed", override, runNow: change.desired });
    }
    if (same(change.field, change.summ, desired)) {
      if (override?.retainUserEdit === "undecided") plan.overridden.push({ kind: "undecided", override });
      return null;
    }
    const label = HISTORY_LABELS[change.field];
    const userEdited = (input.history.get(actionId) ?? []).some((h) => h.split(" · user · ")[1]?.includes(`${label}:`));
    const ours = input.applyLog.some(
      (e) => e.legId === change.legId && e.field === change.field && same(change.field, e.value, change.summ),
    );
    if (label && userEdited && !ours) {
      const captured: Override = {
        id,
        leg: change.leg,
        field: change.field,
        run: change.desired,
        summ: change.summ,
        seenAt: now,
        reason: "",
        retainUserEdit: "undecided",
      };
      overrides = [...overrides.filter((o) => o !== found), captured];
      plan.overridden.push({ kind: "captured", override: captured });
      return null;
    }
    return { ...change, desired };
  }

  // Prices: Summ keeps no USD figure, so the USD price a leg holds comes from the sync's own records. History lines
  // show a rounded local price, so they are counted, not matched (spec: Prices).
  function priceChange(row: Row, base: Leg): Change | null {
    const history = input.history.get(base.actionId) ?? [];
    const count = (who: string) => history.filter((h) => h.split(` · ${who} · `)[1]?.includes("Price:")).length;
    const users = count("user");
    const undos = count("undo");
    const live = users - undos;
    const actionLegs = new Set((legsByAction.get(base.actionId) ?? [base]).map((l) => l.legId));
    const lines = input.applyLog.filter((e) => e.field === "price" && actionLegs.has(e.legId));
    const own = lines.filter((e) => e.legId === base.legId).at(-1);
    let recorded: number | null = null;
    if (own && live > 0) recorded = Number(own.value);
    else if (!own && users === 0 && base.priceValueCurrency === "USD")
      recorded = input.uploadedPrices?.get(row.id) ?? null;

    const priced = row.referencePrice && row.referencePriceCurrency === "USD";
    const desired = priced ? Number(row.referencePrice) : null;
    const summ = base.price ?? null;
    const found = overrides.find((o) => o.id === row.id && o.leg === "base" && o.field === "price");
    const excess = live - lines.length;
    if (excess - (found?.retainUserEdit === "no" ? (found.excess ?? 0) : 0) > 0) {
      if (desired === null) return null;
      if (found && found.retainUserEdit !== "no" && same("price", found.summ, summ)) {
        if (!same("price", found.run, desired))
          plan.overridden.push({ kind: "run-changed", override: found, runNow: desired });
        if (found.retainUserEdit === "undecided") plan.overridden.push({ kind: "undecided", override: found });
        return null;
      }
      const captured: Override = {
        id: row.id,
        leg: "base",
        field: "price",
        run: desired,
        summ,
        seenAt: now,
        reason: "",
        retainUserEdit: "undecided",
        excess,
      };
      overrides = [...overrides.filter((o) => o !== found), captured];
      plan.overridden.push({ kind: "captured", override: captured });
      return null;
    }
    if (desired === null) {
      if (recorded !== null)
        plan.report.push({
          kind: "price-blank",
          filed: isFiled(row.timestamp),
          id: row.id,
          legIds: [base.legId],
          detail: `the row has no reference price now; Summ holds US$${recorded} from an earlier one, and an edit cannot give the price back to Summ`,
        });
      return null;
    }
    return recorded === desired ? null : { leg: "base", legId: base.legId, field: "price", summ, desired };
  }

  function compare(leg: Leg, role: LegRole, field: keyof Leg, desired: Value): Change[] {
    const summ = leg[field] as Value;
    return same(field, summ, desired) ? [] : [{ leg: role, legId: leg.legId, field, summ, desired }];
  }

  // ---- Managed rows: matched by ID (or through adopted.csv), compared, else uploaded
  plan.superseded = superseded.map((s) => ({ extra: s.extra.id, run: s.run.id }));
  // An extra row that overlaps run rows without being the same event: none of them is uploaded
  const overlapHeld = new Set<string>();
  for (const { extra, run } of overlaps) {
    for (const r of [extra, ...run]) overlapHeld.add(r.id);
    plan.report.push({
      kind: "extra-overlap",
      filed: isFiled(extra.timestamp),
      id: extra.id,
      txids: extra.txids,
      detail: `the extra row shares a txid and currency with ${run.map((r) => r.id).join(", ")} but differs in type, amount, time or wallet; if it is the same event, move its file out of extraDirs, else add its ID to keepExtra; none of these rows is uploaded`,
    });
  }

  const managedRows = rows.filter((r) => isManaged(r, managedChains));
  const rowsById = new Map(managedRows.map((r) => [r.id, r]));
  const groups = new Map<string, Leg[]>();
  for (const leg of input.legs.filter((l) => managedSources.has(l.source))) {
    const id = adopted.get(leg.legId) ?? leg.id;
    groups.set(id, [...(groups.get(id) ?? []), leg]);
  }
  const matched = new Map<string, Leg[]>();
  const legacy: [string, Leg[]][] = [];
  let outOfScope = 0;
  const deleteGroup = (summId: string, legs: Leg[], row: Row | null, reason: string) => {
    const actionIds = [...new Set(legs.map((l) => l.actionId))];
    const legIds = legs.map((l) => l.legId);
    const others = actionIds.flatMap((a) => legsByAction.get(a) ?? []).filter((l) => !legIds.includes(l.legId));
    plan.delete.push({
      id: row?.id ?? null,
      summId,
      filed: isFiled(row?.timestamp ?? legs[0].timestamp),
      legIds,
      actionIds,
      reason,
      otherLegs: others.length,
    });
  };
  for (const [id, legs] of groups) {
    if (rowsById.has(id)) matched.set(id, legs);
    else if (!legs.some((l) => inScope(l.timestamp))) outOfScope += legs.length;
    else if (STABLE_ID.test(id)) deleteGroup(id, legs, null, "no row in the run");
    else legacy.push([id, legs]);
  }

  // Adoption of legs uploaded with an old <file>:<n> ID: the one unmatched row with the same currency and amount
  // and, when the leg's description has txids, the same txids. Best first: the same type at the same second;
  // the same type within ADOPT_WINDOW in the same wallet (old exports took some times from another source);
  // another type on the same side at the same second in the same wallet, then within the window (an old type,
  // edited to the row's). Each rank is settled before the next, so a looser fit never blocks or takes a row an
  // exact fit claims. At one rank, a row several old legs claim goes to the one not ignored, when exactly one is
  // not and it fits no other row there (rows held back at a closer rank aside): the others are its ignored
  // duplicates, deleted, and take no further part in adoption or the lookalike check.
  const unmatchedRows = managedRows.filter((r) => !matched.has(r.id));
  const fits = new Map<string, { row: Row; rank: number }[]>();
  for (const [summId, legs] of legacy) {
    const txids = txidsOf(legs);
    fits.set(
      summId,
      unmatchedRows.flatMap((row) => {
        const type = typeOf(row);
        const base = legs.filter((l) => l.side === type.side);
        if (base.length !== 1) return [];
        const leg = base[0];
        if (
          !sameCurrency(leg.currency, row.baseCurrency) ||
          !sameAmount(leg.quantity, Number(row.baseAmount)) ||
          !txids.every((t) => row.txids.includes(t))
        )
          return [];
        const apart = Math.abs(seconds(leg.timestamp) - seconds(row.timestamp));
        const sameType = leg.trade === type.trade;
        if (sameType && apart === 0) return [{ row, rank: 0 }];
        if (apart > ADOPT_WINDOW || !sameWallet(leg, row)) return [];
        return [{ row, rank: sameType ? 1 : apart === 0 ? 2 : 3 }];
      }),
    );
  }
  const heldBack = new Set<string>();
  let pending = legacy;
  const ignoredGroup = new Map(legacy.map(([summId, legs]) => [summId, legs.every((l) => IGNORED.has(l.trade))]));
  // An ignored twin that yielded a row to its kept leg takes no further part: it is that leg's duplicate, deleted
  const yielded = new Map<string, string[]>();
  for (const rank of [0, 1, 2, 3]) {
    const atRank = (summId: string) =>
      (fits.get(summId) ?? []).filter((f) => f.rank === rank && !matched.has(f.row.id)).map((f) => f.row);
    // A row held back for an ambiguous leg is never taken by a looser fit
    const found = new Map(pending.map(([summId]) => [summId, atRank(summId).filter((r) => !heldBack.has(r.id))]));
    const claimants = new Map<string, string[]>();
    for (const [summId, rows] of found)
      for (const row of rows) claimants.set(row.id, [...(claimants.get(row.id) ?? []), summId]);
    for (const ids of claimants.values()) {
      const kept = ids.filter((id) => !ignoredGroup.get(id));
      // Only when the kept leg takes the row: it fits no other row at this rank
      if (ids.length < 2 || kept.length !== 1 || (found.get(kept[0]) as Row[]).length !== 1) continue;
      for (const id of ids.filter((x) => ignoredGroup.get(x))) yielded.set(id, [...(yielded.get(id) ?? []), kept[0]]);
    }
    for (const id of yielded.keys()) found.set(id, []);
    for (const [rowId, ids] of claimants)
      claimants.set(
        rowId,
        ids.filter((id) => !yielded.has(id)),
      );
    const claims = new Map([...claimants].map(([rowId, ids]) => [rowId, ids.length]));
    const settled = new Set<string>();
    for (const [summId, legs] of pending) {
      if (yielded.has(summId)) continue;
      const rows = found.get(summId) as Row[];
      const blocked = atRank(summId).filter((r) => heldBack.has(r.id) && !rows.includes(r));
      if (rows.length === 0 && blocked.length === 0) continue;
      settled.add(summId);
      if (rows.length === 1 && claims.get(rows[0].id) === 1) {
        for (const leg of legs) {
          adopted.set(leg.legId, rows[0].id);
          plan.adopted.push({ legId: leg.legId, id: rows[0].id });
        }
        matched.set(rows[0].id, legs);
        continue;
      }
      // Every row the leg fits at any rank is held back, so none of them is uploaded beside it
      const all = [...new Set((fits.get(summId) ?? []).map((f) => f.row).filter((r) => !matched.has(r.id)))];
      for (const row of all) heldBack.add(row.id);
      const fitted = [...rows, ...blocked];
      plan.report.push({
        kind: "ambiguous-adoption",
        filed: isFiled(legs[0].timestamp),
        legIds: legs.map((l) => l.legId),
        detail: `old ID ${summId} fits ${fitted.length} rows (${fitted.map((r) => r.id).join(", ")})${rows.length <= 1 ? ", which other old IDs fit too" : ""}; these rows are not uploaded${
          all.length > fitted.length
            ? ` (nor ${all
                .filter((r) => !fitted.includes(r))
                .map((r) => r.id)
                .join(", ")}, which it fits less well)`
            : ""
        }`,
      });
    }
    pending = pending.filter(([summId]) => !settled.has(summId) && !yielded.has(summId));
  }
  for (const [summId, legs] of legacy) {
    if (yielded.has(summId))
      deleteGroup(
        summId,
        legs,
        null,
        `old ID: an ignored duplicate of old ID ${(yielded.get(summId) as string[]).join(", ")}`,
      );
  }
  // An old leg no row was adopted to, while an unmatched row has its currency and amount in the same wallet within
  // LOOKALIKE_WINDOW (and its txids, if the leg names any), may be that row with another time or type: uploading
  // the row and deleting the leg could double a disposal or lose the leg's pairing, so both are reported instead.
  // A price helper (spam) counts nothing, so it doubles nothing: never a lookalike
  for (const [summId, legs] of pending) {
    const txids = txidsOf(legs);
    const lookalikes = unmatchedRows.filter(
      (row) =>
        row.type !== "spam" &&
        !matched.has(row.id) &&
        txids.every((t) => row.txids.includes(t)) &&
        legs.some(
          (l) =>
            l.side === typeOf(row).side &&
            sameCurrency(l.currency, row.baseCurrency) &&
            sameAmount(l.quantity, Number(row.baseAmount)) &&
            sameWallet(l, row) &&
            Math.abs(seconds(l.timestamp) - seconds(row.timestamp)) <= LOOKALIKE_WINDOW,
        ),
    );
    if (lookalikes.length === 0) {
      deleteGroup(
        summId,
        legs,
        null,
        "old ID: no row in the run with its txid, currency and amount at its time, or near it in its wallet",
      );
      continue;
    }
    for (const row of lookalikes) heldBack.add(row.id);
    plan.report.push({
      kind: "legacy-lookalike",
      filed: isFiled(legs[0].timestamp),
      legIds: legs.map((l) => l.legId),
      detail: `old ID ${summId} was adopted to no row, but ${lookalikes.map((r) => r.id).join(", ")} ${lookalikes.length === 1 ? "has" : "have"} its currency and amount in the same wallet within a day; neither deleted nor uploaded`,
    });
  }

  // A row whose ID is on legs of a source not in managedSources was uploaded under another account:
  // uploading it again would duplicate it
  const otherSources = new Map<string, Leg[]>();
  for (const leg of input.legs) {
    if (!managedSources.has(leg.source) && rowsById.has(leg.id))
      otherSources.set(leg.id, [...(otherSources.get(leg.id) ?? []), leg]);
  }

  const toUpload: Row[] = [];
  for (const row of managedRows) {
    const legs = matched.get(row.id);
    if (!legs) {
      const elsewhere = otherSources.get(row.id);
      if (elsewhere) {
        const sources = [...new Set(elsewhere.map((l) => l.source))].join(", ");
        plan.report.push({
          kind: "other-source",
          filed: isFiled(row.timestamp),
          id: row.id,
          legIds: elsewhere.map((l) => l.legId),
          detail: `the row is in Summ under ${sources}, not in managedSources; add the source to summ-sync.json`,
        });
      } else if (!heldBack.has(row.id) && !overlapHeld.has(row.id)) toUpload.push(row);
      continue;
    }
    const isAdopted = legs.some((l) => adopted.has(l.legId));
    // A row with no fee whose legs in Summ have one (old exports put an own-wallet transfer's fee on both
    // sides) loses only that fee leg: deleted alone, the rest compared as usual
    const lostFees = hasFee(row) ? [] : legs.filter((l) => l.side === "fees");
    const shape = shapeOf(
      row,
      legs.filter((l) => !lostFees.includes(l)),
    );
    const remake = (reason: string) => {
      deleteGroup(legs[0].id, legs, row, reason);
      toUpload.push(row);
    };
    if (typeof shape === "string") {
      remake(shape);
      continue;
    }
    // Summ split a leg of the row into another action (e.g. after a time edit of one leg): one edit cannot
    // reach both, and an upload puts the row back together
    if (new Set(legs.map((l) => l.actionId)).size > 1) {
      remake("legs in several actions");
      continue;
    }
    const { base, quote, fee } = shape;
    // An edit cannot set a description, an ID or a currency the MCP does not know (LP tokens), so a row
    // that changed in one of them is deleted and uploaded again. An adopted leg keeps its old wording.
    const currencyChanged =
      !sameCurrency(base.currency, row.baseCurrency) ||
      (quote !== undefined && !sameCurrency(quote.currency, row.quoteCurrency)) ||
      (fee !== undefined && !sameCurrency(fee.currency, row.feeCurrency));
    if (currencyChanged) {
      remake("currency changed");
      continue;
    }
    if (!isAdopted && base.description.trim() !== row.description.trim()) {
      remake("description changed");
      continue;
    }
    if (lostFees.length) deleteGroup(legs[0].id, lostFees, row, "fee leg lost: the row has no fee");
    const type = typeOf(row);
    const chain = summBlockchain(row.blockchain);
    if (row.blockchain && !chain) unmappedChains.add(row.blockchain);
    // A sell paying its fee in the asset sold is held by Summ with the fee added to the amount (the fee leg is
    // 'nettedOff'), so that gross amount matches too
    const amount = Number(row.baseAmount);
    const gross =
      amount +
      (type.trade === "sell" && hasFee(row) && sameCurrency(row.feeCurrency, row.baseCurrency)
        ? Number(row.feeAmount)
        : 0);
    const changes = [
      ...compare(base, "base", "trade", type.trade),
      ...compare(base, "base", "quantity", sameAmount(base.quantity, gross) ? gross : amount),
      ...compare(base, "base", "timestamp", row.timestamp),
      ...compare(base, "base", "from", row.from),
      ...compare(base, "base", "to", row.to),
      // Summ infers a blank blockchain from the wallet (docs/specs/assets.md), so only a value it holds is compared
      ...(chain && base.blockchain ? compare(base, "base", "blockchain", chain) : []),
      ...(quote
        ? [
            ...compare(quote, "quote", "trade", type.quote as string),
            ...compare(quote, "quote", "quantity", Number(row.quoteAmount)),
          ]
        : []),
      ...(fee ? compare(fee, "fee", "quantity", Number(row.feeAmount)) : []),
      // Every leg of the row moves with its time: Summ splits a leg left at another time into an action of its own
      ...(quote ? compare(quote, "quote", "timestamp", row.timestamp) : []),
      ...(fee ? compare(fee, "fee", "timestamp", row.timestamp) : []),
    ]
      .map((c) => resolve(row.id, base.actionId, c))
      .filter((c): c is Change => c !== null);
    const price = priceChange(row, base);
    if (price) changes.push(price);
    if (changes.length) plan.edit.push({ id: row.id, filed: isFiled(row.timestamp), actionId: base.actionId, changes });
  }

  const uploads = new Map<string, UploadEntry>();
  for (const row of toUpload) {
    const filed = isFiled(row.timestamp);
    const key = `${row.file}|${filed}`;
    const entry = uploads.get(key) ?? { file: row.file, filed, ids: [] };
    entry.ids.push(row.id);
    uploads.set(key, entry);
  }
  plan.upload = [...uploads.values()];

  // ---- Categorised rows: Summ's own leg with the row's txid, side and currency, and its amount or the
  // amount plus the fee; else the one leg with its txid, side and currency whatever the amount (Summ may hold
  // the tx gross of a gas the row does not record), the difference reported. Only its type is set
  // Summ's own imports, without the legs Summ made up to pair a send as a transfer (soft-transfer)
  const ownLegs = input.legs.filter(
    (l) => !managedSources.has(l.source) && l.importType !== "manual" && l.importType !== SOFT_TRANSFER,
  );
  const softLegs = input.legs.filter((l) => l.importType === SOFT_TRANSFER && !IGNORED.has(l.trade));
  const feeLegsOf = (leg: Leg) =>
    (legsByAction.get(leg.actionId) ?? []).filter((l) => l.side === "fees" && l.id === leg.id);
  /** The fee Summ keeps on the leg itself when the action has no fee leg for it (Binance Chain imports whose fee leg
   * Summ moved to an action of its own). */
  const inlineFeeOf = (leg: Leg) =>
    leg.feeQuantity !== undefined && feeLegsOf(leg).length === 0
      ? { quantity: leg.feeQuantity, currency: leg.feeCurrency ?? "" }
      : undefined;
  /** How a leg of Summ's import holds a row with a fee in the currency sent: the amount and a fee leg of the row's
   * fee, then the amount with the row's fee on the leg itself, then (Bitcoin-style imports) the amount plus the fee
   * and no fee leg. */
  const shapeRank = (row: Row, leg: Leg): number => {
    if (!hasFee(row) || !sameCurrency(row.feeCurrency, row.baseCurrency)) return 0;
    const fees = feeLegsOf(leg);
    const amount = Number(row.baseAmount);
    const fee = Number(row.feeAmount);
    if (sameAmount(leg.quantity, amount) && fees.length === 1 && sameAmount(fees[0].quantity, fee)) return 3;
    const inline = inlineFeeOf(leg);
    if (
      sameAmount(leg.quantity, amount) &&
      inline &&
      sameCurrency(inline.currency, row.feeCurrency) &&
      sameAmount(inline.quantity, fee)
    )
      return 2;
    // A fee within the amount's tolerance cannot be told from no fee
    if (sameAmount(leg.quantity, amount + fee) && !sameAmount(amount, amount + fee) && fees.length === 0) return 1;
    return 0;
  };
  /** The one leg among several that fit whose shape ranks first, or undefined when none does or two tie. */
  const bestShape = (row: Row, legs: Leg[]): Leg | undefined => {
    const ranked = legs
      .map((l) => ({ l, rank: IGNORED.has(l.trade) ? -1 : shapeRank(row, l) }))
      .sort((a, b) => b.rank - a.rank);
    return ranked[0].rank > 0 && ranked[0].rank > ranked[1].rank ? ranked[0].l : undefined;
  };
  const legClaims = new Map<string, string[]>();
  const categorised: [Row, Leg][] = [];
  const claim = (row: Row, leg: Leg) => {
    categorised.push([row, leg]);
    legClaims.set(leg.legId, [...(legClaims.get(leg.legId) ?? []), row.id]);
  };
  // Rows with no leg of their amount, and the one leg with their txid, side and currency: matched once every
  // exact match has claimed its leg, so a looser fit never takes a leg another row has exactly
  const byTxid: [Row, Leg][] = [];
  const duplicates: { row: Row; best: Leg; others: Leg[] }[] = [];
  for (const row of rows.filter((r) => !isManaged(r, managedChains))) {
    const type = typeOf(row);
    const amount = Number(row.baseAmount);
    const gross = amount + (hasFee(row) && sameCurrency(row.feeCurrency, row.baseCurrency) ? Number(row.feeAmount) : 0);
    const withTxid = ownLegs.filter(
      (l) =>
        l.side === type.side && row.txids.includes(normaliseTxid(l.id)) && sameCurrency(l.currency, row.baseCurrency),
    );
    const found = withTxid.filter((l) => sameAmount(l.quantity, amount) || sameAmount(l.quantity, gross));
    const filed = isFiled(row.timestamp);
    // Summ may hold the tx twice (a later import of the wallet, with the gas inside the amount): the leg with the
    // row's shape is the row's, the other reported
    const best = found.length > 1 ? bestShape(row, found) : undefined;
    if (found.length === 1) claim(row, found[0]);
    else if (best) {
      claim(row, best);
      duplicates.push({ row, best, others: found.filter((l) => l !== best && !IGNORED.has(l.trade)) });
    } else if (found.length === 0 && withTxid.length === 1) byTxid.push([row, withTxid[0]]);
    // A gas the user split off the leg by hand and ignored: the legs together hold the row's amount, and the one
    // not ignored is the row's
    else if (found.length === 0 && isHandSplit(withTxid, amount, gross))
      byTxid.push([row, withTxid.find((l) => !IGNORED.has(l.trade)) as Leg]);
    else if (found.length > 1) {
      plan.report.push({
        kind: "several-legs",
        filed,
        id: row.id,
        legIds: found.map((l) => l.legId),
        detail: `${found.length} legs of Summ's imports fit the row`,
      });
    } else if (
      row.txids.length &&
      !row.txids.some((t) => ownLegs.some((l) => normaliseTxid(l.id) === t)) &&
      row.txids.some((t) => input.txHashes.has(t))
    ) {
      plan.report.push({
        kind: "not-in-snapshot",
        filed,
        id: row.id,
        txids: row.txids,
        detail: "Summ lists the txid but the snapshot has no detail for it: pull with the run dir",
      });
    } else {
      plan.report.push({
        kind: "no-leg",
        filed,
        id: row.id,
        txids: row.txids,
        detail: row.txids.length
          ? "no leg of Summ's imports has the row's txid, side, currency and amount"
          : "the row's description has no txid",
      });
    }
  }
  const fallbacks = new Map<string, Row[]>();
  for (const [row, leg] of byTxid) fallbacks.set(leg.legId, [...(fallbacks.get(leg.legId) ?? []), row]);
  for (const [row, leg] of byTxid) {
    const filed = isFiled(row.timestamp);
    if (legClaims.has(leg.legId)) {
      plan.report.push({
        kind: "no-leg",
        filed,
        id: row.id,
        txids: row.txids,
        detail: `the one leg with the row's txid, side and currency (${leg.quantity}) fits another row exactly`,
      });
      continue;
    }
    const rivals = (fallbacks.get(leg.legId) as Row[]).filter((r) => r.id !== row.id);
    if (rivals.length) {
      plan.report.push({
        kind: "no-leg",
        filed,
        id: row.id,
        txids: row.txids,
        legIds: [leg.legId],
        detail: `the one leg with the row's txid, side and currency (${leg.quantity}) is the only one for ${rivals.map((r) => r.id).join(", ")} too, at no row's amount: not guessed`,
      });
      continue;
    }
    claim(row, leg);
    // The difference beyond the nearer of the row's amount and its amount plus a fee in the same currency
    const amount = Number(row.baseAmount);
    const gross = amount + (hasFee(row) && sameCurrency(row.feeCurrency, row.baseCurrency) ? Number(row.feeAmount) : 0);
    const near = Math.abs(leg.quantity - gross) < Math.abs(leg.quantity - amount) ? gross : amount;
    const diff = Number((leg.quantity - near).toFixed(10));
    const of =
      near === amount ? `the row's ${row.baseAmount}` : `the row's ${row.baseAmount} plus its fee ${row.feeAmount}`;
    plan.report.push({
      kind: "fee",
      filed,
      id: row.id,
      legIds: [leg.legId],
      detail: `matched by txid: Summ's leg holds ${Number(leg.quantity.toFixed(10))} ${leg.currency}, ${diff > 0 ? "+" : ""}${diff} beyond ${of}; the amount is not edited`,
    });
  }
  // Reported once every row has claimed its leg: a leg another row takes is that row's, not a duplicate
  for (const { row, best, others } of duplicates) {
    const unclaimed = others.filter((l) => !legClaims.has(l.legId));
    if (!unclaimed.length) continue;
    plan.report.push({
      kind: "duplicate-leg",
      filed: isFiled(row.timestamp),
      id: row.id,
      legIds: unclaimed.map((l) => l.legId),
      detail: `Summ's imports hold the tx ${unclaimed.length + 1} times: the leg with the row's shape (${best.quantity} ${best.currency}${feeLegsOf(best).length ? " and a fee leg" : inlineFeeOf(best) ? " and a fee on the leg" : ", no fee leg"}) is the row's; ${unclaimed.map((l) => `${l.quantity} ${l.currency} (${l.trade})`).join(", ")} may count it twice: resolve it in Summ`,
    });
  }
  // A protocol row's fee left out counts only where Summ's import holds its request: reported when no leg of the
  // imports has the row's txid in the fee's currency
  const kept = new Set(rows.map((r) => r.id));
  for (const row of requestGas.filter((r) => kept.has(r.id))) {
    const filed = isFiled(row.timestamp);
    if (ownLegs.some((l) => row.txids.includes(normaliseTxid(l.id)) && sameCurrency(l.currency, row.feeCurrency)))
      continue;
    if (row.txids.some((t) => input.txHashes.has(t))) {
      plan.report.push({
        kind: "not-in-snapshot",
        filed,
        id: row.id,
        txids: row.txids,
        detail: "Summ lists the txid but the snapshot has no detail for it: pull with the run dir",
      });
    } else {
      plan.report.push({
        kind: "fee",
        filed,
        id: row.id,
        txids: row.txids,
        detail: `the row's fee of ${row.feeAmount} ${row.feeCurrency} is its request's gas, uploaded without it, but no leg of Summ's imports has its txid in ${row.feeCurrency}: the gas is counted nowhere`,
      });
    }
  }
  for (const [row, leg] of categorised) {
    const filed = isFiled(row.timestamp);
    const rowIds = legClaims.get(leg.legId) as string[];
    if (rowIds.length > 1) {
      plan.report.push({
        kind: "leg-claimed-twice",
        filed,
        id: row.id,
        legIds: [leg.legId],
        detail: `the leg fits rows ${rowIds.join(", ")}`,
      });
      continue;
    }
    const changes: Change[] = [...compare(leg, "base", "trade", typeOf(row).trade)];
    const feeLegs = feeLegsOf(leg);
    const inline = inlineFeeOf(leg);
    if (hasFee(row) && shapeRank(row, leg) !== 1) {
      // Summ's import read the fee from the chain; the row's may be a source's estimate (THORNode's gas of an EVM
      // inbound is its max fee), so a difference is reported, never edited. A leg of the amount plus the fee
      // with no fee leg (a Bitcoin-style import) holds the row's fee: nothing to report
      if (feeLegs.length === 1 && sameCurrency(feeLegs[0].currency, row.feeCurrency)) {
        if (!sameAmount(feeLegs[0].quantity, Number(row.feeAmount)))
          plan.report.push({
            kind: "fee",
            filed,
            id: row.id,
            legIds: [feeLegs[0].legId],
            detail: `Summ's import holds a fee of ${Number(feeLegs[0].quantity.toFixed(12))} ${feeLegs[0].currency}, the row ${row.feeAmount}; the fee is not edited`,
          });
      } else if (inline && sameCurrency(inline.currency, row.feeCurrency)) {
        if (!sameAmount(inline.quantity, Number(row.feeAmount)))
          plan.report.push({
            kind: "fee",
            filed,
            id: row.id,
            legIds: [leg.legId],
            detail: `Summ's import holds a fee of ${Number(inline.quantity.toFixed(12))} ${inline.currency} on the leg, the row ${row.feeAmount}; the fee is not edited`,
          });
      } else
        plan.report.push({
          kind: "fee",
          filed,
          id: row.id,
          legIds: feeLegs.map((l) => l.legId),
          detail: `the row has a fee of ${row.feeAmount} ${row.feeCurrency}; Summ has ${feeLegs.length} fee legs${feeLegs.length === 1 ? ` in ${feeLegs[0].currency}` : ""}`,
        });
    } else if (feeLegs.some((l) => l.quantity !== 0)) {
      plan.report.push({
        kind: "fee",
        filed,
        id: row.id,
        legIds: feeLegs.map((l) => l.legId),
        detail: "the row has no fee; Summ has a fee leg",
      });
    } else if (inline) {
      plan.report.push({
        kind: "fee",
        filed,
        id: row.id,
        legIds: [leg.legId],
        detail: "the row has no fee; Summ has a fee on the leg",
      });
    }
    const resolved = changes.map((c) => resolve(row.id, leg.actionId, c)).filter((c): c is Change => c !== null);
    // A row that is not a plain send or receive leaves Summ's made-up other side of the transfer counted
    // on its own once categorised: it is ignored
    const trade = typeOf(row).trade;
    const ignore =
      trade === "withdrawal" || trade === "deposit"
        ? []
        : softLegs
            .filter((l) => row.txids.includes(normaliseTxid(l.id)) && sameCurrency(l.currency, leg.currency))
            .map((l) => l.legId);
    if (resolved.length || ignore.length) {
      plan.categorise.push({
        id: row.id,
        filed,
        actionId: leg.actionId,
        changes: resolved,
        ...(ignore.length ? { ignore } : {}),
      });
    }
  }

  // ---- Held: nothing is planned for a row the config holds (a decision pending outside the sync), nor for the rows
  // of an event (rows linked by a shared txid) when a Summ action of theirs holds a manual entry, or a manual entry
  // names one of their txids: the user's own pairing or stand-in, which a delete, a split, an upload or a categorise
  // beside it could break or double. Listed instead.
  const holdOf = new Map<string, HeldEntry>();
  const runRows = new Map(rows.map((r) => [r.id, r]));
  for (const h of config.hold) {
    if (h.txid !== undefined) {
      const txid = normaliseTxid(h.txid);
      const named = rows.filter((r) => r.txids.includes(txid));
      for (const row of named.filter((r) => !holdOf.has(r.id)))
        holdOf.set(row.id, { kind: "hold", filed: isFiled(row.timestamp), id: row.id, reason: h.reason, held: [] });
      if (!named.length) plan.notes.push(`hold: no row with txid ${txid} in the run`);
      continue;
    }
    const row = runRows.get(h.id);
    if (row) holdOf.set(h.id, { kind: "hold", filed: isFiled(row.timestamp), id: h.id, reason: h.reason, held: [] });
    else if (!STABLE_ID.test(h.id) || inScope(h.id.slice(0, 24))) plan.notes.push(`hold: no row ${h.id} in the run`);
  }
  const manualIn = (actionIds: string[]) =>
    [...new Set(actionIds)].flatMap((a) => (legsByAction.get(a) ?? []).filter((l) => l.importType === "manual"));
  const pairingReason = (manual: Leg[]) =>
    `a manual entry is in a Summ action of this event or names its txid (${manual.map((l) => `${l.quantity} ${l.currency}`).join(", ")}): the user's pairing; resolve it in Summ`;
  const manualNaming = new Map<string, Leg[]>();
  for (const leg of input.legs.filter((l) => l.importType === "manual")) {
    for (const t of new Set(txidsOf([{ ...leg, description: [leg.description, ...leg.comments].join(" ") }])))
      manualNaming.set(t, [...(manualNaming.get(t) ?? []), leg]);
  }
  const legsOfRow = new Map(matched);
  for (const [row, leg] of categorised) legsOfRow.set(row.id, [...(legsOfRow.get(row.id) ?? []), leg]);
  const rowsByTxid = new Map<string, Row[]>();
  // A placeholder txid (all zeros, as in some old exports' outbounds) links nothing
  for (const r of rows)
    for (const t of r.txids.filter((x) => !/^0+$/.test(x))) rowsByTxid.set(t, [...(rowsByTxid.get(t) ?? []), r]);
  const seen = new Set<string>();
  const eventOf = new Map<string, Row[]>();
  for (const start of rows) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    const event: Row[] = [];
    for (const queue = [start]; queue.length;) {
      const r = queue.pop() as Row;
      event.push(r);
      for (const o of r.txids.flatMap((t) => rowsByTxid.get(t) ?? [])) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        queue.push(o);
      }
    }
    for (const r of event) eventOf.set(r.id, event);
    const actions = [
      ...event.flatMap((r) => (legsOfRow.get(r.id) ?? []).map((l) => l.actionId)),
      ...plan.delete.filter((d) => d.id !== null && event.some((r) => r.id === d.id)).flatMap((d) => d.actionIds),
    ];
    const named = event.flatMap((r) =>
      r.txids.filter((t) => !/^0+$/.test(t)).flatMap((t) => manualNaming.get(t) ?? []),
    );
    const manual = [...new Map([...manualIn(actions), ...named].map((l) => [l.legId, l])).values()];
    if (!manual.length) continue;
    for (const r of event) {
      if (!holdOf.has(r.id))
        holdOf.set(r.id, {
          kind: "manual-pairing",
          filed: isFiled(r.timestamp),
          id: r.id,
          legIds: manual.map((l) => l.legId),
          reason: pairingReason(manual),
          held: [],
        });
    }
  }
  const fields = (e: EditEntry) =>
    [
      ...e.changes.map((c) => `${c.leg} ${c.field} ${c.summ} -> ${c.desired}`),
      ...(e.ignore ?? []).map((l) => `ignore made-up leg ${l}`),
    ].join("; ");
  const legById = new Map(input.legs.map((l) => [l.legId, l]));
  const legsOf = (legIds: string[]) => legIds.map((id) => legById.get(id) as Leg);
  const holdOfLegs = (d: DeleteEntry): Hold | undefined =>
    config.hold.find((h) =>
      h.txid === undefined ? h.id === d.summId : txidsOf(legsOf(d.legIds)).includes(normaliseTxid(h.txid)),
    );
  plan.delete = plan.delete.filter((d) => {
    const h = d.id !== null ? holdOf.get(d.id) : undefined;
    const gone = d.id === null ? holdOfLegs(d) : undefined;
    if (h) h.held.push(`delete (${d.reason})`);
    else if (gone) {
      // A held row that left the run: its legs stay until the hold is lifted
      plan.held.push({
        kind: "hold",
        filed: d.filed,
        id: null,
        summId: d.summId,
        legIds: d.legIds,
        reason: gone.reason,
        held: [`delete (${d.reason})`],
      });
      return false;
    } else if (d.id === null) {
      const manual = manualIn(d.actionIds);
      if (manual.length)
        plan.held.push({
          kind: "manual-pairing",
          filed: d.filed,
          id: null,
          summId: d.summId,
          legIds: manual.map((l) => l.legId),
          reason: pairingReason(manual),
          held: [`delete (${d.reason})`],
        });
      return !manual.length;
    }
    return !h;
  });
  for (const [section, label] of [
    ["edit", "edit"],
    ["categorise", "categorise"],
  ] as const) {
    plan[section] = plan[section].filter((e) => {
      const h = holdOf.get(e.id);
      if (h) h.held.push(`${label} ${fields(e)}`);
      return !h;
    });
  }
  for (const u of plan.upload) {
    for (const id of u.ids) holdOf.get(id)?.held.push(`upload into ${u.file}`);
    u.ids = u.ids.filter((id) => !holdOf.has(id));
  }
  plan.upload = plan.upload.filter((u) => u.ids.length);
  plan.held.unshift(...[...holdOf.values()].filter((h) => h.kind === "hold" || h.held.length));

  // ---- Foreign pairs: a managed row Summ paired with a leg of its own imports that no row of the row's event names.
  // Summ's matcher can take any leg of about the row's value (a bridge receive for a swap's payout) and retype it;
  // the plan sees nothing else wrong there (the leg is no row's), so it is reported with the matcher's changes.
  // Not for a held row (held by the config or in a manual-pairing event: left alone on purpose), nor for a leg that is the event's own categorised
  // row without its txid (a payout the exporter could not name): the same side, currency and amount
  const claimedRows = new Set(categorised.map(([r]) => r.id));
  for (const [id, legs] of matched) {
    if (holdOf.has(id)) continue;
    const event = eventOf.get(id) as Row[];
    const named = new Set(event.flatMap((r) => r.txids));
    const unnamed = event.filter((r) => !isManaged(r, managedChains) && !claimedRows.has(r.id));
    const actionIds = [...new Set(legs.map((l) => l.actionId))];
    const foreign = actionIds
      .flatMap((a) => legsByAction.get(a) ?? [])
      .filter(
        (l) =>
          !managedSources.has(l.source) &&
          l.importType !== "manual" &&
          l.importType !== SOFT_TRANSFER &&
          !IGNORED.has(l.trade),
      )
      // Only a leg with an on-chain txid: an exchange's own record (no txid) pairs with a send to it and no row names it
      .filter(
        (l) =>
          /^[0-9a-f]{64}$/.test(normaliseTxid(l.id)) &&
          !/^0+$/.test(normaliseTxid(l.id)) &&
          !named.has(normaliseTxid(l.id)),
      )
      .filter(
        (l) =>
          !unnamed.some(
            (r) =>
              typeOf(r).side === l.side &&
              sameCurrency(r.baseCurrency, l.currency) &&
              sameAmount(l.quantity, Number(r.baseAmount)),
          ),
      );
    if (!foreign.length) continue;
    const matcher = actionIds
      .flatMap((a) => input.history.get(a) ?? [])
      .filter((h) => h.includes("transactionMatching"));
    const row = rowsById.get(id) as Row;
    plan.report.push({
      kind: "foreign-pair",
      filed: isFiled(row.timestamp),
      id,
      legIds: foreign.map((l) => l.legId),
      txids: [...new Set(foreign.map((l) => normaliseTxid(l.id)))],
      detail: `Summ paired the row with ${foreign.map((l) => `${l.trade} ${l.quantity} ${l.currency} (tx ${l.id})`).join(", ")}, which no row of its event names${matcher.length ? `; its matcher changed: ${matcher.join("; ")}` : ""}. Categorise the row's own other side first, then set the leg back`,
    });
  }

  // ---- Manual entries repeating a row's txid
  const txidRows = new Map<string, string>();
  for (const row of rows) for (const t of row.txids) txidRows.set(t, row.id);
  for (const leg of input.legs.filter((l) => l.importType === "manual")) {
    const text = [leg.description, ...leg.comments].join(" ");
    for (const m of text.matchAll(/[0-9a-fA-F]{64}/g)) {
      const id = txidRows.get(m[0].toLowerCase());
      if (id)
        plan.report.push({
          kind: "manual-entry",
          filed: isFiled(leg.timestamp),
          id,
          legIds: [leg.legId],
          txids: [m[0].toLowerCase()],
          detail: "a manual entry names the row's txid",
        });
    }
  }

  // ---- Overrides whose row is gone from the run
  const runIds = new Set(rows.map((r) => r.id));
  for (const override of overrides) if (!runIds.has(override.id)) plan.overridden.push({ kind: "gone", override });

  if (input.scope) narrow(plan, input.scope, rows, legsOf, eventOf);

  if (unmappedChains.size)
    plan.notes.push(`Blockchain not compared (no Summ id in src/summ-types.ts): ${[...unmappedChains].join(", ")}`);
  plan.counts = {
    rows: rows.length,
    supersededExtraRows: superseded.length,
    managedRows: managedRows.length,
    categorisedRows: rows.length - managedRows.length,
    managedLegs: input.legs.filter((l) => managedSources.has(l.source)).length,
    managedLegsOutOfScope: outOfScope,
    matchedRows: matched.size,
    adoptedLegs: plan.adopted.length,
    deletes: plan.delete.length,
    edits: plan.edit.length,
    uploads: plan.upload.reduce((n, u) => n + u.ids.length, 0),
    categorise: plan.categorise.length,
    reports: plan.report.length,
    held: plan.held.length,
    overridden: plan.overridden.length,
    ...(input.scope ? { scopedRows: rows.filter((r) => scopeMatch(input.scope as string[], r)).length } : {}),
  };
  return { plan, adopted, overrides, rows };
}

const TXID = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Whether a scope entry (plan --only) matches a row: one with that ID, one naming that txid, or else one whose CSV
 * line holds the text (e.g. `ThorSavers.` or a wallet address). Legs with no row match by their ID in Summ, a
 * txid their description names, or the text in it.
 */
export function scopeMatch(entries: string[], row: Row | null, summId = "", legs: Leg[] = []): boolean {
  return entries.some((e) =>
    row
      ? row.id === e || (TXID.test(e) ? row.txids.includes(normaliseTxid(e)) : row.line.includes(e))
      : summId === e ||
        (TXID.test(e) ? txidsOf(legs).includes(normaliseTxid(e)) : legs.some((l) => l.description.includes(e))),
  );
}

/** One scope entry per line of a scope file; blank lines are left out, and a comment: `#` at the start or after a space. */
export function parseScope(text: string): string[] {
  const entries = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
        .filter((l) => l !== ""),
    ),
  ];
  const zero = entries.find((e) => /^(0x)?0{64}$/.test(e));
  if (zero) throw new Error(`scope: ${zero} is a placeholder txid, which links no rows`);
  return entries;
}

/**
 * A scoped plan (plan --only): only what concerns the rows the scope matches, and legs with no row that it matches or
 * that name a txid of a row in scope (the same tx). Everything else is left for another plan, so a decision on a row
 * outside the scope (an override set to no that depends on other changes of the full plan) is not carried early. Legs
 * that also name the tx of a row outside the scope that the full plan uploads are not deleted, and the rows of the
 * scope and legs naming that tx, or any other tx of theirs, wait with them: a scoped apply leaves such a tx as it is
 * rather than dropping or doubling a side of it.
 */
function narrow(
  plan: Plan,
  entries: string[],
  rows: Row[],
  legsOf: (legIds: string[]) => Leg[],
  eventOf: Map<string, Row[]>,
): void {
  const matched = new Set(rows.filter((r) => scopeMatch(entries, r)).map((r) => r.id));
  const real = (t: string) => !/^0+$/.test(t);
  const txids = new Set(rows.filter((r) => matched.has(r.id)).flatMap((r) => r.txids.filter(real)));
  const uploads = new Set(plan.upload.flatMap((u) => u.ids));
  const outside = new Map<string, Set<string>>();
  for (const r of rows.filter((r) => !matched.has(r.id) && uploads.has(r.id)))
    for (const t of r.txids.filter(real)) outside.set(t, (outside.get(t) ?? new Set()).add(r.id));
  /** Legs with no row in scope; with `deleting`, those that also name the tx of a row outside it are left. */
  const legsIn = (summId: string, legIds: string[], deleting: boolean) => {
    if (entries.includes(summId)) return true;
    const legs = legsOf(legIds);
    const named = txidsOf(legs).filter(real);
    if (!scopeMatch(entries, null, "", legs) && !named.some((t) => txids.has(t))) return false;
    const others = [...new Set(named.flatMap((t) => [...(outside.get(t) ?? [])]))];
    if (!deleting || !others.length) return true;
    left.push({ summId, legs, txids: named.filter((t) => txids.has(t)) });
    plan.notes.push(
      `scope: legs ${summId} are not deleted: they also name the tx of ${others.join(", ")}, outside the scope (add it to the scope)`,
    );
    return false;
  };
  const left: { summId: string; legs: Leg[]; txids: string[] }[] = [];
  plan.delete = plan.delete.filter((d) => d.id !== null || legsIn(d.summId, d.legIds, true));
  // The rows of the scope naming a tx whose legs are left, and other legs with no row naming it, wait with them, and
  // so does every other tx of theirs, until no more join
  const leftTx = new Set(left.flatMap((l) => l.txids));
  const waitRows = new Set<string>();
  const waitLegs = new Map<string, { summId: string; legs: Leg[] }>();
  for (let grew = true; grew;) {
    grew = false;
    const join = (named: string[]) => {
      for (const t of named.filter(real)) leftTx.add(t);
      grew = true;
    };
    for (const r of rows.filter((r) => matched.has(r.id) && !waitRows.has(r.id)))
      if (r.txids.some((t) => leftTx.has(t))) {
        waitRows.add(r.id);
        join(r.txids);
      }
    for (const d of plan.delete.filter(
      (d) => d.id === null && !waitLegs.has(d.summId) && !entries.includes(d.summId),
    )) {
      const legs = legsOf(d.legIds);
      const named = txidsOf(legs);
      if (named.some((t) => leftTx.has(t))) {
        waitLegs.set(d.summId, { summId: d.summId, legs });
        join(named);
      }
    }
  }
  const waiting = [...waitRows, ...waitLegs.keys()];
  if (waiting.length) plan.notes.push(`scope: ${waiting.join(", ")} wait with the legs of their tx left above`);
  // Legs an entry names by their ID in Summ are deleted all the same: said, as their tx's rows may not be uploaded
  for (const d of plan.delete.filter((d) => d.id === null && entries.includes(d.summId))) {
    const named = txidsOf(legsOf(d.legIds)).filter(real);
    const others = [...new Set(named.flatMap((t) => [...(outside.get(t) ?? [])]))];
    if (named.some((t) => leftTx.has(t)) || others.length)
      plan.notes.push(
        named.some((t) => leftTx.has(t))
          ? `scope: legs ${d.summId} are deleted as named, though their tx waits`
          : `scope: legs ${d.summId} are deleted as named, though ${others.join(", ")} of their tx, outside the scope, are not uploaded by this plan`,
      );
  }
  const ids = new Set([...matched].filter((id) => !waitRows.has(id)));
  plan.delete = plan.delete.filter((d) => (d.id !== null ? ids.has(d.id) : !waitLegs.has(d.summId)));
  plan.adopted = plan.adopted.filter((a) => ids.has(a.id));
  plan.superseded = plan.superseded.filter((s) => ids.has(s.run));
  plan.edit = plan.edit.filter((e) => ids.has(e.id));
  for (const u of plan.upload) u.ids = u.ids.filter((id) => ids.has(id));
  plan.upload = plan.upload.filter((u) => u.ids.length);
  // Apply categorises once Summ holds the uploads it pairs with: a categorise whose event has an upload this plan
  // does not carry waits for the plan that uploads it
  const carried = new Set(plan.upload.flatMap((u) => u.ids));
  plan.categorise = plan.categorise.filter((e) => {
    if (!ids.has(e.id)) return false;
    const waits = (eventOf.get(e.id) ?? []).filter((r) => uploads.has(r.id) && !carried.has(r.id));
    if (waits.length)
      plan.notes.push(
        `scope: categorise of ${e.id} waits for the upload of ${waits.map((r) => r.id).join(", ")}, not in this plan`,
      );
    return !waits.length;
  });
  // A report without a row (an old ID fitting several rows) is kept when it names a row of the scope
  plan.report = plan.report.filter((r) =>
    r.id !== undefined ? ids.has(r.id) : [...ids].some((id) => r.detail.includes(id)),
  );
  plan.held = plan.held.filter((h) =>
    h.id !== null ? ids.has(h.id) : legsIn(h.summId as string, h.kind === "hold" ? (h.legIds ?? []) : [], false),
  );
  plan.overridden = plan.overridden.filter((o) => ids.has(o.override.id));
  const legEntries = [
    ...[...plan.delete, ...plan.held]
      .filter((d) => d.id === null)
      .map((d) => ({ summId: d.summId as string, legs: legsOf(d.legIds ?? []) })),
    ...left,
    ...waitLegs.values(),
  ];
  for (const e of entries)
    if (!rows.some((r) => scopeMatch([e], r)) && !legEntries.some((l) => scopeMatch([e], null, l.summId, l.legs)))
      plan.notes.push(`scope: ${e} matches nothing in the run or Summ's legs with no row`);
}
