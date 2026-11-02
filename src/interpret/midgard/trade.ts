import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import { getActionDate } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { inboundGas } from "./gas.ts";

// A trade account deposit or withdrawal (docs/specs/trade.md): an L1 asset sent in and credited to a THORChain
// address as the trade asset (BTC.BTC → BTC~BTC), or a trade asset sent in and paid out on its L1 chain, less the
// outbound fee
export function interpretTrade(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;
  const input = action.in[0];
  const output = action.out[0];
  const sent = input?.coins[0];
  const received = output?.coins[0];

  if (!sent || !received || action.in.length !== 1 || action.out.length !== 1) {
    throw new Error(`trade: expected one coin in and one out, got ${action.in.length} in, ${action.out.length} out`);
  }

  const isWithdraw = toAsset(sent.asset).kind === "trade";

  if (isWithdraw === (toAsset(received.asset).kind === "trade")) {
    throw new Error(`trade: ${sent.asset} to ${received.asset} is neither a deposit nor a withdrawal`);
  }

  // The outbound fee is kept from what was sent, so nothing pays out more (docs/specs/trade.md)
  if (BigInt(received.amount) > BigInt(sent.amount)) {
    throw new Error(
      `trade: ${received.amount} ${received.asset} paid out, more than the ${sent.amount} ${sent.asset} sent`,
    );
  }

  const leg = (direction: Leg["direction"], wallet: string, coin: { asset: string; amount: string }, txid: string) =>
    ({
      direction,
      wallet,
      asset: toAsset(coin.asset),
      amount: parseAmount(coin.amount, protocol.decimals(coin.asset)),
      role: "principal",
      basis: "observed",
      txid,
    }) satisfies Leg;
  const txid = input.txID ?? "";
  // A deposit's gas is the L1 tx's; a withdrawal is sent on THORChain and pays the native fee
  const gas = inboundGas(txid, bundle, input.address, sent.asset, protocol);

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind: isWithdraw ? "trade.withdraw" : "trade.deposit",
    status: action.status as Activity["status"],
    time: getActionDate(action),
    legs: [
      leg("out", input.address, sent, txid),
      ...(gas ? [{ ...gas, txid }] : []),
      leg("in", output.address, received, output.txID ?? ""),
    ],
    prices: [],
    details: {},
  };
}
