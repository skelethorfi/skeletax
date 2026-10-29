import type { Activity, Leg } from "../../domain/Activity.ts";
import { formatAmount } from "../../domain/Amount.ts";
import type { SummRow } from "./csv/index.ts";

// Which rows carry a reference price (docs/specs/prices.md): 'swaps' (default) leaves the rows as the mappers
// make them; 'all' fills every other row whose asset has a price
export const REFERENCE_PRICES = ["swaps", "all"] as const;
export type ReferencePrices = (typeof REFERENCE_PRICES)[number];

// The row with the USD price of its leg's asset at the activity's time, when it has none yet. A price helper never
// gets one: it is there for Summ's own value. A position is valued by what went in or came out.
export function withReferencePrice(row: SummRow, activity: Activity): SummRow {
  if (row.referencePricePerUnit || !row.trace || row.trace.role === "price-helper") {
    return row;
  }

  const item = legOf(activity, row.trace.role, row.trace.asset);
  const usd = !item
    ? undefined
    : item.asset.kind === "position"
      ? positionPrice(activity, item)
      : priceOf(activity, item);
  return usd ? { ...row, referencePricePerUnit: usd, referencePriceCurrency: "USD" } : row;
}

// The leg a row records: legTrace names it by its role ('in'/'out' for a principal) and asset. A row of another
// role (e.g. what a refund did not return) takes the asset's price.
function legOf(activity: Activity, role: string, asset?: string): Leg | undefined {
  const legRole = (item: Leg) => (item.role === "principal" ? item.direction : item.role);
  const byAsset = activity.legs.filter((item) => item.asset.notation === asset);
  return byAsset.find((item) => legRole(item) === role) ?? byAsset.find((item) => item.asset.kind !== "position");
}

function priceOf(activity: Activity, item: Leg): string | undefined {
  return activity.prices.find((price) => price.asset.notation === item.asset.notation)?.usd;
}

// A position's USD value per unit: the other side's principal legs (the deposits of an add, the assets paid out of
// a withdrawal, the TCY of a claim), each at its price, over the units. None when any of them has no price, and
// for a Maya liquidity-auction position, whose cost depends on the treatment and on deposits at other times.
function positionPrice(activity: Activity, position: Leg): string | undefined {
  if (activity.kind === "lp.auction.position" || activity.status !== "success") {
    return undefined;
  }

  const others = activity.legs.filter(
    (item) => item.role === "principal" && item.direction !== position.direction && item.asset.kind !== "position",
  );
  const prices = others.map((item) => priceOf(activity, item));
  const units = Number(formatAmount(position.amount));

  if (others.length === 0 || prices.some((usd) => !usd) || !(units > 0)) {
    return undefined;
  }

  const value = others.reduce((sum, item, i) => sum + Number(formatAmount(item.amount)) * Number(prices[i]), 0);
  return formatPrice(value / units);
}

// A price as a plain decimal (no exponent), to 15 significant digits
export function formatPrice(value: number): string {
  const digits = Math.min(20, Math.max(0, 14 - Math.floor(Math.log10(Math.abs(value)))));
  return value
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}
