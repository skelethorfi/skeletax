import { API_URLS } from "../config/apiUrls.ts";

// What differs between THORChain and its fork Maya Protocol when mapping Midgard actions.
// See docs/specs/maya.md.
export type ProtocolId = "thorchain" | "maya";

export interface Protocol {
  id: ProtocolId;
  // Counterparty used in the CSV from/to columns
  counterparty: string;
  // Midgard chain id of the native chain, and the blockchain value written to the CSV for it
  nativeChain: string;
  blockchain: string;
  nativeAsset: string;
  nativeAddressPrefix: string;
  lpTokenPrefix: string;
  // Savers positions are not pool LP units, so they get their own token name (docs/specs/savers.md)
  saversTokenPrefix: string;
  // Names synths, which live on this chain but give exposure to another chain's asset:
  // <prefix>Synth.BTC.BTC (docs/specs/assets.md)
  assetNamePrefix: string;
  // Also prefix secured and trade assets (<prefix>Secured.BTC.BTC, <prefix>Trade.BTC.BTC) instead of
  // giving them the L1 asset's name. Set from the config's [assets] table (docs/specs/assets.md).
  prefixSecuredAssets?: boolean;
  prefixTradeAssets?: boolean;
  midgardUrl: string;
  nodeUrl?: string;
  // Fallback inbound gas (base units of the native asset) when THORNode data is missing. THORChain's is also the
  // exact fee a v1 deposit that did nothing paid (isNoopDeposit, docs/specs/sends.md)
  defaultGas?: string;
  // From this block a tx whose message fails still pays the native fee, taken before the message runs; before it,
  // and where unset, a failed tx paid nothing (docs/specs/sends.md)
  failedTxFeeFromHeight?: number;
  // Decimals of an asset's base amounts as reported by this protocol's Midgard
  decimals(asset: string): number;
}

export const THORCHAIN: Protocol = {
  id: "thorchain",
  counterparty: "thorchain",
  nativeChain: "THOR",
  blockchain: "THORChain",
  nativeAsset: "THOR.RUNE",
  nativeAddressPrefix: "thor1",
  lpTokenPrefix: "ThorLP",
  saversTokenPrefix: "ThorSavers",
  assetNamePrefix: "Thor",
  midgardUrl: API_URLS.midgard,
  defaultGas: "2000000",
  // Version 1.115.0 moved the native fee into the ante handler (thornode 335fda2ce); first block on 1.115.0
  failedTxFeeFromHeight: 11637012,
  decimals: () => 8,
};

// Checked 2026-10-01 against live pool depths: CACAO is 1e10, the MAYA token 1e4, other assets 1e8
const MAYA_DECIMALS: { [asset: string]: number } = {
  "MAYA.CACAO": 10,
  "MAYA.MAYA": 4,
  MAYA: 4,
};

export const MAYA: Protocol = {
  id: "maya",
  counterparty: "mayaprotocol",
  nativeChain: "MAYA",
  // Summ's name for Maya Protocol. Summ has no Maya Protocol chain to attach a row to (its blockchain
  // list has none), so no value gives these rows a chain today; this one matches Summ's catalogue.
  blockchain: "Mayachain",
  nativeAsset: "MAYA.CACAO",
  nativeAddressPrefix: "maya1",
  lpTokenPrefix: "MayaLP",
  saversTokenPrefix: "MayaSavers",
  assetNamePrefix: "Maya",
  midgardUrl: process.env.MAYA_MIDGARD_API_URL || "https://midgard.mayachain.info",
  // Mayanode: the native fee setting at a past height (MayanodeService)
  nodeUrl: process.env.MAYANODE_API_URL || "https://mayanode.mayachain.info",
  // NativeTransactionFee from Mayanode constants and mimir (2026-10-01): 0.2 CACAO
  defaultGas: "2000000000",
  // No failedTxFeeFromHeight: Mayanode charges the native fee in the send handler, so a failed send paid nothing;
  // its ante handler (1.133.0, mayanode f86ed80df) only checks the balance
  decimals: (asset: string) => MAYA_DECIMALS[asset.toUpperCase()] ?? 8,
};

export const PROTOCOLS: { [id in ProtocolId]: Protocol } = { thorchain: THORCHAIN, maya: MAYA };

export function getProtocol(id: string | undefined): Protocol {
  const protocol = PROTOCOLS[(id ?? "thorchain") as ProtocolId];

  if (!protocol) {
    throw new Error(`Unknown protocol: ${id}`);
  }

  return protocol;
}

// The blockchain value written to the CSV for a Midgard chain id
export function formatBlockchain(chain: string): string {
  const protocol = Object.values(PROTOCOLS).find((p) => p.nativeChain === chain);
  return protocol ? protocol.blockchain : chain;
}

// Options from the config's [assets] table. All optional; the default is the L1 name for both.
export interface AssetNamesConfig {
  prefixSecuredAssets?: boolean;
  prefixTradeAssets?: boolean;
}

export function withAssetNames(protocol: Protocol, assets: AssetNamesConfig = {}): Protocol {
  return {
    ...protocol,
    prefixSecuredAssets: assets.prefixSecuredAssets ?? false,
    prefixTradeAssets: assets.prefixTradeAssets ?? false,
  };
}

// Whether a tx whose message failed still paid the native fee
export function failedTxPaidFee(protocol: Protocol, height: number): boolean {
  return protocol.failedTxFeeFromHeight !== undefined && height >= protocol.failedTxFeeFromHeight;
}
