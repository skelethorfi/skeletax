import type { Activity, Leg } from "../../domain/Activity.ts";
import { type Amount, formatAmount } from "../../domain/Amount.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import { parseMidgardAsset } from "../../sources/thorchain/MidgardUtils.ts";
import { formatBlockchain, type Protocol } from "../../domain/Protocol.ts";
import { fee, leg, legTrace, paidOutNote } from "./common.ts";

// A loan open (docs/specs/loans.md): the collateral deposit carries the fee; the loan received has none
export function loanOpenRows(activity: Activity, protocol: Protocol): SummRow[] {
  const collateral = leg(activity, "principal", "out");
  const loan = leg(activity, "principal", "in");
  const input = parseMidgardAsset(collateral.asset.notation, protocol);
  const output = parseMidgardAsset(loan.asset.notation, protocol);
  const description = `LoanOpen deposit ${input.currency} to borrow ${output.currency}; ${collateral.txid ?? ""}`;
  const time = activity.time;

  return [
    {
      wallet: collateral.wallet,
      timestamp: time,
      type: SummRowType.CollateralDeposit,
      baseCurrency: input.currency,
      baseAmount: formatAmount(collateral.amount),
      ...fee(activity, protocol),
      from: collateral.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(input.blockchain),
      trace: legTrace(collateral),
      description: `1/2 - ${description}`,
    },
    {
      wallet: loan.wallet,
      timestamp: time,
      type: SummRowType.Loan,
      baseCurrency: output.currency,
      baseAmount: formatAmount(loan.amount),
      from: protocol.counterparty,
      to: loan.wallet,
      blockchain: formatBlockchain(output.blockchain),
      trace: legTrace(loan),
      description: `2/2 - ${description}${paidOutNote(loan)}`,
    },
  ];
}

// A loan repayment carries the fee; when the loan closes, the collateral comes back with no fee. Collateral paid
// back in several outputs is one row, their total, naming each payout txid.
export function loanRepayRows(activity: Activity, protocol: Protocol): SummRow[] {
  const repayment = leg(activity, "principal", "out");
  const collateralBack = activity.legs.filter((item) => item.role === "principal" && item.direction === "in");
  const input = parseMidgardAsset(repayment.asset.notation, protocol);
  const collateral = parseMidgardAsset(activity.details.collateral, protocol).currency;
  const closed = collateralBack.length > 0;
  const txId = repayment.txid ?? "";
  const time = activity.time;
  const description = `LoanRepayment deposit ${input.currency} to repay ${collateral} loan. ${closed ? "Closed loan" : "No closure"}; ${txId}`;
  const rows: SummRow[] = [
    {
      wallet: repayment.wallet,
      timestamp: time,
      type: SummRowType.LoanRepayment,
      baseCurrency: input.currency,
      baseAmount: formatAmount(repayment.amount),
      ...fee(activity, protocol),
      from: repayment.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(input.blockchain),
      trace: legTrace(repayment),
      description: `1/${closed ? "2" : "1"} - ${description}`,
    },
  ];

  if (closed) {
    const [first] = collateralBack;
    const output = parseMidgardAsset(first.asset.notation, protocol);

    rows.push({
      wallet: first.wallet,
      timestamp: time,
      type: SummRowType.CollateralWithdrawal,
      baseCurrency: output.currency,
      baseAmount: formatAmount(total(collateralBack, activity)),
      from: protocol.counterparty,
      to: first.wallet,
      blockchain: formatBlockchain(output.blockchain),
      trace: legTrace(first),
      description: `2/2 - ${description}${paidOutNote(collateralBack)}`,
    });
  }

  return rows;
}

// The collateral paid back, over all its outputs: one wallet, one asset
function total(legs: Leg[], activity: Activity): Amount {
  const [first] = legs;

  for (const item of legs) {
    if (
      item.wallet.toLowerCase() !== first.wallet.toLowerCase() ||
      item.asset.notation !== first.asset.notation ||
      item.amount.decimals !== first.amount.decimals
    ) {
      throw new Error(`${activity.id}: collateral paid back to more than one wallet or in more than one asset`);
    }
  }

  return { base: legs.reduce((sum, item) => sum + item.amount.base, 0n), decimals: first.amount.decimals };
}
