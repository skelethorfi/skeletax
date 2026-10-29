import type { Activity } from "../../domain/Activity.ts";
import { type SummRow, rowId } from "./csv/index.ts";
import { bondRows } from "./bond.ts";
import { swapRows } from "./swap.ts";
import { refundRows } from "./refund.ts";
import { addLiquidityRows, auctionDepositRows, auctionPositionRows, withdrawRows } from "./liquidity.ts";
import { runePoolRows, switchRows } from "./switch.ts";
import { loanOpenRows, loanRepayRows } from "./loan.ts";
import { tcyClaimRows, tcyDistributionRows, tcyStakeRows, thornameRows } from "./tcy.ts";
import { rujiraStakeRows, rujiraTradeRows } from "./rujira.ts";
import { failedDepositRows, sendRows } from "./send.ts";
import { mayaDistributionRows } from "./maya.ts";
import type { MayaLiquidityAuction } from "../../config/ITaxConfig.ts";
import { type ReferencePrices, withReferencePrice } from "./prices.ts";
import { type AssetNamesConfig, getProtocol, type Protocol, withAssetNames } from "../../domain/Protocol.ts";

// The tax choices the Summ rows depend on, from the config. Today: how assets are named
// (docs/specs/assets.md).
export interface Treatment {
  assets?: AssetNamesConfig;
  mayaLiquidityAuction?: MayaLiquidityAuction;
  // Senders whose transfers to the wallet are income (ITaxConfig.incomeFrom); unset: the known distributors
  incomeFrom?: string[];
  // Which rows carry a reference price (docs/specs/prices.md). Default: 'swaps'
  referencePrices?: ReferencePrices;
}

// Activities as rows of Summ's advanced CSV, the same rows the old mappers wrote
export function exportSumm(activities: Activity[], treatment: Treatment = {}): SummRow[] {
  return activities.flatMap((activity) =>
    toRows(activity, withAssetNames(getProtocol(activity.protocol), treatment.assets), treatment).map((row) =>
      withId(treatment.referencePrices === "all" ? withReferencePrice(row, activity) : row, activity),
    ),
  );
}

// Each row's ID, from its action's record and time and the role its mapper gave it (docs/specs/periods.md)
function withId(row: SummRow, activity: Activity): SummRow {
  if (!row.trace) {
    throw new Error(`${activity.id}: a ${row.type} row has no role`);
  }

  const trace = { ...row.trace, record: activity.id };
  return { ...row, trace, id: rowId(activity.time, row.wallet ?? "", trace) };
}

function toRows(activity: Activity, protocol: Protocol, treatment: Treatment): SummRow[] {
  switch (activity.kind) {
    case "bond":
    case "unbond":
      return bondRows(activity, protocol);
    case "swap":
      // A stuck swap that paid nothing out is a stuck refund (docs/specs/pending.md)
      return activity.status === "pending" ? refundRows(activity, protocol) : swapRows(activity, protocol);
    case "refund":
      return refundRows(activity, protocol);
    case "lp.add":
    case "savers.add":
      return addLiquidityRows(activity, protocol);
    case "lp.auction.deposit":
      return auctionDepositRows(activity, protocol);
    case "lp.auction.position":
      return auctionPositionRows(activity, protocol, treatment.mayaLiquidityAuction);
    case "lp.withdraw":
    case "savers.withdraw":
      return withdrawRows(activity, protocol);
    case "switch":
      return switchRows(activity, protocol);
    case "runepool.deposit":
    case "runepool.withdraw":
      return runePoolRows(activity, protocol);
    case "loan.open":
      return loanOpenRows(activity, protocol);
    case "loan.repay":
      return loanRepayRows(activity, protocol);
    case "send":
      return sendRows(activity, protocol, treatment.incomeFrom);
    case "deposit.failed":
      return failedDepositRows(activity, protocol);
    case "tcy.claim":
      return tcyClaimRows(activity, protocol);
    case "tcy.stake":
    case "tcy.unstake":
      return tcyStakeRows(activity, protocol);
    case "tcy.distribution":
      return tcyDistributionRows(activity, protocol);
    case "thorname":
      return thornameRows(activity, protocol);
    case "maya.distribution":
      return mayaDistributionRows(activity, protocol);
    case "rujira.stake":
      return rujiraStakeRows(activity, protocol);
    case "rujira.liquid.bond":
    case "rujira.fin.trade":
    case "rujira.merge.deposit":
    case "rujira.merge.withdraw":
      return rujiraTradeRows(activity, protocol);
  }
}
