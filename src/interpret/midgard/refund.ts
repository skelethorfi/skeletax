import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { formatAmount, parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import type { Issue } from "../../domain/Issue.ts";
import { getActionDate, oneCoin } from "../../sources/thorchain/MidgardUtils.ts";
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
  const inputCoin = oneCoin(input, "refund");
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
  // Each address paid, in its own spelling, once whatever its case
  const returnAddresses = [
    ...new Map(action.out.filter((out) => out.address).map((out) => [out.address.toLowerCase(), out.address])).values(),
  ];
  // The return is in the wallet it was paid to: the sender, or the refund address the memo gives after its
  // destination (docs/specs/activity.md, The memo's destination). Paid to several addresses, it stays with the sender.
  const returnWallet =
    returnAddresses.length === 1 && returnAddresses[0].toLowerCase() !== input.address.toLowerCase()
      ? returnAddresses[0]
      : input.address;
  const returnedAmount = parseAmount(returned.toString(), decimals);
  // The payout to that wallet, else the first
  const returnTxid = (
    action.out.find((out) => out.txID && out.address?.toLowerCase() === returnWallet.toLowerCase()) ??
    action.out.find((out) => out.txID)
  )?.txID;
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
            wallet: returnWallet,
            asset: inputAsset,
            amount: returnedAmount,
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
  const issues: Issue[] = [
    ...(action.status === "pending"
      ? [
          {
            kind: "warning" as const,
            message:
              "refund still pending past the cut-off: what was not returned is exported as lost; check it never came back",
          },
        ]
      : []),
    ...(returned > 0n && returnAddresses.length > 1
      ? [
          {
            kind: "warning" as const,
            message: `the ${formatAmount(returnedAmount)} ${inputCoin.asset} returned was paid to several addresses (${returnAddresses.join(", ")}): its leg is on the sender; check where it went`,
          },
        ]
      : []),
    ...(returned > 0n && returnWallet !== input.address
      ? [
          {
            kind: "warning" as const,
            message: `the ${formatAmount(returnedAmount)} ${inputCoin.asset} returned went to ${returnWallet}, not the sender: no row moves it there, so record that transfer by hand`,
          },
        ]
      : []),
  ];

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
