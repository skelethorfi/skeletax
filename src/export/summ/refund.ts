import type { Activity } from "../../domain/Activity.ts";
import { formatAmount } from "../../domain/Amount.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import { formatBlockchain, MAYA, type Protocol, THORCHAIN } from "../../domain/Protocol.ts";
import { findLeg, leg, legTrace, named, plusSeconds } from "./common.ts";

// A refund (docs/specs/fees.md): the send is a failed-out carrying the inbound fee, as Summ counts only a
// failed transaction's fee. What the protocol kept (sent − returned) is a separate fee row, or lost for a
// stuck refund still pending, which was never paid out (docs/specs/pending.md). The return is a row only on an
// L1, a failed-in, so the wallet's import of it carries no amount either. A further gas leg, of another tx,
// is a pending add's withdrawal request: a fee row of its own. A stuck swap that paid nothing out gives the same
// rows, named a swap.
export function refundRows(activity: Activity, protocol: Protocol): SummRow[] {
  const sent = leg(activity, "principal", "out");
  const returned = findLeg(activity, "returned");
  const returnedAmount = { ...sent.amount, base: returned?.amount.base ?? 0n };
  const notReturned = { ...sent.amount, base: sent.amount.base - returnedAmount.base };
  const { blockchain, currency, amount: sentAmount } = named(sent, protocol);
  const txId = sent.txid ?? "";
  const time = activity.time;
  const label = activity.kind === "swap" ? "swap" : "refund";
  const rows: SummRow[] = [
    {
      wallet: sent.wallet,
      timestamp: time,
      type: SummRowType.FailedOut,
      baseCurrency: currency,
      baseAmount: sentAmount,
      ...sendFee(activity, sent.txid, protocol),
      from: sent.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(blockchain),
      trace: legTrace(sent),
      description: `${label} (${txId}): ${activity.details.reason}`,
    },
  ];

  if (notReturned.base > 0n) {
    const returnTxId = returned?.txid;
    const returnedNote =
      `${formatAmount(returnedAmount)} ${currency} returned` + (returnTxId ? ` in ${returnTxId}` : "");
    const stuck = activity.status === "pending";

    rows.push({
      wallet: sent.wallet,
      timestamp: time,
      type: stuck ? SummRowType.Lost : SummRowType.Fee,
      baseCurrency: currency,
      baseAmount: formatAmount(notReturned),
      from: sent.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(blockchain),
      trace: { role: "unreturned", asset: sent.asset.notation },
      description: stuck
        ? `${label} (${txId}): never paid out (still pending), ${sentAmount} ${currency} sent, ${returnedNote}`
        : `refund (${txId}): kept by ${protocol.counterparty}, ${sentAmount} ${currency} sent, ${returnedNote}`,
    });
  }

  // The return on an L1 (not the protocol's own chain), when it has a txid to find it by
  const returnedAt = activity.details.returnTime ? new Date(activity.details.returnTime) : plusSeconds(time, 10);
  if (returned?.txid && returned.amount.base > 0n && !onNativeChain(returned.wallet)) {
    rows.push({
      wallet: returned.wallet,
      timestamp: returnedAt,
      type: SummRowType.FailedIn,
      baseCurrency: currency,
      baseAmount: formatAmount(returned.amount),
      from: protocol.counterparty,
      to: returned.wallet,
      blockchain: formatBlockchain(blockchain),
      trace: legTrace(returned),
      description: `${label} (${txId}): returned in ${returned.txid}`,
    });
  }

  // A pending add's withdrawal request, signed by another wallet (docs/specs/fees.md, Pending adds that are withdrawn)
  for (const request of activity.legs.filter((item) => item.role === "gas" && item.txid && item.txid !== sent.txid)) {
    const paid = named(request, protocol);
    rows.push({
      wallet: request.wallet,
      timestamp: activity.details.requestTime ? new Date(activity.details.requestTime) : returnedAt,
      type: SummRowType.Fee,
      baseCurrency: paid.currency,
      baseAmount: paid.amount,
      from: request.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(paid.blockchain),
      trace: { role: "request", asset: request.asset.notation },
      description: `${label} (${txId}): fee of the withdrawal request ${request.txid ?? ""}`.trim(),
    });
  }

  return rows;
}

// A wallet on THORChain or Maya: no import of it holds a return, and this CSV is its only record
function onNativeChain(wallet: string): boolean {
  return [THORCHAIN, MAYA].some((protocol) => wallet.toLowerCase().startsWith(protocol.nativeAddressPrefix));
}

// The fee of the send: its own gas, not a pending add's withdrawal request's (another tx's gas leg)
function sendFee(activity: Activity, txid: string | undefined, protocol: Protocol) {
  const gas = activity.legs.find((item) => item.role === "gas" && (!item.txid || item.txid === txid));

  if (!gas) {
    return { feeCurrency: "", feeAmount: "" };
  }

  const { currency, amount } = named(gas, protocol);
  return { feeCurrency: currency, feeAmount: amount };
}
