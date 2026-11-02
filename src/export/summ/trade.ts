import type { Activity } from "../../domain/Activity.ts";
import { formatAmount } from "../../domain/Amount.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import { formatBlockchain, type Protocol } from "../../domain/Protocol.ts";
import { fee, leg, legTrace, named, paidOutNote, plusSeconds } from "./common.ts";

// A trade account deposit or withdrawal is a bridge between the wallet's own addresses: the asset leaves its L1
// chain and arrives on THORChain as the trade asset 10 s later, or the reverse (docs/specs/trade.md). A
// withdrawal's outbound fee, kept from the trade asset sent, is a fee row of its own, so the bridge-out and the
// bridge-in carry the same amount.
export function tradeRows(activity: Activity, protocol: Protocol): SummRow[] {
  const sent = leg(activity, "principal", "out");
  const received = leg(activity, "principal", "in");
  const input = named(sent, protocol);
  const output = named(received, protocol);
  const isDeposit = activity.kind === "trade.deposit";
  // Never negative: the interpreter fails an action that paid out more than it was sent
  const kept = { ...sent.amount, base: sent.amount.base - received.amount.base };

  const txId = sent.txid ?? "";
  const what = isDeposit ? "Trade account deposit" : "Trade account withdrawal";
  const bridged = formatAmount({ ...sent.amount, base: received.amount.base });
  const rows: SummRow[] = [
    {
      wallet: sent.wallet,
      timestamp: activity.time,
      type: SummRowType.BridgeOut,
      baseCurrency: input.currency,
      baseAmount: bridged,
      ...fee(activity, protocol),
      from: sent.wallet,
      to: received.wallet,
      blockchain: formatBlockchain(input.blockchain),
      trace: legTrace(sent),
      description: `1/2 - ${what}: send ${bridged} ${sent.asset.notation}; ${txId}`,
    },
    {
      wallet: received.wallet,
      timestamp: plusSeconds(activity.time, 10),
      type: SummRowType.BridgeIn,
      baseCurrency: output.currency,
      baseAmount: output.amount,
      from: sent.wallet,
      to: received.wallet,
      blockchain: formatBlockchain(output.blockchain),
      trace: legTrace(received),
      description: `2/2 - ${what}: receive ${output.amount} ${received.asset.notation}; ${txId}${paidOutNote(received)}`,
    },
  ];

  if (kept.base > 0n) {
    rows.push({
      wallet: sent.wallet,
      timestamp: activity.time,
      type: SummRowType.Fee,
      baseCurrency: input.currency,
      baseAmount: formatAmount(kept),
      from: sent.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(input.blockchain),
      trace: { role: "outbound-fee", asset: sent.asset.notation },
      description: `Fee: trade account withdrawal outbound fee, ${input.amount} ${sent.asset.notation} sent, ${output.amount} ${received.asset.notation} paid out; ${txId}`,
    });
  }

  return rows;
}
