import type { Action } from "@xchainjs/xchain-midgard";
import { assetFromStringEx, AssetType } from "@xchainjs/xchain-util";
import { MAYA, type Protocol, THORCHAIN } from "../../domain/Protocol.ts";

export function parseMidgardDate(nanoTimestamp: string): Date {
  return new Date(parseInt(nanoTimestamp) / 1000000);
}

export function getActionDate(action: Action): Date {
  return parseMidgardDate(action.date);
}

// A Rujira liquid bond of bRUNE needs RUNE's price: bRUNE is worth one RUNE but has no market price
// (docs/specs/rujira.md)
export function needsRunePrice(action: Action): boolean {
  const contract = action.metadata?.contract;
  return contract?.contractType === "wasm-rujira-staking/liquid.bond" && /^\d+x\/brune$/.test(contract.funds ?? "");
}

// The destination address at a memo's field. A memo can give a refund address after the destination,
// as DESTADDR/REFUNDADDR (https://dev.thorchain.org/concepts/memos.html#swap); outputs are paid to the
// destination alone. Undefined when the field is missing or empty.
export function memoDestination(memo: string, field: number): string | undefined {
  return memo.split(":")[field]?.split("/")[0] || undefined;
}

// Whether a memo's destination is a THORName (or Maya's MAYAName) rather than an address: 1 to 30 letters, digits, "-",
// "_" or "+" (https://dev.thorchain.org/concepts/thornames.html). The protocol pays the address the name resolves to, so
// no output carries the name. Addresses are longer, bar some XRP ones; callers ask only when no output matches the field.
export function isMemoName(destination: string): boolean {
  return /^[a-z0-9+_-]{1,30}$/i.test(destination);
}

// The refund address a memo's field gives after its destination (DESTADDR/REFUNDADDR), when it gives one
export function memoRefundAddress(memo: string, field: number): string | undefined {
  return memo.split(":")[field]?.split("/")[1] || undefined;
}

// The one coin of a Midgard tx whose coin is read as a leg, or undefined when it has none. A tx can list several
// coins (a Cosmos MsgSend can carry several denoms); the interpreters map one, so a second would be dropped
// without notice. It throws instead, and the action is reported as failed (docs/specs/activity.md).
export function onlyCoin<C>(tx: { coins: C[] } | undefined, what: string): C | undefined {
  if (tx && tx.coins.length > 1) {
    throw new Error(`${what}: expected 1 coin but there were ${tx.coins.length}`);
  }

  return tx?.coins[0];
}

// The one coin of a tx that must carry exactly one. It throws, failing the action, for several coins (as onlyCoin
// does) and also for no coin or no tx, where onlyCoin gives undefined.
export function oneCoin<C>(tx: { coins: C[] } | undefined, what: string): C {
  if (!tx) {
    throw new Error(`${what}: expected 1 coin but there was no tx`);
  }

  const coin = onlyCoin(tx, what);

  if (!coin) {
    throw new Error(`${what}: expected 1 coin but there were 0`);
  }

  return coin;
}

export function toMidgardNanoTimestamp(date: Date): string {
  return (date.getTime() * 1000000).toString();
}

function tickerRename(ticker: string) {
  const renames: { [key: string]: string } = {
    LUNA: "LUNC",
    UST: "USTC",
  };

  return renames[ticker] ?? ticker;
}

// Assets that live on THORChain (or Maya) but represent another chain's asset, by Midgard notation.
// A synth is pool-backed exposure, a different holding: it always gets its own name. Trade and secured
// assets are the same asset held 1:1 on THORChain, so by default they keep the L1 asset's name; the
// config can prefix them instead (docs/specs/assets.md).
const ASSET_KINDS: { [type: number]: { separator: string; name: string; prefixed: (protocol: Protocol) => boolean } } =
  {
    [AssetType.SYNTH]: { separator: "/", name: "Synth", prefixed: () => true },
    [AssetType.TRADE]: { separator: "~", name: "Trade", prefixed: (protocol) => protocol.prefixTradeAssets ?? false },
    [AssetType.SECURED]: {
      separator: "-",
      name: "Secured",
      prefixed: (protocol) => protocol.prefixSecuredAssets ?? false,
    },
  };

// Cosmos denoms on THORChain such as x/ruji parse as a synth of chain X, but are native tokens
const NATIVE_DENOM_CHAIN = "X";

// currency is what the CSV exports; displayCurrency is for descriptions, in Midgard's notation.
// See docs/specs/assets.md.
export function parseMidgardAsset(
  assetStr: string,
  protocol: Protocol = THORCHAIN,
): {
  blockchain: string;
  currency: string;
  displayCurrency: string;
} {
  let asset;

  try {
    asset = assetFromStringEx(assetStr);
  } catch (e) {
    throw new Error(`Failed to parse asset string: "${assetStr}"`);
  }

  // Update ticker if it has been renamed
  const ticker = tickerRename(asset.ticker);

  if (asset.type === AssetType.SYNTH && asset.chain.toUpperCase() === NATIVE_DENOM_CHAIN) {
    return { blockchain: protocol.nativeChain, currency: ticker, displayCurrency: ticker };
  }

  const kind = ASSET_KINDS[asset.type];

  if (!kind) {
    return { blockchain: asset.chain, currency: ticker, displayCurrency: ticker };
  }

  // e.g. synth BTC/BTC lives on THORChain: ThorSynth.BTC.BTC, so Summ never mixes it with L1 BTC, and
  // without a slash, which breaks Summ's ledger view
  return {
    blockchain: protocol.nativeChain,
    currency: kind.prefixed(protocol) ? `${protocol.assetNamePrefix}${kind.name}.${asset.chain}.${ticker}` : ticker,
    displayCurrency: `${asset.chain}${kind.separator}${ticker}`,
  };
}

export function parseMidgardPool(pool: string): string {
  const { blockchain, currency } = parseMidgardAsset(pool);
  return `${blockchain}.${currency}`;
}

// Below these heights the protocol took a native deposit's affiliate cut before queueing its swap, and Midgard lists
// the input after the cut with no output for it (docs/specs/fees.md, Affiliate cut taken from a deposit):
// - the protocol's own asset (RUNE, CACAO): until the cut became part of the swap's outbound (THORNode v3.0.0,
//   Mayanode v1.118.0);
// - another native asset (a synth): until the cut became a swap of its own with the same txid, which Midgard adds back
//   to the input (THORNode v2.137.0, Mayanode v1.112.0).
// A trade asset never: before THORNode v2.137.0 the trade account kept the cut, and from it the cut is a swap.
export const SWAP_CUT_BEFORE_HEIGHT: Record<string, { nativeAsset: number; otherAsset: number }> = {
  [THORCHAIN.id]: { nativeAsset: 18972070, otherAsset: 18393714 },
  [MAYA.id]: { nativeAsset: 10253469, otherAsset: 8788026 },
};

// The affiliate fees in basis points a swap or add memo gives (=:ASSET:DEST:LIMIT:AFFILIATE:FEE, +:POOL:PAIRED:
// AFFILIATE:FEE; several affiliates as 'a/b' and '10/20'), or else Midgard's affiliateFee, which holds one fee only
export function affiliateBps(action: Action): bigint[] {
  const meta = action.metadata?.swap ?? action.metadata?.addLiquidity ?? action.metadata?.refund;
  const memo = meta?.memo ?? "";
  const fields = memo.split(":");
  const field = action.type === "addLiquidity" ? 4 : 5;
  const bps = memo ? (fields[field - 1] ? (fields[field] ?? "") : "") : (meta?.affiliateFee ?? "");
  return bps
    .split("/")
    .filter((b) => /^\d+$/.test(b))
    .map(BigInt)
    .filter((b) => b > 0n);
}

// A swap (or the refund of one) of a native deposit whose affiliate cut the protocol took before queueing it
export function isSwapAfterCut(action: Action, protocol: Protocol): boolean {
  const asset = action.in[0]?.coins?.[0]?.asset ?? "";
  const cutoff = SWAP_CUT_BEFORE_HEIGHT[protocol.id];
  return (
    (action.type === "swap" || action.type === "refund") &&
    !!cutoff &&
    !asset.includes("~") &&
    Number(action.height) < (asset === protocol.nativeAsset ? cutoff.nativeAsset : cutoff.otherAsset) &&
    action.in.length === 1 &&
    !!action.in[0].address?.toLowerCase().startsWith(protocol.nativeAddressPrefix) &&
    affiliateBps(action).length > 0
  );
}

// An add with an affiliate fee: THORNode and Mayanode add the fee's share of each deposit as the affiliate's own
// position, and Midgard lists the wallet's deposits after it
export function isAddAfterCut(action: Action): boolean {
  return action.type === "addLiquidity" && affiliateBps(action).length > 0;
}
