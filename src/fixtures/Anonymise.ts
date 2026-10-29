// Fallback when no public tx of the same shape exists: rewrite a private tx so it can't be
// traced back on-chain (docs/specs/fixtures.md). Addresses, txids and affiliate names are replaced
// with placeholders, every date and block height is set to one fixed value (the hand-made cases'
// 2020-12-31 13:00 UTC, height 10000000), every USD price to 1, and every amount is replaced by its rank
// among the case's amounts: the smallest becomes 10, the next 20, and so on. That keeps what the mappers
// depend on (equal amounts stay equal, a larger amount stays larger) and nothing else: no size, no
// ratio such as a swap's exchange rate. The output must still be reviewed by hand before it is committed.

// Rank 1 is 10 (in base units at 8 decimals), rank 2 is 20, …
const RANK_STEP = 1_000_000_000n;

// Every date and height becomes this moment, as in the hand-made cases. No mapper reads either except to
// write it out, and a fixed value carries nothing about the original transaction.
export const FIXED_TIME = new Date("2020-12-31T13:00:00Z");
export const FIXED_HEIGHT = "10000000";
// A USD price is only copied into the reference price column, or multiplied with amounts for a position's value
// (docs/specs/prices.md): a fixed price keeps both working and says nothing about the time
export const FIXED_PRICE_USD = "1";

// Wallet addresses: EVM (not a token contract inside an asset name such as ETH.USDC-0X…), bech32 (THORChain,
// Maya, Cosmos chains, BTC/LTC segwit, BNB), Bitcoin Cash, base58 (BTC/LTC/DOGE legacy, DASH, ZEC, TRON, XRP,
// Solana) and bech32 public keys
const ADDRESS_PATTERN = new RegExp(
  [
    "(?<![-.])\\b0x[0-9a-fA-F]{40}\\b",
    "\\b(?:thor|sthor|maya|smaya|cosmos|kujira|terra|osmo|bc|ltc|bnb|tb)1[02-9ac-hj-np-z]{20,90}\\b",
    "\\b(?:thor|maya)pub1[02-9ac-hj-np-z]{20,}\\b",
    "\\b(?:bitcoincash:)?q[02-9ac-hj-np-z]{40,}\\b",
    "\\b(?:t1|[13DLMXTr])[1-9A-HJ-NP-Za-km-z]{24,34}\\b",
    "\\b[1-9A-HJ-NP-Za-km-z]{32,44}\\b",
  ].join("|"),
  "gi",
);
const TXID_PATTERN = /\b(?:0x)?[0-9A-Fa-f]{64}\b/g;

// Every number is ranked as an amount unless its key is here: values that describe the protocol, not the
// transaction. (Dates, heights and prices are fixed separately.) Ranking by default means an amount field
// nobody listed can't slip through.
const KEEP_KEYS = new Set(["decimals", "contract_version", "code"]);
const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE_KEYS = new Set(["date"]);
const ISO_TIME_KEYS = new Set(["timestamp"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEIGHT_KEY = /height$/i;
// An EVM receipt's quantities are hex (docs/specs/fees.md): its block is fixed, and its fee (gas used × price + L1
// fee, in wei) is ranked as one amount, at 8 decimals like the others
const HEX_BLOCK_KEYS = new Set(["blockNumber"]);
const HEX_QUANTITY = /^0x[0-9a-f]+$/i;
const WEI_PER_BASE_UNIT = 10n ** 10n;
const PRICE_KEY = /priceusd$/i;
// Coins such as '100x/ruji,20rune' (contract funds, Cosmos transfer amounts and fees)
const COINS_PATTERN = /^\d+[a-z][a-z0-9/._-]*(,\d+[a-z][a-z0-9/._-]*)*$/i;
// A signature, public key or other base64 blob: unique to one tx or wallet. Base64 without + / = looks
// like any long word, so it counts only under these keys.
const BASE64 = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const BLOB_KEYS = new Set(["signature", "signatures", "key", "pub_key", "public_key"]);
// An asset in a memo starts with its chain: BTC.BTC, BTC/BTC, BTC~BTC, BTC-BTC, ETH.USDC-0X…, x/ruji. Anything
// else with a separator (e.g. affiliates 'abc/xyz') is a name.
const MEMO_ASSET =
  /^(?:THOR|MAYA|BTC|ETH|BSC|BNB|AVAX|BASE|ARB|GAIA|DOGE|LTC|BCH|DASH|KUJI|XRD|TRON|SOL|XRP|ZEC|TERRA|X)[./~-][A-Za-z0-9._~/-]+$/i;
// CosmWasm contracts have 32-byte addresses (wallets have 20); they are public, and mappers look them up
const CONTRACT_ADDRESS_PATTERN = /^(thor|maya)1[02-9ac-hj-np-z]{58}$/i;

function isReceipt(value: any): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.gasUsed === "string" &&
    HEX_QUANTITY.test(value.gasUsed) &&
    typeof value.effectiveGasPrice === "string" &&
    HEX_QUANTITY.test(value.effectiveGasPrice)
  );
}

export class Anonymiser {
  private addresses = new Map<string, string>();
  private txids = new Map<string, string>();
  private names = new Map<string, string>();
  private blobs = new Map<string, string>();

  // Amounts seen in the first pass, then each one's rank
  private collecting = false;
  private integers = new Set<bigint>();
  private decimals = new Set<string>();
  private ranks = new Map<string, string>();

  // Two passes: the first collects every amount, the second replaces each by its rank
  anonymise<T>(data: T): T {
    this.collecting = true;
    this.walk(data, undefined);
    this.collecting = false;

    [...this.integers]
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
      .forEach((value, i) => this.ranks.set(value.toString(), (BigInt(i + 1) * RANK_STEP).toString()));
    // Decimals (e.g. Rujira prices) are ranked among themselves, keeping a fraction
    [...this.decimals]
      .sort((x, y) => Number(x) - Number(y))
      .forEach((value, i) => this.ranks.set(`d:${value}`, `${(i + 1) * 10}.5`));

    return this.walk(data, undefined) as T;
  }

  private walk(value: any, key: string | undefined): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, key));
    }

    // A Cosmos event attribute: its own key says what the value is
    if (
      value !== null &&
      typeof value === "object" &&
      typeof value.key === "string" &&
      typeof value.value === "string" &&
      Object.keys(value).length === 2
    ) {
      return { key: value.key, value: this.anonymiseString(value.value, value.key) };
    }

    if (isReceipt(value)) {
      return this.anonymiseReceipt(value);
    }

    // A bundle's prices by asset (docs/specs/prices.md): each a USD price
    if (key === "usdPrices" && value !== null && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).map((asset) => [asset, FIXED_PRICE_USD]));
    }

    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.walk(v, k)]));
    }

    if (typeof value === "string") {
      return this.anonymiseString(value, key);
    }

    // THORNode gives some heights and amounts as numbers
    if (typeof value === "number" && key && HEIGHT_KEY.test(key)) {
      return Number(FIXED_HEIGHT);
    }

    if (typeof value === "number" && key && ISO_TIME_KEYS.has(key)) {
      return Number(this.anonymiseString(value.toString(), key));
    }

    if (typeof value === "number" && Number.isFinite(value) && !(key && (KEEP_KEYS.has(key) || DATE_KEYS.has(key)))) {
      // Large integers would print as 1e+21; BigInt gives every digit
      return Number(this.scale(Number.isInteger(value) ? BigInt(value).toString() : value.toString()));
    }

    return value;
  }

  // The fee is what the mappers read: ranked as one amount, then written back as 1 gas at that price
  private anonymiseReceipt({ gasUsed, effectiveGasPrice, l1Fee, ...rest }: any): any {
    const wei = BigInt(gasUsed) * BigInt(effectiveGasPrice) + BigInt(l1Fee ?? 0);
    const baseUnits = (wei + WEI_PER_BASE_UNIT - 1n) / WEI_PER_BASE_UNIT;
    const ranked = BigInt(this.scale(baseUnits.toString())) * WEI_PER_BASE_UNIT;
    return { ...this.walk(rest, undefined), gasUsed: "0x1", effectiveGasPrice: `0x${ranked.toString(16)}` };
  }

  private anonymiseString(value: string, key: string | undefined): string {
    // A name replaced in a memo is replaced wherever else it appears (e.g. as an output address)
    if (!this.collecting && this.names.has(value)) {
      return this.names.get(value)!;
    }

    // JSON inside a string (e.g. a contract msg) is anonymised like the rest
    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(this.walk(JSON.parse(value), key));
      } catch {
        // not JSON
      }
    }

    if (key && DATE_KEYS.has(key) && /^\d{19}$/.test(value)) {
      // Midgard dates are nanoseconds
      return (BigInt(FIXED_TIME.getTime()) * 1_000_000n).toString();
    }

    if (key && DATE_KEYS.has(key) && /^\d{10}$/.test(value)) {
      // TCY distribution dates are seconds
      return (FIXED_TIME.getTime() / 1000).toString();
    }

    if (key && ISO_TIME_KEYS.has(key) && /^\d{13}$/.test(value)) {
      // Viewblock timestamps are milliseconds
      return FIXED_TIME.getTime().toString();
    }

    if ((key && ISO_TIME_KEYS.has(key) && !isNaN(Date.parse(value))) || ISO_TIME.test(value)) {
      return FIXED_TIME.toISOString().replace(/\.000Z$/, "Z");
    }

    if (key && HEX_BLOCK_KEYS.has(key) && HEX_QUANTITY.test(value)) {
      return `0x${BigInt(FIXED_HEIGHT).toString(16)}`;
    }

    if (key && HEIGHT_KEY.test(key) && /^\d+$/.test(value)) {
      return FIXED_HEIGHT;
    }

    if (key && PRICE_KEY.test(key) && value !== "" && !isNaN(Number(value))) {
      return FIXED_PRICE_USD;
    }

    // Why a refund happened, in free text that can quote amounts and addresses
    if (key === "reason") {
      return "anonymised";
    }

    // An account sequence (<address>/<n>) counts the wallet's txs
    if (key === "acc_seq") {
      return value.replace(/\/\d+$/, "/1").replace(ADDRESS_PATTERN, (match) => this.replaceAddress(match));
    }

    if (key === "affiliateAddress") {
      return value
        .split("/")
        .map((name) => this.replaceName(name))
        .join("/");
    }

    if (key === "memo") {
      return this.anonymiseMemo(value);
    }

    if (NUMBER.test(value) && !(key && KEEP_KEYS.has(key))) {
      return this.scale(value);
    }

    // Before addresses: part of a signature can look like an address, which would leave the rest
    if (BASE64.test(value) && (/[+/=]/.test(value) || (key !== undefined && BLOB_KEYS.has(key)))) {
      return this.replaceBlob(value);
    }

    const replaced = value
      .replace(TXID_PATTERN, (match) => this.replaceTxid(match))
      .replace(ADDRESS_PATTERN, (match) => this.replaceAddress(match));

    if (replaced !== value) {
      return replaced;
    }

    if (COINS_PATTERN.test(value)) {
      return value.replace(/(^|,)(\d+)/g, (_match, sep, amount) => sep + this.scale(amount));
    }

    return value;
  }

  // A memo is ':'-separated: its action stays, as does the asset after it; numbers are ranked like
  // amounts (limits, streaming settings, fees in basis points); addresses and txids are replaced; any
  // other name (a THORName, an affiliate, an aggregator code) becomes a placeholder.
  // https://dev.thorchain.org/concepts/memos.html
  private anonymiseMemo(memo: string): string {
    return memo
      .split(":")
      .map((part, i) => {
        if (i === 0 || part === "") {
          return part;
        }

        if (part.split("/").every((piece) => NUMBER.test(piece))) {
          return part
            .split("/")
            .map((piece) => this.scale(piece))
            .join("/");
        }

        const replaced = part
          .replace(TXID_PATTERN, (match) => this.replaceTxid(match))
          .replace(ADDRESS_PATTERN, (match) => this.replaceAddress(match));

        if (replaced !== part || i === 1 || MEMO_ASSET.test(part)) {
          return replaced;
        }

        return part
          .split("/")
          .map((name) => this.replaceName(name))
          .join("/");
      })
      .join(":");
  }

  // A name that is not an address (a THORName, an affiliate code) becomes name1, name2, …
  private replaceName(name: string): string {
    if (!name) {
      return name;
    }

    const replaced = name.replace(ADDRESS_PATTERN, (match) => this.replaceAddress(match));

    if (replaced !== name) {
      return replaced;
    }

    if (!this.names.has(name)) {
      this.names.set(name, `name${this.names.size + 1}`);
    }

    return this.names.get(name)!;
  }

  private replaceBlob(blob: string): string {
    if (!this.blobs.has(blob)) {
      this.blobs.set(blob, `anon-blob-${this.blobs.size + 1}`);
    }

    return this.blobs.get(blob)!;
  }

  // An amount's rank (see the top of the file). Zero stays zero and the sign is kept.
  private scale(amount: string): string {
    const sign = amount.startsWith("-") ? "-" : "";
    const magnitude = amount.replace(/^-/, "");
    const isDecimal = magnitude.includes(".");
    // 1.50 and 1.5 are the same amount
    const key = isDecimal ? `d:${magnitude.replace(/0+$/, "").replace(/\.$/, ".0")}` : BigInt(magnitude).toString();

    if (Number(magnitude) === 0) {
      return amount;
    }

    if (this.collecting) {
      if (isDecimal) {
        this.decimals.add(key.slice(2));
      } else {
        this.integers.add(BigInt(key));
      }

      return amount;
    }

    return sign + this.ranks.get(key)!;
  }

  private replaceTxid(txid: string): string {
    if (/^(0x)?0+$/.test(txid)) {
      return txid;
    }

    const key = txid.toLowerCase().replace(/^0x/, "");

    if (!this.txids.has(key)) {
      this.txids.set(key, (this.txids.size + 1).toString(16).toUpperCase().padStart(64, "A"));
    }

    return (txid.startsWith("0x") ? "0x" : "") + this.txids.get(key)!;
  }

  private replaceAddress(address: string): string {
    if (CONTRACT_ADDRESS_PATTERN.test(address)) {
      return address;
    }

    const key = address.toLowerCase();

    if (!this.addresses.has(key)) {
      const prefix = key.startsWith("0x") ? "0x" : (key.match(/^[a-z]+1/)?.[0] ?? address[0]);
      this.addresses.set(key, `${prefix}-anon-wallet-${this.addresses.size + 1}`);
    }

    return this.addresses.get(key)!;
  }
}

// Every token (a run of letters and digits, at least 4 long) in a value's strings and numbers
export function getTokens(value: any, tokens = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => getTokens(item, tokens));
  } else if (value !== null && typeof value === "object") {
    // A Cosmos event attribute's key is a field name, like a JSON key: only its value counts
    const isAttribute = typeof value.key === "string" && "value" in value && Object.keys(value).length === 2;
    (isAttribute ? [value.value] : Object.values(value)).forEach((item) => getTokens(item, tokens));
  } else if (typeof value === "string" || typeof value === "number") {
    String(value)
      .split(/[^A-Za-z0-9]+/)
      .filter((token) => token.length >= 4 && !/^0+$/.test(token))
      .forEach((token) => tokens.add(token.toLowerCase()));
  }

  return tokens;
}

// The original's tokens still in the anonymised copy, other than those already public (in the repo's
// code, docs and cases: asset names, action types, shared contracts). Anything here could identify the
// original transaction, so a case with any is not written.
export function findSurvivors(original: any, anonymised: any, publicTokens: Set<string>): string[] {
  const after = getTokens(anonymised);
  return [...getTokens(original)].filter((token) => after.has(token) && !publicTokens.has(token)).sort();
}
