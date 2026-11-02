import type { Action } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { formatAmount, parseAmount } from "../../domain/Amount.ts";
import { toAsset, toPositionAsset } from "../../domain/Asset.ts";
import type { Issue } from "../../domain/Issue.ts";
import { getActionDate, onlyCoin, parseMidgardAsset } from "../../sources/thorchain/MidgardUtils.ts";
import { type Protocol, THORCHAIN } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { isDonateAdd, midgardActionKey } from "../../sources/store/Sources.ts";
import { inboundGas } from "./gas.ts";

// Liquidity units and savers units are reported with 8 decimals
const UNIT_DECIMALS = 8;

// An add to a liquidity pool or savers vault (docs/specs/activity.md, savers.md): each deposit is sent in,
// each followed by its own gas leg, and the position comes back to the first depositor's wallet.
export function interpretAddLiquidity(
  bundle: RawBundle,
  protocol: Protocol,
): { activities: Activity[]; issues: Issue[] } {
  const action = bundle.data as Action;
  const deposits = action.in;

  if (isDonateAdd(action)) {
    return interpretAuction(bundle, protocol);
  }

  if (deposits.length === 0 || deposits.length > 2) {
    throw new Error(`liquidity: expected 1 or 2 deposits but there were ${deposits.length}`);
  }

  // Two-sided: the native asset (e.g. RUNE) comes first
  if (deposits.length === 2 && deposits[0].coins[0].asset !== protocol.nativeAsset) {
    throw new Error(`liquidity: expected ${protocol.nativeAsset.split(".")[1]} as first asset in LP deposit`);
  }

  const position = toPositionAsset(action.pools[0]);
  const units = parseAmount(action.metadata.addLiquidity?.liquidityUnits ?? "", UNIT_DECIMALS);
  const legs: Leg[] = [];
  const issues: Issue[] = [];

  for (const deposit of deposits) {
    const coin = deposit.coins[0];
    const wallet = deposit.address ?? "";
    // Midgard reports a savers deposit's coin as the synth (BTC/BTC), but a wallet on the asset's own chain
    // sent the L1 asset and paid that chain's gas (savers.md)
    const sentOnL1 = position.position === "savers" && !wallet.toLowerCase().startsWith(protocol.nativeAddressPrefix);
    const sentAsset = sentOnL1 ? coin.asset.replace("/", ".") : coin.asset;
    const txid = deposit.txID ?? "";
    const gas = inboundGas(txid, bundle, wallet, sentAsset, protocol);
    // Midgard's coin is the synth minted, after the swap's fee; what the wallet sent is THORNode's inbound coin,
    // or else the coin of the deposit's swap into the synth (Maya's only source)
    const isSentCoin = (c: { asset: string }) => c.asset.toUpperCase() === sentAsset.toUpperCase();
    const status =
      sentOnL1 && protocol.id === THORCHAIN.id ? bundle.thornodeTxs.find((tx) => tx.tx?.id === txid) : undefined;
    const swapIn = sentOnL1
      ? bundle.depositSwap?.in.find((tx) => tx.txID?.toUpperCase() === txid.toUpperCase())
      : undefined;
    const sent = status?.tx?.coins?.find(isSentCoin) ?? swapIn?.coins.find(isSentCoin);

    if (sentOnL1 && !sent) {
      const swapReason = swapIn ? `its swap has no ${sentAsset} coin` : "Midgard lists no swap for it";
      const nodeReason =
        protocol.id !== THORCHAIN.id
          ? `${protocol.id} inbounds are not looked up on a node`
          : status
            ? `THORNode's inbound has no ${sentAsset} coin`
            : "THORNode has no inbound for the tx";
      const reason = `${nodeReason} and ${swapReason}`;
      issues.push({
        kind: "warning",
        message: `savers deposit ${txid}: ${reason}, so the amount is the synth minted, not the ${sentAsset} sent`,
      });
    }

    legs.push({
      direction: "out",
      wallet,
      asset: toAsset(sentAsset),
      amount: parseAmount(sent?.amount ?? coin.amount, protocol.decimals(coin.asset)),
      role: "principal",
      basis: "observed",
      txid,
    });

    if (gas) {
      legs.push({ ...gas, txid });
    }
  }

  legs.push({
    direction: "in",
    wallet: deposits[0].address ?? "",
    asset: position,
    amount: units,
    role: "principal",
    basis: "observed",
  });

  return {
    activities: [activity(bundle, protocol, position.position === "savers" ? "savers.add" : "lp.add", legs)],
    issues: [
      ...issues,
      ...(deposits[0].address ? [] : [{ kind: "warning" as const, message: "missing deposit address" }]),
    ],
  };
}

// Maya's liquidity auction (docs/specs/maya.md). Each participant's position has a CACAO side the auction supplied
// (received, as a reward leg, then added) and a side of the deposited asset (RUNE, BTC, ETH, USDT or USDC). RUNE
// deposits, sent on THORChain, are found (the bundle's inbounds): each is an add of its own at its date, and any
// RUNE above them is supplied by the auction too. Deposits on another chain are not listed by any source read
// here, nor RUNE deposits that were not found: the side is then added at the auction's end, with a note.
function interpretAuction(bundle: RawBundle, protocol: Protocol): { activities: Activity[]; issues: Issue[] } {
  const action = bundle.data as Action;
  const cacaoSide = action.in.find((tx) => tx.txID)!;
  const side = action.in.find((tx) => !tx.txID)!;
  const sideCoin = side.coins[0];
  const amountOf = (asset: string, amount: string | bigint) => parseAmount(amount.toString(), protocol.decimals(asset));
  const sends = bundle.inbounds ?? [];
  const deposited = sends.reduce((sum, send) => sum + BigInt(send.in[0].coins[0].amount), 0n);
  const extra = BigInt(sideCoin.amount) - deposited;
  const deposits: Activity[] = sends.map((send) => {
    const txid = send.in[0].txID ?? "";
    const wallet = send.in[0].address;
    const gas = inboundGas(txid, { thornodeTxs: [] }, wallet, sideCoin.asset, protocol);

    return {
      id: `midgard/${midgardActionKey(send)}`,
      protocol: protocol.id,
      kind: "lp.auction.deposit",
      status: "success",
      time: getActionDate(send),
      memo: (send.metadata as any)?.send?.memo || undefined,
      legs: [
        {
          direction: "out",
          wallet,
          asset: toAsset(sideCoin.asset),
          amount: amountOf(sideCoin.asset, send.in[0].coins[0].amount),
          role: "principal",
          basis: "observed",
          txid,
        },
        ...(gas ? [{ ...gas, txid }] : []),
      ],
      prices: [],
      details: { pool: action.pools[0] },
    };
  });
  // The CACAO side's legs and the position are in the tx that added it; the other side has no txid
  const txid = cacaoSide.txID ?? "";
  const onTx = (wallet: string) => (wallet === cacaoSide.address && txid ? { txid } : {});
  const supplied = (wallet: string, asset: string, amount: Leg["amount"]): Leg[] => [
    { direction: "in", wallet, asset: toAsset(asset), amount, role: "reward", basis: "observed", ...onTx(wallet) },
    { direction: "out", wallet, asset: toAsset(asset), amount, role: "principal", basis: "observed", ...onTx(wallet) },
  ];
  const added = (wallet: string, asset: string, amount: Leg["amount"]): Leg => ({
    direction: "out",
    wallet,
    asset: toAsset(asset),
    amount,
    role: "principal",
    basis: "observed",
  });
  const cacao = cacaoSide.coins[0];
  const legs: Leg[] = [
    ...supplied(cacaoSide.address, cacao.asset, amountOf(cacao.asset, cacao.amount)),
    ...(sends.length === 0
      ? [added(side.address, sideCoin.asset, amountOf(sideCoin.asset, sideCoin.amount))]
      : extra > 0n
        ? supplied(side.address, sideCoin.asset, amountOf(sideCoin.asset, extra))
        : []),
    {
      direction: "in",
      wallet: cacaoSide.address,
      asset: toPositionAsset(action.pools[0]),
      amount: parseAmount(action.metadata.addLiquidity?.liquidityUnits ?? "", UNIT_DECIMALS),
      role: "principal",
      basis: "observed",
      ...onTx(cacaoSide.address),
    },
  ];
  const position = {
    ...activity(bundle, protocol, "lp.auction.position", legs),
    details: {
      pool: action.pools[0],
      side: formatAmount(amountOf(sideCoin.asset, sideCoin.amount)),
      sideAsset: sideCoin.asset,
    },
  };
  const chain = sideCoin.asset.split(".")[0];
  const currency = parseMidgardAsset(sideCoin.asset, protocol).currency;
  const sideAmount = `${formatAmount(amountOf(sideCoin.asset, sideCoin.amount))} ${currency}`;
  const notFound =
    chain === THORCHAIN.nativeChain
      ? `the ${currency} deposits were not found among the wallet's THORChain sends`
      : `the ${currency} deposits were sent on the ${chain} chain, which this tool does not read`;
  const issues: Issue[] =
    sends.length === 0
      ? [
          {
            kind: "manual",
            message:
              `Maya liquidity auction (${action.pools[0]}): ${notFound}, so the side, ${sideAmount}, is one add-liquidity row ` +
              `at the auction's end, in the file of ${side.address}. Do not upload that row: in Summ, categorise that wallet's own deposits ` +
              `to Maya's vault (sent before ${getActionDate(action).toISOString().slice(0, 10)}) as the add to the pool instead. ` +
              `Their total can differ from the side (auction withdrawals, tier rules)`,
          },
        ]
      : extra < 0n
        ? [
            {
              kind: "manual",
              message:
                `Maya liquidity auction (${action.pools[0]}): the position's side, ${sideAmount}, is less than the deposits found ` +
                `(${formatAmount(amountOf(sideCoin.asset, deposited))} ${currency}); enter what happened to the difference by hand`,
            },
          ]
        : [];

  return { activities: [...deposits, position], issues };
}

// A withdrawal from a liquidity pool or savers vault: the wallet sends a request (with its gas) and gives
// up position units; the protocol pays out one or two assets. The request's own coin, usually dust, is not
// a leg: today's rows ignore it.
export function interpretWithdraw(bundle: RawBundle, protocol: Protocol): { activities: Activity[]; issues: Issue[] } {
  const action = bundle.data as Action;

  if (action.out.length === 0 || action.out.length > 2) {
    throw new Error(`liquidity: expected 1 or 2 withdrawn assets but there were ${action.out.length}`);
  }

  const position = toPositionAsset(action.pools[0]);
  const units = parseAmount(action.metadata.withdraw?.liquidityUnits ?? "", UNIT_DECIMALS);
  const request = action.in[0];
  const requestTxid = request.txID ?? "";
  // A request sent on THORChain without a coin pays the native fee
  const requestAsset =
    request.coins[0]?.asset ??
    (request.address.startsWith(protocol.nativeChain.toLowerCase()) ? protocol.nativeAsset : undefined);
  const gas = inboundGas(requestTxid, bundle, request.address, requestAsset, protocol);

  const legs: Leg[] = [
    ...action.out.map((out): Leg => {
      const coin = onlyCoin(out, "liquidity withdrawal");

      if (!coin) {
        throw new Error("liquidity withdrawal: an output with no coin");
      }

      return {
        direction: "in",
        wallet: out.address,
        asset: toAsset(coin.asset),
        amount: parseAmount(coin.amount, protocol.decimals(coin.asset)),
        role: "principal",
        basis: "observed",
        txid: out.txID ?? "",
      };
    }),
    {
      direction: "out",
      wallet: request.address,
      asset: position,
      amount: { ...units, base: units.base < 0n ? -units.base : units.base },
      role: "principal",
      basis: "observed",
      txid: requestTxid,
    },
    ...(gas ? [{ ...gas, txid: requestTxid }] : []),
  ];

  return {
    activities: [activity(bundle, protocol, position.position === "savers" ? "savers.withdraw" : "lp.withdraw", legs)],
    issues: [],
  };
}

function activity(bundle: RawBundle, protocol: Protocol, kind: Activity["kind"], legs: Leg[]): Activity {
  const action = bundle.data as Action;
  const metadata = (action.metadata as any)[
    kind.endsWith(".add") || kind.startsWith("lp.auction") ? "addLiquidity" : "withdraw"
  ];

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind,
    status: action.status as Activity["status"],
    time: getActionDate(action),
    memo: metadata?.memo || undefined,
    legs,
    prices: [],
    details: { pool: action.pools[0] },
  };
}
