import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import type { Issue } from "../../domain/Issue.ts";
import type { Interpretation } from "../registry.ts";
import { formatAmount, parseAmount } from "../../domain/Amount.ts";
import { toAsset, toPositionAsset } from "../../domain/Asset.ts";
import { getActionDate } from "../../sources/thorchain/MidgardUtils.ts";
import { getDistributionDate, type TcyDistributionItem } from "../../sources/tcy/TcyDistributionService.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { nativeGas } from "./bond.ts";

// TCY amounts are reported with 8 decimals
const DECIMALS = 8;

const leg = (
  direction: Leg["direction"],
  wallet: string,
  coin: { asset: string; amount: string },
  txid: string,
  role: Leg["role"] = "principal",
): Leg => ({
  direction,
  wallet,
  asset: toAsset(coin.asset),
  amount: parseAmount(coin.amount, DECIMALS),
  role,
  basis: "observed",
  txid,
});

// A TCY claim: TCY paid, staked, to a THORChain wallet for an address that held a claim. The native fee applies only
// when the claim was sent from that same wallet; otherwise it was paid on another chain. What the claim was for
// comes from the claiming address at the height before it (docs/specs/thorfi-collapse.md): a savers position is
// given up for the TCY, so it is the position leg out; anything else is the TCY alone.
export function interpretTcyClaim(bundle: RawBundle, protocol: Protocol): Interpretation {
  const action = bundle.data as Action;
  const input = action.in[0];
  const output = action.out[0];
  const txid = output.txID ?? "";
  const tcy = output.coins[0];
  const issues: Issue[] = [];
  const kind = claimKind(bundle, tcy.amount, issues);
  const position: Leg[] =
    kind.for === "savers"
      ? [
          {
            direction: "out",
            wallet: input.address,
            asset: toPositionAsset(kind.asset.replace(".", "/")),
            amount: parseAmount(kind.units, DECIMALS),
            role: "principal",
            basis: "observed",
            txid,
          },
        ]
      : [];

  return {
    activities: [
      activity(
        bundle,
        protocol,
        "tcy.claim",
        [
          ...position,
          leg("in", output.address, tcy, txid),
          ...(input.address === output.address ? [{ ...nativeGas(output.address, protocol), txid }] : []),
        ],
        { claimedFor: input.address, ...(kind.for === "savers" ? { claimFor: "savers", asset: kind.asset } : {}) },
      ),
    ],
    issues,
  };
}

type ClaimKind = { for: "savers"; asset: string; units: string } | { for: "other" };

// The entry a claim action paid is the one with its amount; a savers record of that asset with units makes it a
// savers claim, an open loan with that asset as collateral a loan claim, and both share the entry
function claimKind(bundle: RawBundle, amount: string, issues: Issue[]): ClaimKind {
  const data = bundle.tcyClaim;

  if (!data) {
    return { for: "other" };
  }

  const entry = data.claims.find((claim) => claim.amount === amount);

  if (!entry) {
    issues.push({
      kind: "warning",
      message: `TCY claim of ${amount}: no claim entry of that amount at the height before it`,
    });
    return { for: "other" };
  }

  const units = data.savers.find((saver) => saver.asset === entry.asset)?.units ?? "0";
  const hasSavers = BigInt(units) > 0n;
  const hasLoan = data.loans.some(
    (loan) =>
      loan.collateralAsset === entry.asset && BigInt(loan.collateralDeposited) > BigInt(loan.collateralWithdrawn),
  );

  if (hasSavers && hasLoan) {
    issues.push({
      kind: "warning",
      message: `TCY claim for ${entry.asset}: the address had a savers position and a loan in it, one claim for both; exported as a receive`,
    });
    return { for: "other" };
  }

  if (hasLoan) {
    issues.push({
      kind: "warning",
      message: `TCY claim for ${entry.asset}: a loan's claim, exported as a receive (the loan's end is not exported yet)`,
    });
    return { for: "other" };
  }

  return hasSavers ? { for: "savers", asset: entry.asset, units } : { for: "other" };
}

// Staking TCY sends it from the wallet; unstaking returns it. Both pay the native fee.
export function interpretTcyStake(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const isStake = (action.type as string) === "tcy_stake";
  const tx = isStake ? action.in[0] : action.out[0];
  const txid = tx.txID ?? "";

  return activity(
    bundle,
    protocol,
    isStake ? "tcy.stake" : "tcy.unstake",
    [leg(isStake ? "out" : "in", tx.address, tx.coins[0], txid), { ...nativeGas(tx.address, protocol), txid }],
    {},
  );
}

// A THORName registration or renewal pays RUNE to the protocol; an update pays nothing but the native fee.
// An update can have no input address: the wallet is the name's owner.
export function interpretThorname(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const input = action.in[0];
  const metadata = (action.metadata as any).thorname;
  const wallet = input.address || metadata?.owner || "";
  const txid = input.txID ?? "";

  return activity(
    bundle,
    protocol,
    "thorname",
    [
      ...(input.coins.length ? [leg("out", wallet, input.coins[0], txid)] : []),
      { ...nativeGas(wallet, protocol), txid },
    ],
    metadata?.thorname ? { name: metadata.thorname } : {},
  );
}

// A TCY distribution: RUNE paid daily to TCY stakers, income for the wallet it was listed for. The API
// gives the RUNE price in USD at the time.
export function interpretTcyDistribution(bundle: RawBundle, protocol: Protocol): Activity {
  const item = bundle.data as TcyDistributionItem;
  const rune = toAsset(protocol.nativeAsset);

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind: "tcy.distribution",
    status: "success",
    time: getDistributionDate(item),
    legs: [
      {
        direction: "in",
        wallet: bundle.wallet,
        asset: rune,
        amount: parseAmount(item.amount, DECIMALS),
        role: "reward",
        basis: "observed",
      },
    ],
    prices: [
      { asset: rune, usd: formatAmount(parseAmount(item.price, DECIMALS)), source: "midgard:tcy.distribution.price" },
    ],
    details: {},
  };
}

function activity(
  bundle: RawBundle,
  protocol: Protocol,
  kind: Activity["kind"],
  legs: Leg[],
  details: Record<string, string>,
): Activity {
  const action = bundle.data as Action;

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind,
    status: action.status as Activity["status"],
    time: getActionDate(action),
    legs,
    prices: [],
    details,
  };
}
