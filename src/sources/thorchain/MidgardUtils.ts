import type { Action } from "@xchainjs/xchain-midgard";
import { assetFromStringEx, AssetType } from "@xchainjs/xchain-util";
import { type Protocol, THORCHAIN } from "../../domain/Protocol.ts";

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
