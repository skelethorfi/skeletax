import type { Action } from "@xchainjs/xchain-midgard";
import type { TxStatusResponse } from "@xchainjs/xchain-thornode";
import type { ViewblockInbound, ViewblockTx } from "./viewblock/index.ts";
import type { EvmReceipt } from "./evm/EvmReceipts.ts";
import { getDistributionDate, type TcyDistributionItem } from "./tcy/TcyDistributionService.ts";
import type { CosmosTx } from "./thorchain/CosmosTxService.ts";
import type { TcyClaimData } from "./tcy/TcyClaimService.ts";
import { getActionDate } from "./thorchain/MidgardUtils.ts";
import { type ProtocolId, THORCHAIN } from "../domain/Protocol.ts";
import { isDonateAdd, mayaDistributionList, midgardActionKey, tcyList, VIEWBLOCK_LIST } from "./store/Sources.ts";
import { getPayoutDate, type MayaDistributionPayout } from "./maya/MayaDistributionService.ts";

export type BundleSource = "midgard" | "viewblock" | "tcy" | "maya-distribution";

// Everything one action needs to be mapped: the listed item plus the related txs fetched for it.
// The exporter and the fixture tool build bundles the same way (Source.ts); a golden case's
// input.json holds one.
export interface RawBundle {
  source: BundleSource;
  // Protocol of a midgard action; 'thorchain' for viewblock and tcy, 'maya' for maya-distribution
  protocol: ProtocolId;
  // The wallet it was listed for
  wallet: string;
  data: Action | ViewblockTx | TcyDistributionItem | MayaDistributionPayout;
  // The inbound THORNode tx statuses (gas the wallet paid on an L1 chain)
  thornodeTxs: TxStatusResponse[];
  // The Cosmos tx of a contract action
  cosmosTxs: CosmosTx[];
  // Viewblock's gas for the L1 inbounds (other than EVM) whose THORNode status has none (docs/specs/fees.md)
  viewblockInbounds?: ViewblockInbound[];
  // The receipts of the inbounds sent on an EVM chain: their fee (docs/specs/fees.md)
  evmReceipts?: EvmReceipt[];
  // The protocol's native fee at the action's height, in base units, when it is not constant (Maya); it replaces
  // the protocol's default gas (docs/specs/maya.md, Fees)
  nativeFee?: string;
  // RUNE's USD price at the action's time, for an asset with no market price of its own that is worth one RUNE
  // (bRUNE, docs/specs/rujira.md)
  runePriceUsd?: string;
  // THORChain sends that are this action's inbounds although no txid links them: a Maya liquidity auction's
  // deposits (docs/specs/maya.md, attachAuctionDeposits)
  inbounds?: Action[];
  // A TCY claim's claim-list entries, and the claiming address's savers positions and loans (docs/specs/thorfi-collapse.md)
  tcyClaim?: TcyClaimData;
}

export function getBundleDate(bundle: RawBundle): Date {
  switch (bundle.source) {
    case "midgard":
      return getActionDate(bundle.data as Action);
    case "viewblock":
      return new Date((bundle.data as ViewblockTx).timestamp);
    case "tcy":
      return getDistributionDate(bundle.data as TcyDistributionItem);
    case "maya-distribution":
      return getPayoutDate(bundle.data as MayaDistributionPayout);
  }
}

// The store folder name of the bundle's listing, e.g. 'midgard' or 'maya-midgard'
export function getBundleSourceName(bundle: RawBundle): string {
  return bundle.source === "midgard" && bundle.protocol !== "thorchain" ? `${bundle.protocol}-midgard` : bundle.source;
}

// The store record a bundle was listed as, e.g. 'midgard/swap.<txid>'. An action listed for two wallets
// is one record, so it has one key.
export function getBundleKey(bundle: RawBundle): string {
  switch (bundle.source) {
    case "midgard":
      return `${getBundleSourceName(bundle)}/${midgardActionKey(bundle.data as Action)}`;
    case "viewblock":
      return `viewblock/${VIEWBLOCK_LIST.keyOf(bundle.data as ViewblockTx)}`;
    case "tcy":
      return `tcy/${tcyList(bundle.wallet).keyOf(bundle.data as TcyDistributionItem)}`;
    case "maya-distribution":
      return `maya-distribution/${mayaDistributionList(bundle.wallet).keyOf(bundle.data as MayaDistributionPayout)}`;
  }
}

// A Midgard action listed for several wallets (e.g. a swap from one to another) is mapped once, from the
// first wallet's listing; it maps the same whichever wallet listed it. Sends (Midgard and Viewblock) and TCY
// distributions are mapped from the listing wallet's side, so every wallet's copy is kept.
export function dedupeBundles(bundles: RawBundle[]): { bundles: RawBundle[]; duplicates: number } {
  const seen = new Set<string>();
  const unique = bundles.filter((bundle) => {
    if (bundle.source !== "midgard" || isMidgardSend(bundle)) {
      return true;
    }

    const key = getBundleKey(bundle);
    const isNew = !seen.has(key);
    seen.add(key);
    return isNew;
  });

  return { bundles: unique, duplicates: bundles.length - unique.length };
}

// Sends before this come from Viewblock too, as Midgard's history is incomplete (docs/specs/sends.md)
export const VIEWBLOCK_SENDS_BEFORE = "2022-04-01";

// The sends that give rows (docs/specs/sends.md). A THORChain or Maya send that is part of another listed action gives
// no row of its own, as that action gives the rows:
// - its inbound: a swap or TCY unstake sent by MsgSend on THORChain, or RUNE sent to a Maya vault;
// - its outbound: RUNE a Maya vault pays out on THORChain, named by the action's outbound txid, or by a
//   'REFUND:<txid>' / 'OUT:<txid>' memo naming the action's inbound txid. Maya's Midgard can leave a refund it
//   paid this way pending with no outbound; the send is then the refund's outbound, so the refund is paid.
// Of Viewblock's txs, only sends from before VIEWBLOCK_SENDS_BEFORE that Midgard does not list are kept.
export function selectSends(bundles: RawBundle[]): {
  bundles: RawBundle[];
  dropped: { inbound: number; outbound: number; viewblock: number };
} {
  const midgard = bundles.filter((bundle) => bundle.source === "midgard");
  const actions = midgard.filter((bundle) => !isMidgardSend(bundle));
  const inboundTxids = (sends: boolean) =>
    new Set(
      midgard
        .filter((bundle) => isMidgardSend(bundle) === sends)
        .flatMap((bundle) => (bundle.data as Action).in.map((tx) => tx.txID?.toUpperCase()))
        .filter(Boolean),
    );
  const actionInbounds = inboundTxids(false);
  const actionOutbounds = new Set(
    actions.flatMap((bundle) => (bundle.data as Action).out.map((tx) => tx.txID?.toUpperCase())).filter(Boolean),
  );
  const listed = new Set([...actionInbounds, ...inboundTxids(true)]);
  const cutoff = new Date(`${VIEWBLOCK_SENDS_BEFORE}T00:00:00Z`).getTime();

  const midgardSend = (bundle: RawBundle) => isMidgardSend(bundle);
  const sendTxid = (bundle: RawBundle) => (bundle.data as Action).in[0]?.txID?.toUpperCase();
  const isInbound = (bundle: RawBundle) => midgardSend(bundle) && actionInbounds.has(sendTxid(bundle));
  const payoutFor = (bundle: RawBundle) => (midgardSend(bundle) ? outboundMemoTxid(bundle.data as Action) : undefined);
  const isOutbound = (bundle: RawBundle) =>
    midgardSend(bundle) && (actionOutbounds.has(sendTxid(bundle)) || actionInbounds.has(payoutFor(bundle) ?? ""));
  const isViewblockGap = (bundle: RawBundle) => {
    const tx = bundle.data as ViewblockTx;
    return tx.types.includes("send") && tx.timestamp < cutoff && !listed.has(tx.hash.toUpperCase());
  };

  // A pending refund's outbound found by its memo: the refund was paid
  const payouts = new Map(
    midgard
      .filter(isOutbound)
      .filter(payoutFor)
      .map((bundle) => [payoutFor(bundle)!, bundle.data as Action]),
  );
  const settled = (bundle: RawBundle): RawBundle => {
    const action = bundle.data as Action;
    const payout = payouts.get(action.in[0]?.txID?.toUpperCase() ?? "");

    if (isMidgardSend(bundle) || action.type !== "refund" || action.status === "success" || !payout) {
      return bundle;
    }

    return {
      ...bundle,
      data: {
        ...action,
        status: "success",
        out: payout.out.map((tx) => ({ ...tx, txID: payout.in[0].txID })),
      } as Action,
    };
  };

  const kept = bundles
    .filter((bundle) =>
      bundle.source === "viewblock" ? isViewblockGap(bundle) : !isInbound(bundle) && !isOutbound(bundle),
    )
    .map((bundle) => (bundle.source === "midgard" ? settled(bundle) : bundle));

  return {
    bundles: kept,
    dropped: {
      inbound: bundles.filter(isInbound).length,
      outbound: bundles.filter((bundle) => !isInbound(bundle) && isOutbound(bundle)).length,
      viewblock:
        bundles.filter((bundle) => bundle.source === "viewblock").length -
        kept.filter((bundle) => bundle.source === "viewblock").length,
    },
  };
}

// The inbound txid an outbound's memo names ('REFUND:<txid>' or 'OUT:<txid>'), upper case
export function outboundMemoTxid(send: Action): string | undefined {
  const memo = (send.metadata as any)?.send?.memo ?? "";
  return /^(?:REFUND|OUT):([0-9A-Fa-f]{64})$/i.exec(memo.trim())?.[1].toUpperCase();
}

function isMidgardSend(bundle: RawBundle): boolean {
  return bundle.source === "midgard" && (bundle.data as Action).type === "send";
}

// Maya's liquidity auction (docs/specs/maya.md): each participant's deposits, THORChain sends from the add's
// RUNE-side address with the memo '+:THOR.RUNE:<the add's CACAO-side address>…' before the add, become the
// inbounds of their donate add, and give no send rows. Run after selectSends, which drops refunded deposits.
export function attachAuctionDeposits(bundles: RawBundle[]): { bundles: RawBundle[]; attached: number } {
  const deposits = new Map<RawBundle, Action[]>();
  const attached = new Set<RawBundle>();

  for (const add of bundles.filter(
    (bundle) => bundle.source === "midgard" && bundle.protocol !== THORCHAIN.id && isDonateAdd(bundle.data as Action),
  )) {
    const action = add.data as Action;
    const mayaAddress = action.in.find((tx) => tx.txID)?.address?.toLowerCase();
    const runeAddress = action.in.find((tx) => !tx.txID && tx.coins[0]?.asset === "THOR.RUNE")?.address?.toLowerCase();

    if (!mayaAddress || !runeAddress) {
      continue;
    }

    const found = bundles.filter(
      (bundle) =>
        !attached.has(bundle) &&
        bundle.protocol === THORCHAIN.id &&
        isMidgardSend(bundle) &&
        isAuctionDeposit(bundle.data as Action, runeAddress, mayaAddress, action.date),
    );
    found.forEach((bundle) => attached.add(bundle));
    deposits.set(
      add,
      found.map((bundle) => bundle.data as Action),
    );
  }

  return {
    bundles: bundles
      .filter((bundle) => !attached.has(bundle))
      .map((bundle) => (deposits.get(bundle)?.length ? { ...bundle, inbounds: deposits.get(bundle) } : bundle)),
    attached: attached.size,
  };
}

function isAuctionDeposit(send: Action, runeAddress: string, mayaAddress: string, addDate: string): boolean {
  const memo = ((send.metadata as any)?.send?.memo ?? "").toLowerCase();
  return (
    send.status === "success" &&
    send.in[0]?.address?.toLowerCase() === runeAddress &&
    memo.startsWith(`+:thor.rune:${mayaAddress}`) &&
    BigInt(send.date) < BigInt(addDate)
  );
}
