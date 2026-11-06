import type { Activity, Leg } from "../../domain/Activity.ts";
import { parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import type { Issue } from "../../domain/Issue.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { memoOf, type ViewblockTx } from "../../sources/viewblock/index.ts";
import { inboundGas } from "../midgard/gas.ts";

// A pending one-sided add withdrawn before it made a position, from Viewblock (docs/specs/fees.md, Pending adds
// that are withdrawn): a refund. The add is the send, with its gas; the withdrawal's payout in the asset added
// is the return; the withdrawal request's native fee is a second gas leg, on the wallet that signed it.
export function interpretPendingWithdraw(
  bundle: RawBundle,
  protocol: Protocol,
): { activities: Activity[]; issues: Issue[] } {
  const withdraw = bundle.data as ViewblockTx;
  const add = bundle.pendingAdd;

  if (!add) {
    return {
      activities: [],
      issues: [
        {
          kind: "warning",
          message: `a withdrawal (${withdraw.hash}) Midgard does not list, with no pending add to pair it with: check what it paid back`,
        },
      ],
    };
  }

  const asset = add.input.asset;
  const decimals = protocol.decimals(asset);
  // An L1 add's sender is in its observation; a THORChain add's is its signer
  const sender =
    add.observation?.from || (asset.startsWith(`${protocol.nativeAsset.split(".")[0]}.`) ? add.signer : "");

  if (!sender) {
    return {
      activities: [],
      issues: [
        {
          kind: "warning",
          message: `a pending add (${add.hash}) with no sender Viewblock observed, withdrawn by ${withdraw.hash}: check what it paid back`,
        },
      ],
    };
  }
  const payouts = (withdraw.outbounds ?? []).filter((out) => out.asset.toUpperCase() === asset.toUpperCase());
  const returned = payouts.reduce((sum, out) => sum + BigInt(out.amount), 0n);
  const returnTxid = payouts.find((out) => out.hash)?.hash;
  const gasSources = {
    thornodeTxs: [],
    viewblockInbounds: add.observation?.gas?.length
      ? [{ hash: add.hash, found: true, gas: add.observation.gas.map(({ asset, amount }) => ({ asset, amount })) }]
      : [],
  };
  const addGas = inboundGas(add.hash, gasSources, sender, asset, protocol);
  const requestGas = inboundGas(withdraw.hash, { thornodeTxs: [] }, withdraw.signer, protocol.nativeAsset, protocol);
  const legs: Leg[] = [
    {
      direction: "out",
      wallet: sender,
      asset: toAsset(asset),
      amount: parseAmount(add.input.amount, decimals),
      role: "principal",
      basis: "observed",
      txid: add.hash,
    },
    ...(addGas ? [{ ...addGas, txid: add.hash }] : []),
    {
      direction: "in",
      wallet: payouts[0]?.to ?? sender,
      asset: toAsset(asset),
      amount: parseAmount(returned.toString(), decimals),
      role: "returned",
      basis: "observed",
      ...(returnTxid ? { txid: returnTxid } : {}),
    },
    ...(requestGas ? [{ ...requestGas, txid: withdraw.hash }] : []),
  ];

  return {
    activities: [
      {
        id: getBundleKey(bundle),
        protocol: protocol.id,
        kind: "refund",
        status: "success",
        time: new Date(add.timestamp),
        memo: memoOf(add),
        legs,
        prices: [],
        details: {
          reason: `pending add withdrawn (${withdraw.hash})`,
          returnTime: new Date(payouts[0]?.timestamp ?? withdraw.timestamp).toISOString(),
          requestTime: new Date(withdraw.timestamp).toISOString(),
        },
      },
    ],
    issues: [],
  };
}
