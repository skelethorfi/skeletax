import { keccak256 } from "./Keccak.ts";

// An EVM address (0x and 40 hex digits) is case-insensitive; its mixed case is only a checksum (EIP-55).
// Other formats are case-sensitive (base58 BTC, DOGE and LTC addresses), or always lowercase (bech32).
export function isEvmAddress(address: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(address);
}

// The one spelling of an address for grouping: an EVM address lowercase, any other as given
export function addressKey(address: string): string {
  return isEvmAddress(address) ? address.toLowerCase() : address;
}

// An EVM address in its EIP-55 checksum spelling: a hex letter is uppercase where the nibble at its position in
// keccak256 of the lowercase hex (without 0x) is 8 or more
export function checksumAddress(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = Buffer.from(keccak256(Buffer.from(hex, "ascii"))).toString("hex");
  return "0x" + [...hex].map((char, i) => (parseInt(hash[i], 16) >= 8 ? char.toUpperCase() : char)).join("");
}
