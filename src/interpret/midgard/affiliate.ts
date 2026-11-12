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

// The affiliate's share of an amount: amount × bps / 10000 rounded half up, as THORNode and Mayanode work it out now
// (common.GetSafeShare); older versions rounded half to even, which differs only on an exact half
export function affiliateCut(amount: bigint, bps: bigint, halfEven = false): bigint {
  const share = (amount * bps + 5000n) / 10000n;
  const exactHalf = (amount * bps) % 10000n === 5000n;
  return halfEven && exactHalf && share % 2n === 1n ? share - 1n : share;
}

// Whether taking each affiliate's cut from a deposit leaves `listed`, under either rounding
export function leavesListed(deposit: bigint, bps: bigint[], listed: bigint): boolean {
  return [false, true].some(
    (halfEven) => deposit - bps.reduce((sum, b) => sum + affiliateCut(deposit, b, halfEven), 0n) === listed,
  );
}

// The deposit that leaves `listed` once each affiliate's cut is taken from it: the smallest such amount, or undefined
// when there is none. Each cut is rounded on its own, so the deposit is within a few units of listed / (1 − fees).
export function amountBeforeCut(listed: bigint, bps: bigint[]): bigint | undefined {
  const total = bps.reduce((sum, b) => sum + b, 0n);

  if (total <= 0n || total >= 10000n) {
    return undefined;
  }

  const estimate = (listed * 10000n) / (10000n - total);
  const span = BigInt(bps.length) + 2n;

  for (let deposit = estimate - span; deposit <= estimate + span; deposit++) {
    if (leavesListed(deposit, bps, listed)) {
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
    // Midgard's amount is the observed coin less the cut, or (a partly filled swap read from THORNode) the coin itself
    const agrees =
      observed.amount === listed.amount || leavesListed(BigInt(observed.amount), bps, BigInt(listed.amount));
    const issues: Issue[] = agrees
      ? []
      : [
          {
            kind: "warning",
            message: `deposit ${txid}: THORNode shows ${observed.amount} sent, but that less an affiliate fee of ${bps.join("/")} bps is not Midgard's ${listed.amount}; THORNode's amount is exported`,
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
