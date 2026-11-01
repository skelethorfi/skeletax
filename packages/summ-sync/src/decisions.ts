// What a plan's deletes leave behind. The plan compares Summ with the run row by row, so it cannot see that an old
// trade it removes was what a kept entry sold from. This reads the finished plan and says so, with the options. It
// changes nothing in the plan: a person or agent decides, by adding an option's config and planning again.
//
// Old legs usually hold no txid, so legs are linked by currency, amount and time: strong for exact amounts, not proof.

import type { DeleteManualEntry, Hold } from "./config.ts";
import { type Plan, sameAmount, sameCurrency, txidsNamedBy, txidsOf } from "./plan.ts";
import type { Row } from "./run.ts";
import { type Leg, normaliseTxid } from "./snapshot.ts";
import { summType } from "./summ-types.ts";

export interface DecisionOption {
  key: "a" | "b";
  /** Its entries span filed and current years, which a plan takes one kind at a time. */
  spans?: boolean;
  title: string;
  /** What the next plan does with this option. */
  result: string;
  /** What to add to summ-sync.json. Empty: nothing to add. */
  config: { deleteManualEntries?: DeleteManualEntry[]; hold?: Hold[] };
}

export interface Decision {
  /** Numbered within this plan. */
  id: string;
  kind: "swap-changed" | "lost-disposal" | "lost-acquisition" | "acquired-twice";
  filed: boolean;
  title: string;
  /** What the plan does and what it leaves, one line each. */
  lines: string[];
  options: DecisionOption[];
}

/** An acquisition the plan removes with nothing adding it back, and kept legs that may have sold from it. */
export interface PlanCheck {
  summId: string;
  removed: string;
  kept: string[];
}

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
/** Legs and rows of one event: an old CSV's lines and the run's rows sit seconds apart. */
const NEAR = 5 * MINUTE;
const WEEK = 7 * DAY;
/** An old line and a row can differ by a swap's fee. */
const FEE_APART = 0.01;

const TRANSFER_IN = new Set(["deposit", "bridgeIn", "failedIn", "spamIn"]);
// Moves out without being sold: staking, collateral and positions, whose treatment is Summ's to say
const TRANSFER_OUT = new Set([
  "withdrawal",
  "bridgeOut",
  "failedOut",
  "fee",
  "approval",
  "stakingDeposit",
  "collateral",
  "increasePositionWithdrawal",
  "loanRepayment",
]);
const IGNORED = new Set(["ignoreIn", "ignoreOut"]);

/** Comes in, and acquires nothing even alone. */
const NOTHING_IN = new Set(["failedIn", "spamIn"]);

const isAcquisition = (trade: string) => !TRANSFER_IN.has(trade) && !IGNORED.has(trade);
const isDisposal = (trade: string) => !TRANSFER_OUT.has(trade) && !IGNORED.has(trade);
const gap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b));

interface Move {
  side: "incoming" | "outgoing";
  trade: string;
  currency: string;
  amount: number;
}

/** What a row names: its base and its quote on the other side. */
function movesOf(r: Row): Move[] {
  const type = summType(r.type);
  if (!type) return [];
  const moves: Move[] = [
    { side: type.side, trade: type.trade, currency: r.baseCurrency, amount: Number(r.baseAmount) },
  ];
  if (r.quoteCurrency)
    moves.push({
      side: type.side === "incoming" ? "outgoing" : "incoming",
      trade: type.quote ?? "",
      currency: r.quoteCurrency,
      amount: Number(r.quoteAmount),
    });
  return moves;
}

/** What a row brings into Summ: a bridge's quote only names the other asset, and makes no leg. */
function legsMade(r: Row): Move[] {
  const moves = movesOf(r);
  return summType(r.type)?.quote ? moves : moves.slice(0, 1);
}

const sameMove = (l: Leg, m: Move) => sameCurrency(l.currency, m.currency) && sameAmount(l.quantity, m.amount);
const legText = (l: Leg) => `${l.trade} ${l.quantity} ${l.currency}`;

export function decisionsOf(
  plan: Plan,
  legs: Leg[],
  rows: Row[],
  isFiled: (time: string) => boolean = () => false,
): { decisions: Decision[]; checks: PlanCheck[] } {
  const deletes = plan.delete.filter((d) => !d.manual);
  const legById = new Map(legs.map((l) => [l.legId, l]));
  const removed = new Set(plan.delete.flatMap((d) => d.legIds));
  const legsOfDelete = new Map(
    deletes.map((d) => [d, d.legIds.map((id) => legById.get(id) as Leg).filter((l) => l && l.side !== "fees")]),
  );
  const deleteOfLeg = new Map([...legsOfDelete].flatMap(([d, ls]) => ls.map((l) => [l.legId, d] as const)));
  const uploads = new Set(plan.upload.flatMap((u) => u.ids));
  const heldRows = new Set(plan.held.flatMap((h) => (h.id === null ? [] : [h.id])));
  const adopted = new Map(plan.adopted.map((a) => [a.legId, a.id]));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const rowOfLeg = (l: Leg) => rowById.get(adopted.get(l.legId) ?? l.id);
  const typeChange = new Map(
    [...plan.edit, ...plan.categorise].flatMap((e) =>
      e.changes.filter((c) => c.field === "trade").map((c) => [c.legId as string, String(c.desired)] as const),
    ),
  );
  /** The type a kept leg ends up with: only what this plan changes, since a retained override or a scope can keep it. */
  const tradeAfter = (l: Leg) => typeChange.get(l.legId) ?? l.trade;
  const categorisedRows = new Set(plan.categorise.map((e) => e.id));
  const kept = legs.filter(
    (l) => !removed.has(l.legId) && l.side !== "fees" && !IGNORED.has(l.trade) && l.importType !== "soft-transfer",
  );
  const keptByAction = new Map<string, Leg[]>();
  for (const l of kept) keptByAction.set(l.actionId, [...(keptByAction.get(l.actionId) ?? []), l]);
  const manualKept = kept.filter((l) => l.importType === "manual");

  /** The same currency and amount within a day, or about the amount (a fee apart) at about the time. */
  const fits = (l: Leg, currency: string, amount: number, time: string) =>
    sameCurrency(l.currency, currency) &&
    ((sameAmount(l.quantity, amount) && gap(time, l.timestamp) <= DAY) ||
      (Math.abs(l.quantity - amount) <= FEE_APART * l.quantity && gap(time, l.timestamp) <= NEAR));

  /** The same thing, or under another name: the same amount at about the time, a ticker the run spells differently. */
  const rowFits = (l: Leg, r: Row, m: Move) =>
    fits(l, m.currency, m.amount, r.timestamp) ||
    (sameAmount(l.quantity, m.amount) && gap(r.timestamp, l.timestamp) <= NEAR);
  /** Whether a row's plain receive is half of a transfer: a send of the same in the rows going ahead. */
  const sentByRow = (r: Row, m: Move) =>
    (m.trade === "deposit" || m.trade === "bridgeIn") &&
    rows.some(
      (o) =>
        uploads.has(o.id) &&
        gap(o.timestamp, r.timestamp) <= NEAR &&
        legsMade(o).some(
          (x) => x.side === "outgoing" && sameCurrency(x.currency, m.currency) && sameAmount(x.amount, m.amount),
        ),
    );
  /** What has already added something back: each can do so once, so two removed sells need two rows. */
  const claimed = new Set<string>();

  /** Whether a row going ahead would add this leg back: it fits, and its type does what the leg did. */
  const rowAddsBack = (l: Leg, r: Row, m: Move) =>
    uploads.has(r.id) &&
    m.side === l.side &&
    rowFits(l, r, m) &&
    (l.side === "outgoing" ? isDisposal(m.trade) : !NOTHING_IN.has(m.trade) && !sentByRow(r, m));
  /** Whether a kept leg stands for this one, by the type it ends up with. */
  const keptAddsBack = (l: Leg, k: Leg) => {
    if (k.side !== l.side || !fits(l, k.currency, k.quantity, k.timestamp)) return false;
    const trade = tradeAfter(k);
    if (l.side === "outgoing") return isDisposal(trade);
    if (NOTHING_IN.has(trade)) return false;
    // A plain receive counts only alone: beside a kept send it is half of a transfer, and acquires nothing
    return (
      isAcquisition(trade) ||
      !(keptByAction.get(k.actionId) ?? []).some((o) => o.side === "outgoing" && o.importType !== "soft-transfer")
    );
  };
  /** The nearest in time of what stands for this leg and is not taken. */
  const addedBack = (l: Leg): boolean => {
    const byRow = rows.flatMap((r) =>
      legsMade(r)
        .filter((m) => rowAddsBack(l, r, m))
        .map((m) => ({ key: `${r.id}:${m.side}`, time: r.timestamp })),
    );
    const byLeg = kept.filter((k) => keptAddsBack(l, k)).map((k) => ({ key: k.legId, time: k.timestamp }));
    const nearest = [...byRow, ...byLeg]
      .filter((c) => !claimed.has(c.key))
      .sort((a, b) => gap(a.time, l.timestamp) - gap(b.time, l.timestamp))[0];
    if (nearest) claimed.add(nearest.key);
    return !!nearest;
  };

  /** A kept manual leg sending on what `l` brought in: the same currency and amount, from just before to a day after. */
  const sentOn = (l: Leg) =>
    manualKept.filter(
      (m) =>
        m.side === "outgoing" &&
        sameCurrency(m.currency, l.currency) &&
        sameAmount(m.quantity, l.quantity) &&
        Date.parse(m.timestamp) >= Date.parse(l.timestamp) - NEAR &&
        Date.parse(m.timestamp) - Date.parse(l.timestamp) <= DAY,
    );

  const removedInOrder = [...deleteOfLeg.keys()]
    .map((id) => legById.get(id) as Leg)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const lostDisposals = removedInOrder.filter((l) => l.side === "outgoing" && isDisposal(l.trade) && !addedBack(l));
  const lostAcquisitions = removedInOrder.filter(
    (l) => l.side === "incoming" && !IGNORED.has(l.trade) && !NOTHING_IN.has(l.trade) && !addedBack(l),
  );
  const dependent = lostAcquisitions.filter((l) => sentOn(l).length);
  /** A row adding what a kept manual leg already acquires. */
  const doubled = rows.flatMap((r) => {
    if (!uploads.has(r.id) && !categorisedRows.has(r.id)) return [];
    return legsMade(r)
      .filter((m) => m.side === "incoming" && isAcquisition(m.trade))
      .flatMap((m) =>
        manualKept
          .filter(
            (k) =>
              k.side === "incoming" && isAcquisition(k.trade) && sameMove(k, m) && gap(k.timestamp, r.timestamp) <= DAY,
          )
          .map((k) => ({ row: r, leg: k, move: m })),
      );
  });

  // ---- One decision per event: what was found, then everything linked to it
  const rowsByTxid = new Map<string, Row[]>();
  for (const r of rows)
    for (const t of r.txids.filter((x) => !/^0+$/.test(x))) rowsByTxid.set(t, [...(rowsByTxid.get(t) ?? []), r]);
  const eventOfRow = (r: Row) => [r, ...r.txids.filter((x) => !/^0+$/.test(x)).flatMap((t) => rowsByTxid.get(t) ?? [])];
  const heldManual = new Map(plan.held.flatMap((h) => (h.id === null ? [] : [[h.id, h.legIds ?? []] as const])));
  const usedLegs = new Set<string>();
  const decisions: Decision[] = [];
  const seeds: { legs: Leg[]; rows: Row[] }[] = [
    ...[...lostDisposals, ...dependent].map((l) => ({ legs: [l], rows: [] })),
    ...doubled.map((d) => ({ legs: [d.leg], rows: [d.row] })),
  ];
  seeds.sort((a, b) => Date.parse(a.legs[0].timestamp) - Date.parse(b.legs[0].timestamp));
  for (const seed of seeds) {
    if (seed.legs.some((l) => usedLegs.has(l.legId))) continue;
    const groupLegs = new Map(seed.legs.map((l) => [l.legId, l]));
    const groupRows = new Map(seed.rows.map((r) => [r.id, r]));
    for (let grew = true; grew;) {
      grew = false;
      const addLeg = (l: Leg) => {
        if (!groupLegs.has(l.legId)) {
          groupLegs.set(l.legId, l);
          grew = true;
        }
      };
      const addRow = (r: Row) => {
        if (!groupRows.has(r.id)) {
          groupRows.set(r.id, r);
          grew = true;
        }
      };
      for (const l of [...groupLegs.values()]) {
        // The delete's other legs, and what moves the same amount
        const d = deleteOfLeg.get(l.legId);
        if (d) (legsOfDelete.get(d) as Leg[]).forEach(addLeg);
        for (const o of legs)
          if (
            deleteOfLeg.has(o.legId) &&
            sameCurrency(o.currency, l.currency) &&
            sameAmount(o.quantity, l.quantity) &&
            gap(o.timestamp, l.timestamp) <= NEAR
          )
            addLeg(o);
        // Hand-typed times can be a day off from what they stand for, but one manual leg is no reason to reach for another
        const reach = l.importType === "manual" ? NEAR : DAY;
        for (const m of manualKept)
          if (
            !usedLegs.has(m.legId) &&
            sameCurrency(m.currency, l.currency) &&
            sameAmount(m.quantity, l.quantity) &&
            gap(m.timestamp, l.timestamp) <= reach
          ) {
            addLeg(m);
            (keptByAction.get(m.actionId) ?? []).filter((o) => o.importType === "manual").forEach(addLeg);
          }
        for (const r of rows)
          if (
            (gap(r.timestamp, l.timestamp) <= NEAR && movesOf(r).some((m) => sameMove(l, m))) ||
            // What could add it back belongs here too, or holding this event would leave it going
            legsMade(r).some((m) => rowAddsBack(l, r, m))
          )
            addRow(r);
      }
      for (const r of [...groupRows.values()]) {
        eventOfRow(r).forEach(addRow);
        for (const id of heldManual.get(r.id) ?? []) {
          const m = legById.get(id);
          if (m && !removed.has(id) && !usedLegs.has(id)) addLeg(m);
        }
        for (const m of manualKept)
          if (!usedLegs.has(m.legId) && txidsNamedBy(m).some((t) => r.txids.includes(t))) addLeg(m);
      }
    }
    for (const l of groupLegs.values()) usedLegs.add(l.legId);
    decisions.push(decisionOf(`d${decisions.length + 1}`, [...groupLegs.values()], [...groupRows.values()]));
  }

  function decisionOf(id: string, ls: Leg[], rs: Row[]): Decision {
    const manual = ls.filter((l) => l.importType === "manual");
    const groupDeletes = deletes.filter((d) => (legsOfDelete.get(d) as Leg[]).some((l) => ls.includes(l)));
    const disposals = lostDisposals.filter((l) => ls.includes(l));
    const acquisitions = lostAcquisitions.filter((l) => ls.includes(l) && (isAcquisition(l.trade) || sentOn(l).length));
    const twice = doubled.filter((d) => ls.includes(d.leg));
    const notGoing = rs.filter((r) => !uploads.has(r.id) && !categorisedRows.has(r.id));
    const keptTxids = new Set(kept.map((k) => normaliseTxid(k.id)));
    const hasLeg = (r: Row) =>
      kept.some((k) => rowOfLeg(k)?.id === r.id) || r.txids.some((t) => keptTxids.has(t) && !/^0+$/.test(t));
    const going = rs.filter((r) => uploads.has(r.id) || categorisedRows.has(r.id));
    const held = notGoing.filter((r) => heldRows.has(r.id));

    // An old trade whose sold side is a row of the run, and whose bought side the run replaces with another asset
    const swap = groupDeletes.flatMap((d) => {
      const dl = legsOfDelete.get(d) as Leg[];
      const sold = dl.find((l) => l.side === "outgoing" && isDisposal(l.trade));
      const bought = dl.find((l) => l.side === "incoming" && isAcquisition(l.trade));
      if (!sold || !bought || sameCurrency(sold.currency, bought.currency)) return [];
      const out = rs.find((r) => movesOf(r).some((m) => m.side === "outgoing" && sameMove(sold, m)));
      if (!out) return [];
      const ins = rs.flatMap((r) => movesOf(r).filter((m) => m.side === "incoming"));
      if (!ins.length) return [];
      if (ins.some((m) => sameCurrency(m.currency, bought.currency) || sameAmount(m.amount, bought.quantity)))
        return [];
      return [{ d, sold, bought, out, into: ins[0] }];
    })[0];

    const lines: string[] = [];
    if (swap)
      lines.push(
        `The swap changed. Summ: ${swap.sold.quantity} ${swap.sold.currency} -> ${swap.bought.quantity} ${swap.bought.currency} (\`${swap.d.summId}\`). The run: ${swap.sold.quantity} ${swap.sold.currency} -> ${swap.into.amount} ${swap.into.currency} (\`${swap.out.id}\`).`,
      );
    for (const l of disposals)
      lines.push(
        `Disposal removed, nothing adds it back: ${legText(l)} (\`${l.id}\`). Its gain or loss goes, and its cost base stays for later disposals.`,
      );
    for (const l of acquisitions.filter((a) => sentOn(a).length || !disposals.length))
      lines.push(
        `${isAcquisition(l.trade) ? "Acquisition" : "Receive"} removed, nothing adds it back: ${legText(l)} (\`${l.id}\`).`,
      );
    for (const l of acquisitions)
      for (const m of sentOn(l))
        lines.push(
          `Left behind: manual ${legText(m)} (leg \`${m.legId}\`) sends on the removed ${l.currency}. Kept, it disposes from nothing: a false gain.`,
        );
    for (const d of twice)
      lines.push(
        `Acquired twice: row \`${d.row.id}\` adds ${d.move.amount} ${d.move.currency}, and manual ${legText(d.leg)} (leg \`${d.leg.legId}\`) stays.`,
      );
    const otherManual = manual.filter(
      (m) => !acquisitions.some((l) => sentOn(l).includes(m)) && !twice.some((d) => d.leg === m),
    );
    for (const m of otherManual) lines.push(`Also kept: manual ${legText(m)} (leg \`${m.legId}\`).`);
    if (held.length) {
      const noTxid = groupDeletes.length && groupDeletes.every((d) => !d.txids?.length);
      lines.push(
        `Rows held, so not uploaded: ${held.map((r) => `\`${r.id}\``).join(", ")}.${groupDeletes.length ? ` These deletes still go: ${groupDeletes.map((d) => `\`${d.summId}\``).join(", ")}${noTxid ? ": they name no txid, so the hold does not reach them" : ""}.` : ""}`,
      );
    }
    for (const o of plan.overridden)
      if (o.override.field === "trade" && rs.some((r) => r.id === o.override.id))
        lines.push(
          `Your value stays on row \`${o.override.id}\`: type ${o.override.summ}, where the run has ${o.override.run}. Its \`retainUserEdit\` decides that.`,
        );
    const namedHere = plan.delete
      .filter((d) => d.manual)
      .flatMap((d) => d.legIds.map((id) => legById.get(id) as Leg))
      .filter(
        (n) =>
          n &&
          ls.some(
            (l) =>
              sameCurrency(n.currency, l.currency) &&
              sameAmount(n.quantity, l.quantity) &&
              gap(n.timestamp, l.timestamp) <= DAY,
          ),
      );
    for (const n of namedHere)
      lines.push(`Already going, named in \`deleteManualEntries\`: manual ${legText(n)} (leg \`${n.legId}\`).`);
    const outside = notGoing.filter((r) => !heldRows.has(r.id) && !hasLeg(r));
    if (outside.length) lines.push(`Rows not in this plan: ${outside.map((r) => `\`${r.id}\``).join(", ")}.`);
    lines.push(
      "Linked by currency, amount and time, not by txid. No gain is computed here: Summ shows the effect only after a recalculation.",
    );

    // What the plan refuses to delete an entry beside: every manual leg in its action or naming its txids, fee legs too
    const named = new Map(manual.map((m) => [m.legId, m]));
    for (let grew = named.size > 0; grew;) {
      grew = false;
      const entries = [...named.values()];
      const txids = new Set([...txidsOf(entries), ...entries.flatMap(txidsNamedBy)].filter((t) => !/^0+$/.test(t)));
      for (const o of legs)
        if (
          o.importType === "manual" &&
          !removed.has(o.legId) &&
          !named.has(o.legId) &&
          (entries.some((m) => m.actionId === o.actionId) || txidsNamedBy(o).some((t) => txids.has(t)))
        ) {
          named.set(o.legId, o);
          grew = true;
        }
    }
    const toName = [...named.values()];
    const spans = new Set(toName.map((m) => isFiled(m.timestamp))).size > 1;

    const reason = swap
      ? `the run exports this swap as ${swap.sold.currency} -> ${swap.into.currency}`
      : "the run's rows stand for this event";
    const options: DecisionOption[] = [
      manual.length
        ? {
            key: "a",
            ...(spans ? { spans: true } : {}),
            title: "The run is right, and the manual entries were stand-ins: delete them.",
            result: `The next plan deletes these entries${groupDeletes.length ? " with the old rows" : ""}${rs.length ? " and goes ahead with the run's rows" : ""}. Summ has no undo for a delete; apply saves each entry first.${spans ? " These span filed and current years, and a plan takes one kind at a time: add each kind's lines by hand, one kind at a time." : ""}`,
            config: {
              deleteManualEntries: toName.map((m) => ({
                legId: m.legId,
                currency: m.currency,
                quantity: m.quantity,
                reason,
              })),
            },
          }
        : {
            key: "a",
            title: "The plan is right: this is meant to go.",
            result: `Nothing to add: apply the plan as it is.${held.length ? " Its rows stay held for a manual entry elsewhere: the rest goes without them." : ""}`,
            config: {},
          },
      {
        key: "b",
        title: "Keep what Summ has for now.",
        result: "The next plan leaves these old rows and the run's rows alone, until the holds are removed.",
        config: {
          hold: [...new Set([...groupDeletes.map((d) => d.id ?? d.summId), ...going.map((r) => r.id)])].map((id) => ({
            id,
            reason: `kept beside what depends on it: ${reason}`,
          })),
        },
      },
    ];
    const kind: Decision["kind"] = swap
      ? "swap-changed"
      : disposals.length
        ? "lost-disposal"
        : acquisitions.length
          ? "lost-acquisition"
          : "acquired-twice";
    const date = [...ls].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0].timestamp.slice(0, 10);
    const boughtSentOn = acquisitions.find((l) => isAcquisition(l.trade) && sentOn(l).length);
    const titles: Record<Decision["kind"], string> = {
      "swap-changed": `a swap changed from ${swap?.bought.currency} to ${swap?.into.currency}`,
      "lost-disposal": `a disposal of ${disposals[0]?.currency} is removed${boughtSentOn ? `, and the ${boughtSentOn.currency} it bought is sent on` : ""}`,
      "lost-acquisition": `${isAcquisition(acquisitions[0]?.trade ?? "") ? "an acquisition" : "a receive"} of ${acquisitions[0]?.currency} is removed and sent on`,
      "acquired-twice": `${twice[0]?.leg.currency} is acquired twice`,
    };
    return {
      id,
      kind,
      filed: (toName.length ? toName : ls).some((l) => isFiled(l.timestamp)),
      title: `${date}: ${titles[kind]}`,
      lines,
      options,
    };
  }

  // ---- The rest: an acquisition gone with nothing back, and something of that asset leaving soon after. A manual entry
  // named for deletion opens no decision, since the user chose it, but what it acquired can still be what is sold later.
  const namedAcquisitions = plan.delete
    .filter((d) => d.manual)
    .flatMap((d) => d.legIds.map((id) => legById.get(id) as Leg))
    .filter((l) => l && l.side === "incoming" && isAcquisition(l.trade) && !addedBack(l));
  const checks = [...lostAcquisitions, ...namedAcquisitions]
    .filter((l) => isAcquisition(l.trade) && !usedLegs.has(l.legId))
    .flatMap((l) => {
      const after = kept.filter(
        (k) =>
          k.side === "outgoing" &&
          sameCurrency(k.currency, l.currency) &&
          Date.parse(k.timestamp) >= Date.parse(l.timestamp) &&
          Date.parse(k.timestamp) - Date.parse(l.timestamp) <= WEEK,
      );
      return after.length
        ? [
            {
              summId: l.id,
              removed: legText(l),
              kept: after.map((k) => `${legText(k)} ${k.timestamp.slice(0, 10)} (${k.importType})`),
            },
          ]
        : [];
    });
  return { decisions, checks };
}

/** The first section of plan.md: nothing is said when there is nothing to decide. */
export function decisionLines(decisions: Decision[], checks: PlanCheck[]): string[] {
  if (!decisions.length && !checks.length) return [];
  const out = [`## Decisions (${decisions.length})`, ""];
  if (decisions.length)
    out.push(
      "Read these first. The plan does not stop on them: applying it now carries out what it lists below. To choose: `summ-sync decide <state dir> <plan dir> d1:a`, which adds the option's config to `summ-sync.json`; then plan again.",
      "",
    );
  for (const d of decisions) {
    out.push(`### ${d.id}: ${d.title}${d.filed ? " (filed year)" : ""}`, "", ...d.lines.map((l) => `- ${l}`), "");
    for (const o of d.options) {
      out.push(`**Option ${o.key}: ${o.title}** ${o.result}`, "");
      if (Object.keys(o.config).length) out.push("```json", JSON.stringify(o.config, null, 2), "```", "");
    }
    out.push("Neither: change the entries in Summ or the run, then pull and plan again.", "");
  }
  if (checks.length)
    out.push(
      `### Also check (${checks.length})`,
      "",
      "Acquisitions removed with nothing adding them back, with what leaves of that asset within a week. Nothing links them but the asset.",
      "",
      "| Old ID | Removed | Kept legs after it |",
      "| --- | --- | --- |",
      ...checks.map((c) => `| ${c.summId} | ${c.removed} | ${c.kept.join("; ")} |`),
      "",
    );
  return out;
}
