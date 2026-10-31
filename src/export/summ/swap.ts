import type { Activity } from "../../domain/Activity.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import {
  fee,
  findLeg,
  leg,
  legBlockchain,
  legTrace,
  named,
  paidOutNote,
  plusSeconds,
  referencePrice,
} from "./common.ts";
import { formatPrice } from "./prices.ts";

// A token an aggregator delivered has no price from the swap: it is worth what was given up for it, so proceeds
// and cost base match (docs/specs/prices.md)
function receivedPrice(activity: Activity, swapped: string, received: string, asset: string) {
  const observed = referencePrice(activity, "midgard:swap.outPriceUSD", asset);
  const sentUsd = referencePrice(activity, "midgard:swap.inPriceUSD").referencePricePerUnit;

  if (!activity.details.paidVia || !sentUsd) {
    return observed;
  }

  return {
    referencePricePerUnit: formatPrice((Number(swapped) * Number(sentUsd)) / Number(received)),
    referencePriceCurrency: "USD" as const,
  };
}

// A cross-chain trade: the trade-out on the sending wallet carries the fee; the trade-in on the receiving
// wallet comes 10 s later. A part returned unfilled is netted off the trade-out.
export function swapRows(activity: Activity, protocol: Protocol): SummRow[] {
  const sent = leg(activity, "principal", "out");
  const received = leg(activity, "principal", "in");
  const returned = findLeg(activity, "returned");
  const swapped = { ...sent.amount, base: sent.amount.base - (returned?.amount.base ?? 0n) };

  const input = named(sent, protocol, swapped);
  const output = named(received, protocol);
  const synth = (notation: string) => (notation.includes("/") ? "Synth " : "");
  const swap = `Swap ${input.amount} ${synth(sent.asset.notation)}${input.displayCurrency} to ${output.amount} ${synth(received.asset.notation)}${output.displayCurrency}`;
  const returnedNote = returned
    ? ` (${named(returned, protocol).amount} ${input.displayCurrency} returned unfilled)`
    : "";
  const via = activity.details.paidVia ? ` (via ${activity.details.paidVia} and an aggregator)` : "";
  const txId = sent.txid ?? "";

  return [
    {
      wallet: sent.wallet,
      timestamp: activity.time,
      type: SummRowType.BridgeTradeOut,
      baseCurrency: input.currency,
      baseAmount: input.amount,
      quoteCurrency: output.currency,
      quoteAmount: output.amount,
      ...fee(activity, protocol),
      from: sent.wallet,
      to: protocol.counterparty,
      blockchain: legBlockchain(sent, protocol),
      ...referencePrice(activity, "midgard:swap.inPriceUSD"),
      trace: legTrace(sent),
      description: `1/2 - ${swap}${via}${returnedNote}; ${txId}`,
    },
    {
      wallet: received.wallet,
      timestamp: plusSeconds(activity.time, 10),
      type: SummRowType.BridgeTradeIn,
      baseCurrency: output.currency,
      baseAmount: output.amount,
      from: protocol.counterparty,
      to: received.wallet,
      blockchain: legBlockchain(received, protocol),
      ...receivedPrice(activity, input.amount, output.amount, received.asset.notation),
      trace: legTrace(received),
      description: `2/2 - ${swap}${via}; ${txId}${paidOutNote(received)}`,
    },
  ];
}
