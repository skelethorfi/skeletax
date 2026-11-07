import type { Activity, Leg } from "../../domain/Activity.ts";
import { type Amount, formatAmount, parseDecimal } from "../../domain/Amount.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import { parseMidgardAsset } from "../../sources/thorchain/MidgardUtils.ts";
import { toPositionAsset } from "../../domain/Asset.ts";
import { getLpTokenName } from "./ThorchainUtils.ts";
import { formatBlockchain, type Protocol } from "../../domain/Protocol.ts";
import { leg, legTrace, paidOutNote, plusSeconds } from "./common.ts";
import type { MayaLiquidityAuction } from "../../config/ITaxConfig.ts";

// Summ needs a wallet for every row; an old deposit can have none
const MISSING_ADDRESS = "MISSING-DEPOSIT-ADDRESS";

// Summ does not price the position token, so a spam row carries the value of what went in or came out, to
// copy onto the token row by hand (docs/specs/liquidity.md): the first asset's amount times the number of assets,
// exact, in the same format as every other amount.
function priceHelper(first: SummRow, amount: Amount, count: number): { currency: string; amount: string } {
  return { currency: first.baseCurrency, amount: times(amount, count) };
}

function times({ base, decimals }: Amount, count: number): string {
  return formatAmount({ base: base * BigInt(count), decimals });
}

// The fee columns of a principal leg: the gas leg that follows it, blank when none (docs/specs/fees.md)
function feeFor(activity: Activity, item: Leg, protocol: Protocol): Pick<SummRow, "feeCurrency" | "feeAmount"> {
  const next = activity.legs[activity.legs.indexOf(item) + 1];

  if (next?.role !== "gas") {
    return { feeCurrency: "", feeAmount: "" };
  }

  return {
    feeCurrency: parseMidgardAsset(next.asset.notation, protocol).currency,
    feeAmount: formatAmount(next.amount),
  };
}

// A deposit that is another tx than the action's first (the L1 side of a symmetric add) names its own too: the tx a
// wallet import of that chain lists (docs/specs/fees.md, Txids in descriptions)
function sentNote(deposit: Leg, txId: string): string {
  return deposit.txid && deposit.txid !== txId ? `; sent in ${deposit.txid}` : "";
}

function describe(activity: Activity, assetCount: number): string {
  return activity.kind.startsWith("savers") ? "savers" : assetCount === 2 ? "symmetric" : "asymmetric";
}

// Each deposit as an add-liquidity row with its own fee, the position as a receive-LP-token row 10 s later,
// and the price-helper row 20 s later
export function addLiquidityRows(activity: Activity, protocol: Protocol): SummRow[] {
  const deposits = activity.legs.filter((item) => item.role === "principal" && item.direction === "out");
  const position = activity.legs.find((item) => item.role === "principal" && item.direction === "in")!;
  const lpToken = getLpTokenName(position.asset.notation, protocol);
  const symmetry = describe(activity, deposits.length);
  const total = deposits.length + 2;
  const txId = deposits[0].txid ?? "";
  const receiver = position.wallet || MISSING_ADDRESS;

  const rows: SummRow[] = deposits.map((deposit, i) => {
    const { blockchain, currency } = parseMidgardAsset(deposit.asset.notation, protocol);
    const from = deposit.wallet || MISSING_ADDRESS;

    return {
      wallet: from,
      timestamp: activity.time,
      type: SummRowType.AddLiquidity,
      baseCurrency: currency,
      baseAmount: formatAmount(deposit.amount),
      ...feeFor(activity, deposit, protocol),
      from,
      to: protocol.counterparty,
      blockchain: formatBlockchain(blockchain),
      trace: legTrace(deposit),
      description: `${i + 1}/${total} - Add liquidity ${currency} to ${lpToken} (${symmetry}); ${txId}${sentNote(deposit, txId)}`,
    };
  });
  const quote = priceHelper(rows[0], deposits[0].amount, deposits.length);

  rows.push(
    {
      wallet: receiver,
      timestamp: plusSeconds(activity.time, 10),
      type: SummRowType.ReceiveLpToken,
      baseCurrency: lpToken,
      baseAmount: formatAmount(position.amount),
      from: protocol.counterparty,
      to: receiver,
      blockchain: protocol.blockchain,
      trace: legTrace(position),
      description: `${total - 1}/${total} - Receive LP token from ${lpToken} (${symmetry}); ${txId}`,
    },
    {
      wallet: receiver,
      timestamp: plusSeconds(activity.time, 20),
      type: SummRowType.Spam,
      baseCurrency: quote.currency,
      baseAmount: quote.amount,
      from: protocol.counterparty,
      to: receiver,
      trace: { role: "price-helper" },
      description: `${total}/${total} - Dummy transaction to get market price to then manually apply to the receive LP token transaction ${lpToken} (${symmetry}); ${txId}`,
    },
  );

  return rows.reverse();
}

// The position as a return-LP-token row carrying the request's fee, the price-helper row 10 s later, and each
// asset paid out as a remove-liquidity row 20 s later (the native asset first)
export function withdrawRows(activity: Activity, protocol: Protocol): SummRow[] {
  const paidOut = activity.legs.filter((item) => item.role === "principal" && item.direction === "in");
  const position = activity.legs.find((item) => item.role === "principal" && item.direction === "out")!;
  const nativeFirst = paidOut[0].wallet.startsWith(protocol.nativeChain.toLowerCase());
  const ordered = nativeFirst ? paidOut : [...paidOut].reverse();
  const lpToken = getLpTokenName(position.asset.notation, protocol);
  const symmetry = describe(activity, paidOut.length);
  const total = paidOut.length + 2;
  const txId = position.txid ?? "";

  const removals: SummRow[] = ordered.map((out, i) => {
    const { blockchain, currency } = parseMidgardAsset(out.asset.notation, protocol);

    return {
      wallet: out.wallet,
      timestamp: plusSeconds(activity.time, 20),
      type: SummRowType.RemoveLiquidity,
      baseCurrency: currency,
      baseAmount: formatAmount(out.amount),
      // What came out is already net of the protocol's fees (fees.md)
      feeCurrency: "",
      feeAmount: "",
      from: protocol.counterparty,
      to: out.wallet,
      blockchain: formatBlockchain(blockchain),
      trace: legTrace(out),
      description: `${total - i}/${total} - Remove liquidity ${currency} from ${lpToken} (${symmetry}); ${txId}${paidOutNote(out)}`,
    };
  });
  const quote = priceHelper(removals[0], ordered[0].amount, paidOut.length);

  // Listed request first, then reversed: the rows come out removals first, as they always have
  return [
    {
      wallet: position.wallet,
      timestamp: activity.time,
      type: SummRowType.ReturnLpToken,
      baseCurrency: lpToken,
      baseAmount: formatAmount(position.amount),
      ...feeFor(activity, position, protocol),
      from: position.wallet,
      to: protocol.counterparty,
      blockchain: protocol.blockchain,
      trace: legTrace(position),
      description: `1/${total} - Return LP token to ${lpToken} (${symmetry}); ${txId}`,
    },
    {
      wallet: position.wallet,
      timestamp: plusSeconds(activity.time, 10),
      type: SummRowType.Spam,
      baseCurrency: quote.currency,
      baseAmount: quote.amount,
      from: position.wallet,
      to: protocol.counterparty,
      trace: { role: "price-helper" },
      description: `2/${total} - Dummy transaction to get market price to then manually apply to the return LP token transaction ${lpToken} (${symmetry}); ${txId}`,
    },
    ...removals,
  ].reverse();
}

// Maya's liquidity auction (docs/specs/maya.md). A deposit: an add-liquidity row with its fee, at its own date.
export function auctionDepositRows(activity: Activity, protocol: Protocol): SummRow[] {
  const deposit = leg(activity, "principal", "out");
  const { blockchain, currency } = parseMidgardAsset(deposit.asset.notation, protocol);
  const lpToken = getLpTokenName(toPositionAsset(activity.details.pool).notation, protocol);

  return [
    {
      wallet: deposit.wallet,
      timestamp: activity.time,
      type: SummRowType.AddLiquidity,
      baseCurrency: currency,
      baseAmount: formatAmount(deposit.amount),
      ...feeFor(activity, deposit, protocol),
      from: deposit.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(blockchain),
      trace: legTrace(deposit),
      description: `Liquidity auction deposit: add ${formatAmount(deposit.amount)} ${currency} to ${lpToken}; ${deposit.txid ?? ""}`,
    },
  ];
}

// The auction's end. What the auction supplied (a reward leg): with 'income', an income row, then an add-liquidity
// row 1 s later; with 'pool-units', nothing, so the position's cost is what was deposited. A side added at the end
// (deposits not found): an add-liquidity row. Then the position as a receive-LP-token row 10 s later, and the
// price-helper row 20 s later: the deposited asset's side twice, as the pool is symmetric.
export function auctionPositionRows(
  activity: Activity,
  protocol: Protocol,
  treatment?: MayaLiquidityAuction,
): SummRow[] {
  if (!treatment) {
    throw new Error(
      `Config: this run has a Maya liquidity auction position (${activity.time.toISOString().slice(0, 10)}). ` +
        'Set mayaLiquidityAuction = "income" (what the auction supplied is income at its end) or "pool-units" ' +
        "(only the pool units are received, at the cost of what was deposited; any gain shows at withdrawal). " +
        "See docs/specs/maya.md",
    );
  }

  const position = activity.legs.find((item) => item.role === "principal" && item.direction === "in")!;
  const lpToken = getLpTokenName(position.asset.notation, protocol);
  const txId = position.txid ?? "";
  const isSupplied = (item: Leg) =>
    activity.legs.some((other) => other.role === "reward" && other.asset.notation === item.asset.notation);
  const adds = activity.legs.filter(
    (item) => item.role === "principal" && item.direction === "out" && (treatment === "income" || !isSupplied(item)),
  );
  const total = adds.reduce((count, item) => count + (isSupplied(item) ? 2 : 1), 0) + 2;
  let n = 0;
  const rows: SummRow[] = adds.flatMap((item) => {
    const { blockchain, currency } = parseMidgardAsset(item.asset.notation, protocol);
    const amount = formatAmount(item.amount);
    const reward = activity.legs.find(
      (other) => other.role === "reward" && other.asset.notation === item.asset.notation,
    );
    const add: SummRow = {
      wallet: item.wallet,
      timestamp: plusSeconds(activity.time, 1),
      type: SummRowType.AddLiquidity,
      baseCurrency: currency,
      baseAmount: amount,
      from: item.wallet,
      to: protocol.counterparty,
      blockchain: formatBlockchain(blockchain),
      trace: legTrace(item),
      description: "",
    };

    if (!reward) {
      return [
        {
          ...add,
          description: `${++n}/${total} - Liquidity auction: add ${amount} ${currency} deposited before; ${txId}`,
        },
      ];
    }

    return [
      {
        wallet: reward.wallet,
        timestamp: activity.time,
        type: SummRowType.Income,
        baseCurrency: currency,
        baseAmount: amount,
        from: protocol.counterparty,
        to: reward.wallet,
        blockchain: formatBlockchain(blockchain),
        trace: legTrace(reward),
        description: `${++n}/${total} - Liquidity auction: ${amount} ${currency} supplied by the auction; ${txId}`,
      },
      { ...add, description: `${++n}/${total} - Liquidity auction: add ${amount} ${currency} to ${lpToken}; ${txId}` },
    ];
  });
  const side = parseMidgardAsset(activity.details.sideAsset, protocol).currency;

  rows.push(
    {
      wallet: position.wallet,
      timestamp: plusSeconds(activity.time, 10),
      type: SummRowType.ReceiveLpToken,
      baseCurrency: lpToken,
      baseAmount: formatAmount(position.amount),
      from: protocol.counterparty,
      to: position.wallet,
      blockchain: protocol.blockchain,
      trace: legTrace(position),
      description: `${total - 1}/${total} - Liquidity auction: receive LP token from ${lpToken}; ${txId}`,
    },
    {
      wallet: position.wallet,
      timestamp: plusSeconds(activity.time, 20),
      type: SummRowType.Spam,
      baseCurrency: side,
      baseAmount: times(parseDecimal(activity.details.side), 2),
      from: protocol.counterparty,
      to: position.wallet,
      trace: { role: "price-helper" },
      description: `${total}/${total} - Dummy transaction to get market price to then manually apply to the receive LP token transaction ${lpToken} (liquidity auction: the ${side} side, ${activity.details.side} ${side}, twice); ${txId}`,
    },
  );

  return rows.reverse();
}
