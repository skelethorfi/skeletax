import { assetFromStringEx } from "@xchainjs/xchain-util";
import type { Activity, Price } from "../domain/Activity.ts";
import type { Asset } from "../domain/Asset.ts";
import { getProtocol, MAYA, THORCHAIN } from "../domain/Protocol.ts";
import { interpret } from "../interpret/registry.ts";
import { getBundleDate, type RawBundle } from "./RawBundle.ts";
import { bucketStart, type MidgardService } from "./thorchain/MidgardService.ts";

// Reference prices (docs/specs/prices.md): each asset's USD price at the 5-minute Midgard bucket of its action

const RUNE = THORCHAIN.nativeAsset;
const CACAO = MAYA.nativeAsset;

// What an asset is priced as: RUNE, CACAO, or a pool (synths, trade and secured assets as their L1 asset's pool;
// a Rujira denom x/<name> as THOR.<NAME>). None for a position, whose price is derived from its assets.
export function priceKey(asset: Asset): string | undefined {
  if (asset.kind === "position") {
    return undefined;
  }

  const notation = asset.notation.toUpperCase();

  if (notation.startsWith("X/")) {
    return `THOR.${notation.slice(2)}`;
  }

  if (asset.kind === "synth" || asset.kind === "trade" || asset.kind === "secured") {
    const { chain, symbol } = assetFromStringEx(asset.notation);
    return `${chain}.${symbol}`.toUpperCase();
  }

  return notation;
}

// Where a price key's price comes from, as an activity's price source
function sourceOf(key: string, protocolSource: string): string {
  return key === RUNE
    ? "midgard:history.rune"
    : key === CACAO
      ? "maya-midgard:history.cacao"
      : `${protocolSource}:history.depths`;
}

// The prices a bundle carries (usdPrices), as each activity's prices for the legs they price. Only an activity at
// the bundle's own bucket gets them (a Maya auction's deposits are at other times).
export function withBundlePrices(activities: Activity[], bundle: RawBundle): Activity[] {
  const usdPrices = bundle.usdPrices;

  if (!usdPrices) {
    return activities;
  }

  const bucket = bucketStart(getBundleDate(bundle));
  const protocolSource = bundle.protocol === THORCHAIN.id ? "midgard" : `${bundle.protocol}-midgard`;

  return activities.map((activity) => {
    if (bucketStart(activity.time) !== bucket) {
      return activity;
    }

    const prices: Price[] = [];

    for (const leg of activity.legs) {
      const key = priceKey(leg.asset);
      const usd = key ? usdPrices[key] : undefined;

      if (usd && !prices.some((price) => price.asset.notation === leg.asset.notation)) {
        prices.push({ asset: leg.asset, usd, source: sourceOf(key!, protocolSource) });
      }
    }

    return prices.length ? { ...activity, prices: [...activity.prices, ...prices] } : activity;
  });
}

// Fetches the prices of each bundle's legs into the bundle (usdPrices). midgards: each protocol's Midgard; RUNE is
// always THORChain's, CACAO always Maya's.
export class PriceSource {
  private midgards: Map<string, MidgardService>;
  constructor(midgards: Map<string, MidgardService>) {
    this.midgards = midgards;
  }

  async add(bundle: RawBundle): Promise<RawBundle> {
    const time = getBundleDate(bundle);
    const bucket = bucketStart(time);
    const keys = new Set<string>();

    for (const activity of interpret(bundle, getProtocol(bundle.protocol)).activities) {
      if (bucketStart(activity.time) === bucket) {
        activity.legs.map((leg) => priceKey(leg.asset)).forEach((key) => key && keys.add(key));
      }
    }

    const usdPrices: Record<string, string> = {};

    for (const key of [...keys].sort()) {
      const usd = await this.price(key, bundle.protocol, time);

      if (usd) {
        usdPrices[key] = usd;
      }
    }

    return Object.keys(usdPrices).length ? { ...bundle, usdPrices } : bundle;
  }

  // A USD price, or none: '0' (no pool yet), '' (unknown pool) or no Midgard for the protocol
  private async price(key: string, protocol: string, time: Date): Promise<string | undefined> {
    const midgard = this.midgards.get(key === RUNE ? THORCHAIN.id : key === CACAO ? MAYA.id : protocol);
    let usd: string | undefined;

    if (!midgard) {
      usd = undefined;
    } else if (key === RUNE) {
      usd = (await midgard.getRunePrice(time)).runePriceUSD;
    } else if (key === CACAO) {
      usd = (await midgard.getCacaoPrice(time)).cacaoPriceUSD;
    } else {
      usd = (await midgard.getPoolPrice(key, time)).assetPriceUSD;
    }

    return usd && Number(usd) > 0 ? usd : undefined;
  }
}
