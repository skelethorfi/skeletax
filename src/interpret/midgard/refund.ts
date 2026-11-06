import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import type { Issue } from "../../domain/Issue.ts";
import { getActionDate } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { inboundGas } from "./gas.ts";

// A refund (docs/specs/fees.md): the wallet sent an amount in, and the protocol returned all or part of
// it, or, for a stuck one still pending, nothing yet (docs/specs/pending.md). Two refunds are not the wallet's own and give no activity: the refund of an affiliate's cut, which
// the wallet never sent, and the refund for the unfilled part of a partially filled swap, which the swap
// with the same txid already accounts for.
export function interpretRefund(bundle: RawBundle, protocol: Protocol): { activities: Activity[]; issues: Issue[] } {
  const action = bundle.data as Action;
  const input = action.in[0];
  const inputCoin = input.coins[0];
  const inputAsset = toAsset(inputCoin.asset);

  // THORChain swaps an affiliate's cut to RUNE as a swap of its own, carrying the user's txid and address.
  // THORNode shows what the wallet did send.
  const sentCoins = bundle.thornodeTxs.find((tx) => tx.tx?.id === input.txID)?.tx?.coins;

  if (sentCoins && !sentCoins.some((coin) => coin.asset.toUpperCase() === inputCoin.asset.toUpperCase())) {
    return {
      activities: [],
      issues: [{ kind: "ignored", message: "refund of an affiliate's cut, which the wallet did not send" }],
    };
  }

  const returnedCoins = action.out.flatMap((out) => out.coins);

  if (returnedCoins.some((coin) => coin.asset !== inputCoin.asset)) {
    return {
      activities: [],
      issues: [{ kind: "ignored", message: "refund of a partially filled swap, which the swap accounts for" }],
    };
  }

  const decimals = protocol.decimals(inputCoin.asset);
  const returned = returnedCoins.reduce((sum, coin) => sum + BigInt(coin.amount), 0n);
  const txid = input.txID ?? "";
  const returnTxid = action.out.find((out) => out.txID)?.txID;
  const legs: Leg[] = [
    {
      direction: "out",
      wallet: input.address,
      asset: inputAsset,
      amount: parseAmount(inputCoin.amount, decimals),
      role: "principal",
      basis: "observed",
      txid,
    },
    ...(returned > 0n
      ? [
          {
            direction: "in",
            // Paid where the payout went: a memo can name a refund address other than the sender (the sender's
            // spelling when it is the same address in another case, as for swaps)
            wallet: returnWallet(action.out.find((out) => out.address)?.address, input.address),
            asset: inputAsset,
            amount: parseAmount(returned.toString(), decimals),
            role: "returned",
            basis: "observed",
            ...(returnTxid ? { txid: returnTxid } : {}),
          } as Leg,
        ]
      : []),
  ];
  const gas = inboundGas(txid, bundle, input.address, inputCoin.asset, protocol);
  const reason = ((action.metadata.refund as any)?.reason ?? "").replace(/[\n\t]/g, " ").trim();
  // The source exports a pending refund only once it is stuck (docs/specs/pending.md)
  const issues: Issue[] =
    action.status === "pending"
      ? [
          {
            kind: "warning",
            message:
              "refund still pending past the cut-off: what was not returned is exported as lost; check it never came back",
          },
        ]
      : [];

  return {
    activities: [
      {
        id: getBundleKey(bundle),
        protocol: protocol.id,
        kind: "refund",
        status: action.status as Activity["status"],
        time: getActionDate(action),
        memo: (action.metadata.refund as any)?.memo || undefined,
        legs: gas ? [...legs, { ...gas, txid }] : legs,
        prices: [],
        details: { reason },
      },
    ],
    issues,
  };
}

function returnWallet(paid: string | undefined, sender: string): string {
  return !paid || paid.toLowerCase() === sender.toLowerCase() ? sender : paid;
}
