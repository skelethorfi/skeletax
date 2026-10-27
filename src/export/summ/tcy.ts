import type { Activity } from "../../domain/Activity.ts";
import { formatAmount } from "../../domain/Amount.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import { parseMidgardAsset } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { findLeg, leg, legTrace, plusSeconds } from "./common.ts";
import { getLpTokenName } from "./ThorchainUtils.ts";

// The fee columns from the gas leg, or no fee columns at all when there is none (as these rows always had)
function feeIfAny(activity: Activity, protocol: Protocol): Pick<SummRow, "feeCurrency" | "feeAmount"> {
  const gas = findLeg(activity, "gas");
  return gas
    ? { feeCurrency: parseMidgardAsset(gas.asset.notation, protocol).currency, feeAmount: formatAmount(gas.amount) }
    : {};
}

// A claim: the TCY received, then staked, since a claim stakes it (docs/specs/thorfi-collapse.md). A savers claim
// gives up the position for the TCY: the position returned, a price helper of the TCY for its value, and the TCY
// received as what the position paid out.
export function tcyClaimRows(activity: Activity, protocol: Protocol): SummRow[] {
  const tcy = leg(activity, "principal", "in");
  const position = findLeg(activity, "principal", "out");
  const amount = formatAmount(tcy.amount);
  const currency = parseMidgardAsset(tcy.asset.notation, protocol).currency;
  const time = activity.time;
  const txid = tcy.txid ?? "";
  const claimedFor = activity.details.claimedFor;
  const staked: SummRow = {
    wallet: tcy.wallet,
    timestamp: plusSeconds(time, position ? 30 : 10),
    type: SummRowType.StakingDeposit,
    baseCurrency: currency,
    baseAmount: amount,
    from: tcy.wallet,
    to: protocol.counterparty,
    blockchain: protocol.blockchain,
    // Its own role: the same leg as the receive, another row
    trace: { ...legTrace(tcy), role: "stake" },
    description: `${position ? "4/4" : "2/2"} - Stake ${amount} TCY claimed (a claim stakes it); ${txid}`,
  };

  if (!position) {
    return [
      {
        wallet: tcy.wallet,
        timestamp: time,
        type: SummRowType.Receive,
        baseCurrency: currency,
        baseAmount: amount,
        ...feeIfAny(activity, protocol),
        from: protocol.counterparty,
        to: tcy.wallet,
        blockchain: protocol.blockchain,
        trace: legTrace(tcy),
        description: `1/2 - Claim ${amount} TCY for address ${claimedFor}; ${txid}`,
      },
      staked,
    ];
  }

  const token = getLpTokenName(position.asset.notation, protocol);
  return [
    {
      wallet: position.wallet,
      timestamp: time,
      type: SummRowType.ReturnLpToken,
      baseCurrency: token,
      baseAmount: formatAmount(position.amount),
      ...feeIfAny(activity, protocol),
      from: position.wallet,
      to: protocol.counterparty,
      blockchain: protocol.blockchain,
      trace: legTrace(position),
      description: `1/4 - Return LP token ${token} for a TCY claim (ThorFi collapse); ${txid}`,
    },
    {
      wallet: position.wallet,
      timestamp: plusSeconds(time, 10),
      type: SummRowType.Spam,
      baseCurrency: currency,
      baseAmount: amount,
      from: position.wallet,
      to: protocol.counterparty,
      trace: { role: "price-helper" },
      description: `2/4 - Dummy transaction to get market price to then manually apply to the return LP token transaction ${token}; ${txid}`,
    },
    {
      wallet: tcy.wallet,
      timestamp: plusSeconds(time, 20),
      type: SummRowType.RemoveLiquidity,
      baseCurrency: currency,
      baseAmount: amount,
      from: protocol.counterparty,
      to: tcy.wallet,
      blockchain: protocol.blockchain,
      trace: legTrace(tcy),
      description: `3/4 - Claim ${amount} TCY for ${token} of address ${claimedFor} (ThorFi collapse); ${txid}`,
    },
    staked,
  ];
}

export function tcyStakeRows(activity: Activity, protocol: Protocol): SummRow[] {
  const isStake = activity.kind === "tcy.stake";
  const tcy = leg(activity, "principal");
  const amount = formatAmount(tcy.amount);
  const time = activity.time;

  return [
    {
      wallet: tcy.wallet,
      timestamp: time,
      type: isStake ? SummRowType.StakingDeposit : SummRowType.StakingWithdrawal,
      baseCurrency: parseMidgardAsset(tcy.asset.notation, protocol).currency,
      baseAmount: amount,
      ...feeIfAny(activity, protocol),
      from: isStake ? tcy.wallet : protocol.counterparty,
      to: isStake ? protocol.counterparty : tcy.wallet,
      blockchain: protocol.blockchain,
      trace: legTrace(tcy),
      description: `1/1 - ${isStake ? "Stake" : "Unstake"} ${amount} TCY; ${tcy.txid ?? ""}`,
    },
  ];
}

// A THORName is an expense: the RUNE paid when registering or renewing, and the fee. An update that pays nothing but
// the fee is a Fee row of its own: Summ drops a row with no base amount (docs/specs/fees.md)
export function thornameRows(activity: Activity, protocol: Protocol): SummRow[] {
  const paid = findLeg(activity, "principal", "out");
  const gas = leg(activity, "gas");
  const wallet = paid?.wallet ?? gas.wallet;
  const time = activity.time;

  if (!paid) {
    return [
      {
        wallet,
        timestamp: time,
        type: SummRowType.Fee,
        baseCurrency: parseMidgardAsset(gas.asset.notation, protocol).currency,
        baseAmount: formatAmount(gas.amount),
        from: wallet,
        to: protocol.counterparty,
        blockchain: protocol.blockchain,
        trace: legTrace(gas),
        description: `1/1 - Update Thorname; ${gas.txid ?? ""}`,
      },
    ];
  }

  const amount = formatAmount(paid.amount);
  return [
    {
      wallet,
      timestamp: time,
      type: SummRowType.Expense,
      baseCurrency: parseMidgardAsset(paid.asset.notation, protocol).currency,
      baseAmount: amount,
      ...feeIfAny(activity, protocol),
      from: wallet,
      to: protocol.counterparty,
      blockchain: protocol.blockchain,
      trace: legTrace(paid),
      description: `1/1 - Register/fund Thorname with ${amount} RUNE; ${gas.txid ?? ""}`,
    },
  ];
}

// A TCY distribution is staking income, priced at the RUNE price the API gave for the day
export function tcyDistributionRows(activity: Activity, protocol: Protocol): SummRow[] {
  const reward = leg(activity, "reward");
  const amount = formatAmount(reward.amount);
  const time = activity.time;

  return [
    {
      wallet: reward.wallet,
      timestamp: time,
      type: SummRowType.Staking,
      baseCurrency: parseMidgardAsset(reward.asset.notation, protocol).currency,
      baseAmount: amount,
      from: protocol.counterparty,
      to: reward.wallet,
      blockchain: protocol.blockchain,
      description: `1/1 - Received ${amount} RUNE from TCY staking`,
      trace: legTrace(reward),
      referencePricePerUnit: activity.prices.find((price) => price.source === "midgard:tcy.distribution.price")?.usd,
      referencePriceCurrency: "USD",
    },
  ];
}
