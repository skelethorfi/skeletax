import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import { getActionDate, oneCoin } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { nativeGas } from "./bond.ts";
import { inboundGas } from "./gas.ts";

// A switch (docs/specs/activity.md): an asset from another chain (e.g. BEP2 RUNE, Cosmos KUJI) sent in and
// the same asset minted on THORChain
export function interpretSwitch(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const input = action.in[0];
  const output = action.out[0];
  const leg = (
    direction: Leg["direction"],
    wallet: string,
    coin: { asset: string; amount: string },
    txid: string,
  ): Leg => ({
    direction,
    wallet,
    asset: toAsset(coin.asset),
    amount: parseAmount(coin.amount, protocol.decimals(coin.asset)),
    role: "principal",
    basis: "observed",
    txid,
  });
  const sent = oneCoin(input, "switch");
  const received = oneCoin(output, "switch");
  const txid = input.txID ?? "";
  const gas = inboundGas(txid, bundle, input.address, sent.asset, protocol);

  return activity(bundle, protocol, "switch", [
    leg("out", input.address, sent, txid),
    ...(gas ? [{ ...gas, txid }] : []),
    leg("in", output.address, received, output.txID ?? ""),
  ]);
}

// RUNEPool: RUNE deposited for RUNEPool units, or units returned for RUNE. Both are sent from a THORChain
// wallet and pay the native fee.
export function interpretRunePool(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const isDeposit = (action.type as string) === "runePoolDeposit";
  const tx = isDeposit ? action.in[0] : action.out[0];
  const coin = oneCoin(tx, isDeposit ? "RUNEPool deposit" : "RUNEPool withdrawal");
  const meta = (action.metadata as any)[isDeposit ? "runePoolDeposit" : "runePoolWithdraw"];
  const units = meta?.units ?? "";
  // A withdrawal's coin is what left RUNEPool; THORNode pays the affiliate's share of it first (docs/specs/fees.md)
  const affiliateAmount = !isDeposit && /^\d+$/.test(meta?.affiliateAmount ?? "") ? BigInt(meta.affiliateAmount) : 0n;
  const received = BigInt(coin.amount) - affiliateAmount;
  const txid = tx.txID ?? "";
  const rune: Leg = {
    direction: isDeposit ? "out" : "in",
    wallet: tx.address,
    asset: toAsset(coin.asset),
    amount: parseAmount(received.toString(), protocol.decimals(coin.asset)),
    role: "principal",
    basis: "observed",
    txid,
  };
  const position: Leg = {
    direction: isDeposit ? "in" : "out",
    wallet: tx.address,
    asset: { notation: protocol.nativeAsset, kind: "position", position: "runepool" },
    amount: parseAmount(units, 8),
    role: "principal",
    basis: "observed",
    txid,
  };
  const gas = { ...nativeGas(tx.address, protocol), txid };

  return activity(
    bundle,
    protocol,
    isDeposit ? "runepool.deposit" : "runepool.withdraw",
    isDeposit ? [rune, gas, position] : [position, gas, rune],
  );
}

function activity(bundle: RawBundle, protocol: Protocol, kind: Activity["kind"], legs: Leg[]): Activity {
  const action = bundle.data as Action;

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind,
    status: action.status as Activity["status"],
    time: getActionDate(action),
    legs,
    prices: [],
    details: {},
  };
}
