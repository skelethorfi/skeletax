import type { Action, BondMetadata } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import { getActionDate, oneCoin } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";

// Bond and unbond (docs/specs/activity.md). The wallet sends a MsgDeposit with the BOND or UNBOND memo;
// a bond's RUNE goes from the wallet to the bond module, an unbond's comes back. No source gives the gas
// of a MsgDeposit, so it is the protocol's native fee, as a default.
export function interpretBond(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const isBond = (action.type as string) === "bond";
  const request = action.in[0];
  const coin = oneCoin(isBond ? request : action.out[0], isBond ? "bond" : "unbond");

  const requestTxid = request.txID ?? "";
  const principal: Leg = {
    direction: isBond ? "out" : "in",
    wallet: request.address,
    asset: toAsset(coin.asset),
    amount: parseAmount(coin.amount, protocol.decimals(coin.asset)),
    role: "principal",
    basis: "observed",
    txid: isBond ? requestTxid : (action.out[0].txID ?? ""),
  };

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind: isBond ? "bond" : "unbond",
    status: action.status as Activity["status"],
    time: getActionDate(action),
    memo: (action.metadata.bond as BondMetadata).memo,
    legs: [principal, { ...nativeGas(request.address, protocol), txid: requestTxid }],
    prices: [],
    details: { node: (action.metadata.bond as BondMetadata).nodeAddress },
  };
}

export function nativeGas(wallet: string, protocol: Protocol): Leg {
  return {
    direction: "out",
    wallet,
    asset: toAsset(protocol.nativeAsset),
    amount: parseAmount(protocol.defaultGas ?? "0", protocol.decimals(protocol.nativeAsset)),
    role: "gas",
    basis: "default",
  };
}
