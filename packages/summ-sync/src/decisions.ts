// What a plan's deletes leave behind. The plan compares Summ with the run row by row, so it cannot see that an old
// trade it removes was what a kept entry sold from. This reads the finished plan and says so, with the options. It
// changes nothing in the plan: a person or agent decides, by adding an option's config and planning again.
//
// Old legs usually hold no txid, so legs are linked by currency, amount and time: strong for exact amounts, not proof.

import type { DeleteManualEntry, Hold } from "./config.ts";
import { type Plan, sameAmount, sameCurrency, txidsNamedBy } from "./plan.ts";
import type { Row } from "./run.ts";
import type { Leg } from "./snapshot.ts";
import { summType } from "./summ-types.ts";

export interface DecisionOption {
  key: "a" | "b";
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
const TRANSFER_OUT = new Set(["withdrawal", "bridgeOut", "failedOut", "fee", "approval"]);
const IGNORED = new Set(["ignoreIn", "ignoreOut"]);

const isAcquisition = (trade: string) => !TRANSFER_IN.has(trade) && !IGNORED.has(trade);
const isDisposal = (trade: string) => !TRANSFER_OUT.has(trade) && !IGNORED.has(trade);
const gap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b));

interface Move {
  side: "incoming" | "outgoing";
  currency: string;
  amount: number;
}

/** What a row names: its base and its quote on the other side. */
function movesOf(r: Row): Move[] {
  const type = summType(r.type);
  if (!type) return [];
  const moves: Move[] = [{ side: type.side, currency: r.baseCurrency, amount: Number(r.baseAmount) }];
  if (r.quoteCurrency)
    moves.push({
      side: type.side === "incoming" ? "outgoing" : "incoming",
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

export function decisionsOf(plan: Plan, legs: Leg[], rows: Row[]): { decisions: Decision[]; checks: PlanCheck[] } {
  const deletes = plan.delete.filter((d) => !d.manual);
  const legById = new Map(legs.map((l) => [l.legId, l]));
  const removed = new Set(plan.delete.flatMap((d) => d.legIds));
  const legsOfDelete = new Map(
    deletes.map((d) => [d, d.legIds.map((id) => legById.get(id) as Leg).filter((l) => l && l.side !== "fees")]),
  );
  const deleteOfLeg = new Map([...legsOfDelete].flatMap(([d, ls]) => ls.map((l) => [l.legId, d] as const)));
  const uploads = new Set(plan.upload.flatMap((u) => u.ids));
  const heldRows = new Set(plan.held.flatMap((h) => (h.id === null ? [] : [h.id])));
  /** The type a kept leg ends up with: this plan's change, or the type of the row that took it, unless that row is held. */
  const adopted = new Map(plan.adopted.map((a) => [a.legId, a.id]));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const rowOfLeg = (l: Leg) => rowById.get(adopted.get(l.legId) ?? l.id);
  const typeChange = new Map(
    [...plan.edit, ...plan.categorise].flatMap((e) =>
      e.changes.filter((c) => c.field === "trade").map((c) => [c.legId as string, String(c.desired)] as const),
    ),
  );
  const tradeAfter = (l: Leg) => {
    const row = rowOfLeg(l);
    return typeChange.get(l.legId) ?? (row && !heldRows.has(row.id) ? (summType(row.type)?.trade ?? l.trade) : l.trade);
  };
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

  /** A row going ahead in this plan, or a leg that stays and counts, moves the same thing. */
  const addedBack = (l: Leg): boolean => {
    const byRow = rows.some(
      (r) =>
        uploads.has(r.id) &&
        legsMade(r).some(
          (m) =>
            m.side === l.side &&
            (fits(l, m.currency, m.amount, r.timestamp) ||
              // The same amount at about the same time under another name: a ticker the run spells differently
              (sameAmount(l.quantity, m.amount) && gap(r.timestamp, l.timestamp) <= NEAR)),
        ),
    );
    if (byRow) return true;
    return kept.some((k) => {
      if (k.side !== l.side || !fits(l, k.currency, k.quantity, k.timestamp)) return false;
      const trade = tradeAfter(k);
      if (l.side === "outgoing") return isDisposal(trade);
      // A plain receive counts only alone: beside a kept send it is half of a transfer, and acquires nothing
      return (
        isAcquisition(trade) ||
        !(keptByAction.get(k.actionId) ?? []).some((o) => o.side === "outgoing" && o.importType !== "soft-transfer")
      );
    });
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

  const lostDisposals = [...deleteOfLeg.keys()]
    .map((id) => legById.get(id) as Leg)
    .filter((l) => l.side === "outgoing" && isDisposal(l.trade) && !addedBack(l));
  const lostAcquisitions = [...deleteOfLeg.keys()]
    .map((id) => legById.get(id) as Leg)
    .filter((l) => l.side === "incoming" && !IGNORED.has(l.trade) && !addedBack(l));
  const dependent = lostAcquisitions.filter((l) => sentOn(l).length);
  /** A row adding what a kept manual leg already acquires. */
  const doubled = rows.flatMap((r) => {
    if (!uploads.has(r.id) && !categorisedRows.has(r.id)) return [];
    return legsMade(r)
      .filter((m) => m.side === "incoming")
      .flatMap((m) =>
        manualKept
          .filter(
            (k) =>
              k.side === "incoming" && isAcquisition(k.trade) && sameMove(k, m) && gap(k.timestamp, r.timestamp) <= DAY,
          )
          .map((k) => ({ row: r, leg: k })),
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
        for (const m of manualKept)
          if (
            sameCurrency(m.currency, l.currency) &&
            sameAmount(m.quantity, l.quantity) &&
            gap(m.timestamp, l.timestamp) <= DAY
          ) {
            addLeg(m);
            (keptByAction.get(m.actionId) ?? []).filter((o) => o.importType === "manual").forEach(addLeg);
          }
        for (const r of rows)
          if (gap(r.timestamp, l.timestamp) <= NEAR && movesOf(r).some((m) => sameMove(l, m)))
            eventOfRow(r).forEach(addRow);
      }
      for (const r of [...groupRows.values()]) {
        for (const id of heldManual.get(r.id) ?? []) {
          const m = legById.get(id);
          if (m && !removed.has(id)) addLeg(m);
        }
        for (const m of manualKept) if (txidsNamedBy(m).some((t) => r.txids.includes(t))) addLeg(m);
      }
    }
    for (const l of groupLegs.values()) usedLegs.add(l.legId);
    decisions.push(decisionOf(`d${decisions.length + 1}`, [...groupLegs.values()], [...groupRows.values()]));
  }

  function decisionOf(id: string, ls: Leg[], rs: Row[]): Decision {
    const manual = ls.filter((l) => l.importType === "manual");
    const groupDeletes = deletes.filter((d) => (legsOfDelete.get(d) as Leg[]).some((l) => ls.includes(l)));
    const disposals = lostDisposals.filter((l) => ls.includes(l));
    const acquisitions = lostAcquisitions.filter((l) => ls.includes(l) && isAcquisition(l.trade));
    const twice = doubled.filter((d) => ls.includes(d.leg));
    const notGoing = rs.filter((r) => !uploads.has(r.id) && !categorisedRows.has(r.id));
    const hasLeg = new Set(kept.flatMap((k) => rowOfLeg(k)?.id ?? []));
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
      lines.push(`Acquisition removed, nothing adds it back: ${legText(l)} (\`${l.id}\`).`);
    for (const l of acquisitions)
      for (const m of sentOn(l))
        lines.push(
          `Left behind: manual ${legText(m)} (leg \`${m.legId}\`) sends on the removed ${l.currency}. Kept, it disposes from nothing: a false gain.`,
        );
    for (const d of twice)
      lines.push(
        `Acquired twice: row \`${d.row.id}\` adds ${d.row.baseAmount} ${d.row.baseCurrency}, and manual ${legText(d.leg)} (leg \`${d.leg.legId}\`) stays.`,
      );
    const otherManual = manual.filter(
      (m) => !acquisitions.some((l) => sentOn(l).includes(m)) && !twice.some((d) => d.leg === m),
    );
    for (const m of otherManual) lines.push(`Also kept: manual ${legText(m)} (leg \`${m.legId}\`).`);
    if (held.length)
      lines.push(
        `Rows held, so not uploaded: ${held.map((r) => `\`${r.id}\``).join(", ")}.${groupDeletes.length ? ` These deletes still go: ${groupDeletes.map((d) => `\`${d.summId}\``).join(", ")}: they name no txid, so the hold does not reach them.` : ""}`,
      );
    const outside = notGoing.filter((r) => !heldRows.has(r.id) && !hasLeg.has(r.id));
    if (outside.length) lines.push(`Rows not in this plan: ${outside.map((r) => `\`${r.id}\``).join(", ")}.`);
    lines.push(
      "Linked by currency, amount and time, not by txid. No gain is computed here: Summ shows the effect only after a recalculation.",
    );

    const reason = swap
      ? `the run exports this swap as ${swap.sold.currency} -> ${swap.into.currency}`
      : "the run's rows stand for this event";
    const options: DecisionOption[] = [
      manual.length
        ? {
            key: "a",
            title: "The run is right, and the manual entries were stand-ins: delete them.",
            result:
              "The next plan deletes these entries with the old rows and goes ahead with the run's rows. Summ has no undo for a delete; apply saves each entry first.",
            config: {
              deleteManualEntries: manual.map((m) => ({
                legId: m.legId,
                currency: m.currency,
                quantity: m.quantity,
                reason,
              })),
            },
          }
        : {
            key: "a",
            title: "The plan is right: nothing depends on what it removes.",
            result: "Nothing to add: apply the plan as it is.",
            config: {},
          },
      {
        key: "b",
        title: "Keep what Summ has for now.",
        result: "The next plan leaves these old rows alone, until the holds are removed.",
        config: {
          hold: groupDeletes.map((d) => ({
            id: d.id ?? d.summId,
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
    const titles: Record<Decision["kind"], string> = {
      "swap-changed": `a swap changed from ${swap?.bought.currency} to ${swap?.into.currency}`,
      "lost-disposal": `a disposal of ${disposals[0]?.currency} is removed${acquisitions.some((l) => sentOn(l).length) ? `, and the ${acquisitions[0]?.currency} it bought is sent on` : ""}`,
      "lost-acquisition": `an acquisition of ${acquisitions[0]?.currency} is removed and sent on`,
      "acquired-twice": `${twice[0]?.leg.currency} is acquired twice`,
    };
    return {
      id,
      kind,
      filed: ls.some((l) => deleteOfLeg.has(l.legId) && plan.delete.find((d) => d.legIds.includes(l.legId))?.filed),
      title: `${date}: ${titles[kind]}`,
      lines,
      options,
    };
  }

  // ---- The rest: an acquisition gone with nothing back, and something of that asset leaving soon after
  const checks = lostAcquisitions
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
      "Read these first. The plan does not stop on them: applying it now carries out what it lists below. To choose, add the option's config to `summ-sync.json` and plan again.",
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
