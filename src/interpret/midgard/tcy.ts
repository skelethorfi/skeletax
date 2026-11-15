import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import type { Issue } from "../../domain/Issue.ts";
import type { Interpretation } from "../registry.ts";
import { formatAmount, parseAmount } from "../../domain/Amount.ts";
import { toAsset, toPositionAsset } from "../../domain/Asset.ts";
import { getActionDate, oneCoin, onlyCoin } from "../../sources/thorchain/MidgardUtils.ts";
import { getDistributionDate, type TcyDistributionItem } from "../../sources/tcy/TcyDistributionService.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, getBundleSourceName, type RawBundle } from "../../sources/RawBundle.ts";
import { midgardActionBaseKey } from "../../sources/store/Sources.ts";
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
// comes from the claim list and the claiming address's positions (docs/specs/thorfi-collapse.md): a savers position, or
// a synth the address held (frozen with ThorFi), is given up for the TCY, so it is a leg out; anything else is the TCY
// alone.
export function interpretTcyClaim(bundle: RawBundle, protocol: Protocol): Interpretation {
  const action = bundle.data as Action;
  const input = action.in[0];
  const output = action.out[0];
  const txid = output.txID ?? "";
  const tcy = oneCoin(output, "TCY claim");
  const issues: Issue[] = [];
  const first = isFirstEntry(bundle, tcy.amount);
  // THORNode sends the coins of a claim deposit to the Reserve: the claim does not use them
  if (input.coins.length > 0 && input.address.toLowerCase().startsWith(protocol.nativeAddressPrefix)) {
    issues.push({
      kind: "warning",
      message: `TCY claim deposit carried ${input.coins.map((coin) => `${coin.amount} ${coin.asset}`).join(", ")}, which THORNode sends to the Reserve; no row has it: enter it by hand`,
    });
  }
  const kind = claimKind(bundle, tcy.amount, issues);
  const received =
    kind.for === "other" && kind.times ? { ...tcy, amount: String(BigInt(tcy.amount) * BigInt(kind.times)) } : tcy;
  const givenUp = (asset: Leg["asset"], amount: string): Leg => ({
    direction: "out",
    wallet: input.address,
    asset,
    amount: parseAmount(amount, DECIMALS),
    role: "principal",
    basis: "observed",
    txid,
  });
  const position: Leg[] =
    kind.for === "savers"
      ? [givenUp(toPositionAsset(kind.asset.replace(".", "/")), kind.units)]
      : kind.for === "synth"
        ? [givenUp(toAsset(kind.synth), kind.amount)]
        : [];

  const claim = activity(
    bundle,
    protocol,
    "tcy.claim",
    [
      ...position,
      leg("in", output.address, received, txid),
      ...(input.address === output.address && first ? [{ ...nativeGas(output.address, protocol), txid }] : []),
    ],
    {
      claimedFor: input.address,
      ...(kind.for === "savers" || kind.for === "synth" ? { claimFor: kind.for, asset: kind.asset } : {}),
    },
  );

  return {
    // The first entry is named by the key without its amount, as every claim was before entries had keys of their
    // own (claimAmount): the row IDs of single-entry claims stay the same
    activities: [first ? { ...claim, id: `${getBundleSourceName(bundle)}/${midgardActionBaseKey(action)}` } : claim],
    issues,
  };
}

// A claim tx pays every entry of the address at once, one action each, but the wallet paid the native fee once: on the
// entry whose asset sorts first (an entry of amount 0 pays nothing and has no action). Without the claim list's
// entries, or with one, every action is the first, as before; with several, an action that matches none is not.
function isFirstEntry(bundle: RawBundle, amount: string): boolean {
  const claims = (bundle.tcyClaim?.claims ?? []).filter((claim) => BigInt(claim.amount) > 0n);

  if (claims.length < 2) {
    return true;
  }

  const firstAsset = claims.map((claim) => claim.asset).sort()[0];
  return claims.some((claim) => claim.asset === firstAsset && claim.amount === amount);
}

type ClaimKind =
  | { for: "savers"; asset: string; units: string }
  | { for: "synth"; asset: string; synth: string; amount: string }
  // times: the actions of so many equal entries, kept as one record
  | { for: "other"; times?: number };

// The entry a claim action paid is the one with its amount; a savers position in that asset makes it a savers
// claim, an open loan with that asset as collateral a loan claim, and both share the entry. With neither, a synth of
// that asset the claiming THORChain address held in the block before makes it a synth claim: the whole holding.
function claimKind(bundle: RawBundle, amount: string, issues: Issue[]): ClaimKind {
  const data = bundle.tcyClaim;

  if (!data) {
    return { for: "other" };
  }

  const entries = data.claims.filter((claim) => claim.amount === amount);

  if (entries.length > 1) {
    issues.push({
      kind: "warning",
      message: `TCY claim of ${amount}: ${entries.length} claim-list entries of the address have that amount (${entries.map((claim) => claim.asset).join(", ")}). Their actions are alike and kept as one, which receives the TCY of all ${entries.length}; which asset each was for is not known, so it is a receive`,
    });
    return { for: "other", times: entries.length };
  }

  const entry = entries[0];

  if (!entry) {
    issues.push({
      kind: "warning",
      message: `TCY claim of ${amount}: no claim-list entry of that amount for the address`,
    });
    return { for: "other" };
  }

  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const units = data.savers.find((saver) => same(saver.asset, entry.asset))?.units ?? "0";
  const hasSavers = BigInt(units) > 0n;
  const hasLoan = data.loans.some(
    (loan) =>
      same(loan.collateralAsset, entry.asset) && BigInt(loan.collateralDeposited) > BigInt(loan.collateralWithdrawn),
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

  if (hasSavers) {
    return { for: "savers", asset: entry.asset, units };
  }

  const synthAsset = entry.asset.replace(".", "/");
  const synth = data.synths?.find((held) => same(held.asset, synthAsset) && BigInt(held.amount) > 0n);
  return synth ? { for: "synth", asset: entry.asset, synth: synth.asset, amount: synth.amount } : { for: "other" };
}

// Staking TCY sends it from the wallet; unstaking returns it. Both pay the native fee.
export function interpretTcyStake(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const isStake = (action.type as string) === "tcy_stake";
  const tx = isStake ? action.in[0] : action.out[0];
  const txid = tx.txID ?? "";
  const coin = oneCoin(tx, isStake ? "TCY stake" : "TCY unstake");

  return activity(
    bundle,
    protocol,
    isStake ? "tcy.stake" : "tcy.unstake",
    [leg(isStake ? "out" : "in", tx.address, coin, txid), { ...nativeGas(tx.address, protocol), txid }],
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
  const paid = onlyCoin(input, "THORName");

  return activity(
    bundle,
    protocol,
    "thorname",
    [...(paid ? [leg("out", wallet, paid, txid)] : []), { ...nativeGas(wallet, protocol), txid }],
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
