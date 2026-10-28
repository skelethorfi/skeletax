// An EVM address (0x and 40 hex digits) is case-insensitive; its mixed case is only a checksum (EIP-55).
// Other formats are case-sensitive (base58 BTC, DOGE and LTC addresses), or always lowercase (bech32).
export function isEvmAddress(address: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(address);
}

// The one spelling of an address for grouping: an EVM address lowercase, any other as given
export function addressKey(address: string): string {
  return isEvmAddress(address) ? address.toLowerCase() : address;
}
