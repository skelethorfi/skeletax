import type { Action, Transaction } from "@xchainjs/xchain-midgard";
import type { Activity, Leg, Price } from "../../domain/Activity.ts";
import { formatAmount, parseAmount } from "../../domain/Amount.ts";
import { type Asset, toAsset } from "../../domain/Asset.ts";
import type { Issue } from "../../domain/Issue.ts";
import { getActionDate, parseMidgardAsset } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { inboundGas } from "./gas.ts";

// https://dev.thorchain.org/concepts/memos.html#swap
const SWAP_DESTADDR = 2;

// A swap (docs/specs/activity.md): the wallet sends one asset in, and the protocol pays another out to
// the memo's destination. Affiliate outputs are the protocol's fees, already deducted, so they are not
// legs (docs/specs/fees.md). A streaming swap can return its unfilled part to the sender.
export function interpretSwap(bundle: RawBundle, protocol: Protocol): { activities: Activity[]; issues: Issue[] } {
  const action = bundle.data as Action;

  if (action.in.length !== 1) {
    throw new Error(`swap: expected 1 input but there were ${action.in.length}`);
  }

  const input = action.in[0];
  const inputCoin = input.coins[0];
  const inputAsset = toAsset(inputCoin.asset);

  // A synth swapped from an L1 address is a savers withdrawal's internal leg, not the wallet's swap
  if (inputCoin.asset.includes("/") && !input.address.toLowerCase().startsWith(protocol.nativeAddressPrefix)) {
    return {
      activities: [],
      issues: [{ kind: "ignored", message: "synth swap from an L1 address (a savers withdrawal)" }],
    };
  }

  if (action.status === "pending") {
    return stuckSwap(bundle, protocol);
  }

  const output = getOutput(action);
  const outputCoin = output.coins[0];
  const outputAsset = toAsset(outputCoin.asset);

  // Can appear with lending transactions
  if (inputCoin.asset === "THOR.TOR" || outputCoin.asset === "THOR.TOR") {
    throw new Error("swap: invalid swap - THOR.TOR");
  }

  const amount = (coin: { asset: string; amount: string }) => parseAmount(coin.amount, protocol.decimals(coin.asset));
  const returnOutputs = getReturnOutputs(action, input, output);
  const returned = returnOutputs
    .flatMap((out) => out.coins)
    .filter((coin) => coin.asset === inputCoin.asset)
    .reduce((sum, coin) => sum + BigInt(coin.amount), 0n);
  const { sent, issues } = sentCoin(action, inputCoin, returned, protocol);

  if (returned >= BigInt(sent.amount)) {
    throw new Error(`swap: returned ${returned} of ${sent.amount} sent, so nothing was swapped`);
  }

  const txid = input.txID ?? "";
  // The token an aggregator delivered, when the pool asset was only passing through (docs/specs/activity.md)
  const payout = bundle.tokenPayout?.token;
  const received = payout
    ? { asset: deliveredAsset(bundle), amount: parseAmount(payout.amount, payout.decimals) }
    : { asset: outputAsset, amount: amount(outputCoin) };
  const legs: Leg[] = [
    {
      direction: "out",
      wallet: input.address,
      asset: inputAsset,
      amount: amount(sent),
      role: "principal",
      basis: "observed",
      txid,
    },
    ...(returned > 0n
      ? [
          {
            direction: "in",
            wallet: input.address,
            asset: inputAsset,
            amount: amount({ asset: inputCoin.asset, amount: returned.toString() }),
            role: "returned",
            basis: "observed",
            ...(returnOutputs[0].txID ? { txid: returnOutputs[0].txID } : {}),
          } as Leg,
        ]
      : []),
    {
      direction: "in",
      wallet: output.address,
      asset: received.asset,
      amount: received.amount,
      role: "principal",
      basis: "observed",
      ...(output.txID ? { txid: output.txID } : {}),
    },
  ];
  const gas = inboundGas(txid, bundle, input.address, inputCoin.asset, protocol);

  return {
    activities: [
      {
        id: getBundleKey(bundle),
        protocol: protocol.id,
        kind: "swap",
        status: action.status as Activity["status"],
        time: getActionDate(action),
        memo: action.metadata.swap?.memo,
        legs: gas ? [...legs, { ...gas, txid }] : legs,
        prices: getPrices(action, inputCoin.asset, outputCoin.asset),
        details: payout ? { paidVia: `${formatAmount(amount(outputCoin))} ${outputCoin.asset}` } : {},
      },
    ],
    issues: [
      ...issues,
      ...(bundle.tokenPayout && !payout
        ? [
            {
              kind: "warning" as const,
              message: `the memo names a final token but no such transfer reached the wallet: ${outputCoin.asset} is exported; check what ${output.txID} paid`,
            },
          ]
        : []),
    ],
  };
}

// What the wallet sent (docs/specs/fees.md, Partially filled swaps). A streaming swap that filled only partly lists as
// its input only the part swapped; the deposit is streamingSwapMeta.depositedCoin, and a refund action of the same txid
// returns the rest. Until that return is paid, only the part swapped is exported: the refund's own rows cover the rest.
function sentCoin(
  action: Action,
  inputCoin: { asset: string; amount: string },
  returned: bigint,
  protocol: Protocol,
): { sent: { asset: string; amount: string }; issues: Issue[] } {
  const deposited = action.metadata.swap?.streamingSwapMeta?.depositedCoin;

  if (!deposited || deposited.asset !== inputCoin.asset || BigInt(deposited.amount) <= BigInt(inputCoin.amount)) {
    return { sent: inputCoin, issues: [] };
  }

  if (returned === 0n) {
    const unfilled = parseAmount(
      (BigInt(deposited.amount) - BigInt(inputCoin.amount)).toString(),
      protocol.decimals(inputCoin.asset),
    );
    return {
      sent: inputCoin,
      issues: [
        {
          kind: "warning",
          message: `streaming swap filled only partly and its unfilled ${formatAmount(unfilled)} ${inputCoin.asset} is not returned yet: only the part swapped is exported until the refund is paid`,
        },
      ],
    };
  }

  return { sent: deposited, issues: [] };
}

// The token as Midgard would name it. A symbol that would read as another currency (UNI-V2 as UNI, LUNA as LUNC), or that a CSV
// or a Summ view can't hold (A/B reads as a synth), stops the action rather than record the wrong asset.
function deliveredAsset(bundle: RawBundle): Asset {
  const { chain, token } = bundle.tokenPayout!;
  const symbol = token!.symbol.toUpperCase();
  const notation = `${chain}.${symbol}-${token!.contract.toUpperCase()}`;

  if (/[/\s\p{Cc}]/u.test(symbol) || parseMidgardAsset(notation).currency !== symbol) {
    throw new Error(`swap: token symbol "${token!.symbol}" (${token!.contract}) does not fit asset notation`);
  }

  return toAsset(notation);
}

// A swap still pending past the cut-off that paid nothing out, which the source exports only then: the wallet
// sent its coin and nothing came back, so it is exported like a stuck refund (docs/specs/pending.md)
function stuckSwap(bundle: RawBundle, protocol: Protocol): { activities: Activity[]; issues: Issue[] } {
  const action = bundle.data as Action;
  const input = action.in[0];
  const inputCoin = input.coins[0];

  if (action.out.some((out) => out.coins.length > 0)) {
    throw new Error("swap: still pending with coins paid out");
  }

  const txid = input.txID ?? "";
  const sent: Leg = {
    direction: "out",
    wallet: input.address,
    asset: toAsset(inputCoin.asset),
    amount: parseAmount(inputCoin.amount, protocol.decimals(inputCoin.asset)),
    role: "principal",
    basis: "observed",
    txid,
  };
  const gas = inboundGas(txid, bundle, input.address, inputCoin.asset, protocol);

  return {
    activities: [
      {
        id: getBundleKey(bundle),
        protocol: protocol.id,
        kind: "swap",
        status: "pending",
        time: getActionDate(action),
        memo: action.metadata.swap?.memo,
        legs: gas ? [sent, { ...gas, txid }] : [sent],
        prices: [],
        details: { reason: "still pending past the cut-off, nothing paid out" },
      },
    ],
    issues: [
      {
        kind: "warning",
        message:
          "swap still pending past the cut-off with nothing paid out: what was sent is exported as lost; check nothing came back",
      },
    ],
  };
}

function getPrices(action: Action, inputAsset: string, outputAsset: string): Price[] {
  const swap = action.metadata.swap;
  const prices: Price[] = [];

  if (swap?.inPriceUSD) {
    prices.push({ asset: toAsset(inputAsset), usd: swap.inPriceUSD, source: "midgard:swap.inPriceUSD" });
  }

  if (swap?.outPriceUSD) {
    prices.push({ asset: toAsset(outputAsset), usd: swap.outPriceUSD, source: "midgard:swap.outPriceUSD" });
  }

  return prices;
}

// The outputs, other than the swap output, that return the input asset to the sender
function getReturnOutputs(action: Action, input: Transaction, output: Transaction): Transaction[] {
  const inputAsset = input.coins[0].asset;

  return action.out.filter(
    (out) =>
      out !== output &&
      out.address.toLowerCase() === input.address.toLowerCase() &&
      out.coins.some((coin) => coin.asset === inputAsset),
  );
}

// The output paid to the memo's destination; there may also be outputs for affiliates
function getOutput(action: Action): Transaction {
  const memo = action.metadata.swap?.memo;

  if (!memo) {
    throw new Error("swap: no memo");
  }

  const destAddress = memo.split(":")[SWAP_DESTADDR];

  if (!destAddress) {
    // A swap memo with an empty destination (e.g. =:ARB.ETH:::wr:0). Maya paid such a swap out to
    // the sender's address (same EVM address on another chain). Only accept an output in a different
    // asset from the input, so a refund of the input is never read as the swap.
    // (A send to a vault with no memo at all is refunded, and Midgard reports it as a refund action.)
    const sender = action.in[0].address.toLowerCase();
    const inputAsset = action.in[0].coins[0]?.asset;
    const out = action.out.find((out) => out.address.toLowerCase() === sender && out.coins[0]?.asset !== inputAsset);

    if (!out) {
      throw new Error("swap: no matching out tx");
    }

    return out;
  }

  const out = action.out.find((out) => out.address.toLowerCase() === destAddress.toLowerCase());

  if (!out) {
    throw new Error("swap: no matching out tx");
  }

  return out;
}
