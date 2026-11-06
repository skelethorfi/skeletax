// A THORChain tx as Viewblock's address listing returns it (api.viewblock.io/thorchain/addresses/<address>/txs).
// The listing has no fee; Viewblock's single-tx endpoint does, but sends pay the native fee (docs/specs/sends.md).
export interface ViewblockTx {
  hash: string;
  // Milliseconds since the epoch
  timestamp: number;
  height: number;
  blockIndex: number;
  code: number;
  status: string; // "success"
  // What Viewblock makes of the tx, e.g. ["network", "send", "main"] or ["swap", "main"]
  types: string[];
  // A string on sends; an object with the raw memo on other txs
  memo?: string | { raw?: string };
  signer: string;
  // The coin sent; none on a withdrawal request
  input: {
    chain: string; // "THOR"
    asset: string; // "THOR.RUNE", "DOGE/DOGE", "TCY"
    amount: string; // 1e8 units
  };
  msgs: ViewblockMsg[];
  // A liquidity tx (docs/specs/fees.md, Pending adds that are withdrawn): an L1 inbound's observation, and the
  // payouts of a withdrawal
  observation?: {
    from: string;
    to: string;
    chain: string;
    gas?: { asset: string; amount: string }[];
  } | null;
  outbounds?: ViewblockOutbound[] | null;
}

// A payout of a withdrawal: an L1 tx with its own hash, or a THORChain payout with none
export interface ViewblockOutbound {
  hash?: string;
  chain: string;
  from: string;
  to: string;
  amount: string; // 1e8 units
  asset: string;
  timestamp: number;
}

export interface ViewblockMsg {
  "@type": string; // one of MSG_SEND_TYPES for a send
  from_address: string;
  to_address: string;
  amount: {
    denom: string; // "rune"
    amount: string;
  }[];
}

// The message types of a send, before and after the 2022-03 chain upgrade
export const MSG_SEND_TYPES = ["/cosmos.bank.v1beta1.MsgSend", "/types.MsgSend"];

// Viewblock's record of one inbound tx (api.viewblock.io/thorchain/txs/<hash>), trimmed to the gas THORNode
// observed for it: Viewblock keeps that observation after THORNode prunes the tx (docs/specs/fees.md).
// found: false when Viewblock does not know the hash.
export interface ViewblockInbound {
  hash: string;
  found: boolean;
  // 1e8 units, whatever Viewblock's decimals field says
  gas: { asset: string; amount: string }[];
}

// The tx's memo as written
export function memoOf(tx: ViewblockTx): string {
  return (typeof tx.memo === "string" ? tx.memo : tx.memo?.raw) ?? "";
}

// Viewblock's kind of a tx, from its types
export const isViewblockSend = (tx: ViewblockTx) => tx.types.includes("send");
export const isViewblockWithdraw = (tx: ViewblockTx) => tx.types.includes("liquidity") && tx.types.includes("withdraw");
export const isViewblockAdd = (tx: ViewblockTx) => tx.types.includes("liquidity") && tx.types.includes("add");
