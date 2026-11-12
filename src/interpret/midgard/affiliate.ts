import type { Basis } from "../../domain/Activity.ts";
import type { Issue } from "../../domain/Issue.ts";
import type { RawBundle } from "../../sources/RawBundle.ts";

// A deposit that Midgard lists after an affiliate cut (docs/specs/fees.md, Affiliate cut taken from a deposit)

interface Coin {
  asset: string;
  amount: string;
}

// The coin THORNode's inbound status shows the tx sent, when the bundle has it
export function inboundCoin(bundle: Pick<RawBundle, "thornodeTxs">, txid: string, asset: string): Coin | undefined {
  return bundle.thornodeTxs
    .find((tx) => !!txid && tx.tx?.id?.toUpperCase() === txid.toUpperCase())
    ?.tx?.coins?.find((coin) => coin.asset.toUpperCase() === asset.toUpperCase());
}

// The affiliate's share of an amount: amount × bps / 10000, rounded half up, as THORNode and Mayanode work it out
// (common.GetSafeShare)
export function affiliateCut(amount: bigint, bps: bigint): bigint {
  return (amount * bps + 5000n) / 10000n;
}

// The deposit that leaves `listed` once each affiliate's cut is taken from it: the smallest such amount, or undefined
// when there is none
export function amountBeforeCut(listed: bigint, bps: bigint[]): bigint | undefined {
  const total = bps.reduce((sum, b) => sum + b, 0n);

  if (total <= 0n || total >= 10000n) {
    return undefined;
  }

  const estimate = (listed * 10000n) / (10000n - total);

  for (let deposit = estimate - 2n; deposit <= estimate + 2n; deposit++) {
    if (deposit - bps.reduce((sum, b) => sum + affiliateCut(deposit, b), 0n) === listed) {
      return deposit;
    }
  }

  return undefined;
}

// What the wallet deposited, when Midgard lists the deposit after the affiliate cut: the coin the chain shows it sent
// (observed) when the bundle has it, else Midgard's coin grossed up by the fees (default)
export function depositBeforeCut(
  listed: Coin,
  bps: bigint[],
  observed: Coin | undefined,
  txid: string,
): { coin: Coin; basis: Basis; issues: Issue[] } {
  const derived = amountBeforeCut(BigInt(listed.amount), bps);
  const sameAsset = observed && observed.asset.toUpperCase() === listed.asset.toUpperCase();

  if (sameAsset && BigInt(observed.amount) >= BigInt(listed.amount)) {
    const issues: Issue[] =
      derived === BigInt(observed.amount)
        ? []
        : [
            {
              kind: "warning",
              message: `deposit ${txid}: the chain shows ${observed.amount} sent, but Midgard's ${listed.amount} less an affiliate fee of ${bps.join("/")} bps does not come from it; the amount the chain shows is exported`,
            },
          ];
    return { coin: { asset: listed.asset, amount: observed.amount }, basis: "observed", issues };
  }

  if (derived === undefined) {
    return {
      coin: listed,
      basis: "observed",
      issues: [
        {
          kind: "warning",
          message: `deposit ${txid}: no amount less an affiliate fee of ${bps.join("/")} bps leaves Midgard's ${listed.amount}, so Midgard's amount is exported; check the amount sent`,
        },
      ],
    };
  }

  return { coin: { asset: listed.asset, amount: derived.toString() }, basis: "default", issues: [] };
}
