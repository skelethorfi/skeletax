import { RecordStore } from "../store/RecordStore.ts";
import { EVM_PAYOUT_RULES, EVM_RECEIPT_RULES } from "../store/Sources.ts";
import { EVM_RPC_URLS } from "../../config/apiUrls.ts";
import { http } from "../http.ts";

// The EVM chains THORChain takes inbounds on, and the coin each pays gas in
export const EVM_GAS_ASSETS: Record<string, string> = {
  ETH: "ETH.ETH",
  AVAX: "AVAX.AVAX",
  BSC: "BSC.BNB",
  BASE: "BASE.ETH",
};

// An EVM tx's receipt (eth_getTransactionReceipt), trimmed to what its fee is made of. Quantities are the
// RPC's hex strings, in wei.
export interface EvmReceipt {
  chain: string;
  transactionHash: string;
  blockNumber: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  // The L1 data fee of an OP-stack chain (BASE)
  l1Fee?: string;
}

// What an aggregator outbound delivered (docs/specs/activity.md, Aggregator payouts): the memo's final token
// that the tx transferred to the wallet. No token when it delivered none: the aggregator's swap failed, and
// the wallet got the pool asset. `amount` is in the token's base units.
export interface EvmTokenPayout {
  chain: string;
  transactionHash: string;
  token: { contract: string; symbol: string; decimals: number; amount: string } | null;
}

const ERC20_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// A symbol() or decimals() answer: an ABI string, or (older tokens) a bytes32
export function decodeSymbol(hex: string): string {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const text =
    bytes.length > 32 ? bytes.subarray(64, 64 + Number(BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`))) : bytes;
  return text.toString("utf8").replace(/\0+$/, "");
}

// The final token's transfers to the wallet in a receipt's logs, summed. tail: the memo's short form of the
// token, the end of its contract address
export function findTokenTransfer(
  logs: { address: string; topics: string[]; data: string }[],
  to: string,
  tail: string,
): { contract: string; amount: string } | undefined {
  const paddedTo = `0x${to.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  const transfers = logs.filter(
    (log) =>
      log.topics[0] === ERC20_TRANSFER &&
      log.topics.length === 3 &&
      log.topics[2]?.toLowerCase() === paddedTo &&
      log.address.toLowerCase().endsWith(tail.toLowerCase()),
  );

  if (new Set(transfers.map((log) => log.address.toLowerCase())).size > 1) {
    throw new Error(`more than one token ending ${tail} was paid to ${to}`);
  }

  const amount = transfers.reduce((sum, log) => sum + BigInt(log.data), 0n);
  return amount > 0n ? { contract: transfers[0].address.toLowerCase(), amount: amount.toString() } : undefined;
}

// What the wallet paid to send the tx, in wei (docs/specs/fees.md)
export function receiptFee(receipt: EvmReceipt): bigint {
  return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee ?? 0);
}

export function isEvmChain(chain: string): boolean {
  return chain in EVM_GAS_ASSETS;
}

// JSON-RPC errors a public endpoint gives for load (limit exceeded, request limit, internal error)
const TRANSIENT_RPC_CODES = [-32005, -32016, -32603];

function isRateLimit(error: any): boolean {
  return TRANSIENT_RPC_CODES.includes(error?.code) || /rate|limit/i.test(error?.message ?? "");
}

// An answer withRetry retries (as a 503) when transient
function rpcError(message: string, transient: boolean): Error {
  return Object.assign(new Error(message), transient ? { status: 503 } : {});
}

export class EvmReceipts {
  private store: RecordStore;
  private urls: Record<string, string>;
  constructor(store: RecordStore, urls: Record<string, string> = EVM_RPC_URLS) {
    this.store = store;
    this.urls = urls;
  }

  // txId: as Midgard gives it (upper case, no 0x). Undefined only when replaying a run made before this source
  // was read. date: of the action the tx belongs to
  async getReceipt(chain: string, txId: string, date?: Date): Promise<EvmReceipt | undefined> {
    if (this.store.addedSinceReplay("evm-receipt")) {
      return undefined;
    }

    const url = this.urls[chain];

    if (!url) {
      throw new Error(`No RPC endpoint for ${chain}`);
    }

    const hash = `0x${txId.replace(/^0x/i, "").toLowerCase()}`;
    return this.store.record(
      "evm-receipt",
      `${chain}.${hash}`,
      async () => ({ data: await this.fetchReceipt(chain, url, hash), url }),
      EVM_RECEIPT_RULES,
      date,
    );
  }

  // The token an aggregator outbound paid `to` (docs/specs/activity.md, Aggregator payouts). Undefined only when
  // replaying a run made before this source was read: such a run keeps the pool asset.
  async getTokenPayout(
    chain: string,
    txId: string,
    to: string,
    tail: string,
    date?: Date,
  ): Promise<EvmTokenPayout | undefined> {
    if (this.store.addedSinceReplay("evm-payout")) {
      return undefined;
    }

    const url = this.urls[chain];

    if (!url) {
      throw new Error(`No RPC endpoint for ${chain}`);
    }

    const hash = `0x${txId.replace(/^0x/i, "").toLowerCase()}`;
    return this.store.record(
      "evm-payout",
      `${chain}.${hash}`,
      async () => ({ data: await this.fetchTokenPayout(chain, url, hash, to, tail), url }),
      EVM_PAYOUT_RULES,
      date,
    );
  }

  private async fetchTokenPayout(
    chain: string,
    url: string,
    hash: string,
    to: string,
    tail: string,
  ): Promise<EvmTokenPayout> {
    const receipt = await this.rawReceipt(chain, url, hash);

    // A reverted outbound, or an endpoint that leaves logs out, says nothing about what arrived, so it is never stored
    if (BigInt(receipt.status ?? 0) !== 1n || !Array.isArray(receipt.logs)) {
      throw new Error(`${chain} receipt ${hash}: not a successful tx with logs`);
    }

    const transfer = findTokenTransfer(receipt.logs, to, tail);

    if (!transfer) {
      return { chain, transactionHash: receipt.transactionHash, token: null };
    }

    const call = async (data: string, name: string) => {
      const answer = await this.rpc(chain, url, "eth_call", [{ to: transfer.contract, data }, "latest"], name);

      if (!answer || answer === "0x") {
        throw new Error(`${chain} token ${transfer.contract}: no ${name}`);
      }

      return answer as string;
    };
    const symbol = decodeSymbol(await call("0x95d89b41", "symbol"));
    const decimals = Number(BigInt(await call("0x313ce567", "decimals")));

    if (!symbol) {
      throw new Error(`${chain} token ${transfer.contract}: no symbol`);
    }

    return { chain, transactionHash: receipt.transactionHash, token: { ...transfer, symbol, decimals } };
  }

  private async rpc(chain: string, url: string, method: string, params: unknown[], what: string): Promise<any> {
    const response = await http.post(url, { jsonrpc: "2.0", id: 1, method, params });
    const { result, error } = response.data ?? {};

    if (error) {
      throw rpcError(`${chain} ${what}: ${error.message ?? JSON.stringify(error)}`, isRateLimit(error));
    }

    return result;
  }

  private async rawReceipt(chain: string, url: string, hash: string): Promise<any> {
    const result = await this.rpc(chain, url, "eth_getTransactionReceipt", [hash], `receipt ${hash}`);

    // A pruning node answers null, as it does for a tx it never saw. A load-balanced endpoint can briefly route to
    // one, so it is retried; never stored, so a later run asks again.
    if (!result) {
      throw rpcError(
        `${chain} receipt ${hash}: not returned by ${url} (set ${chain}_RPC_URL to an endpoint that keeps old receipts)`,
        true,
      );
    }

    return result;
  }

  private async fetchReceipt(chain: string, url: string, hash: string): Promise<EvmReceipt> {
    const result = await this.rawReceipt(chain, url, hash);
    const { effectiveGasPrice } = result;

    // Every receipt has it since London (2021), old txs included; an endpoint that leaves it out can't be used
    if (!result.gasUsed || !effectiveGasPrice) {
      throw new Error(`${chain} receipt ${hash}: no gasUsed or effectiveGasPrice`);
    }

    // An OP-stack operator fee (Isthmus) is charged on top; its formula has changed between upgrades, and Base
    // charges none (2026-10): a receipt with one stops the run rather than leave that fee out
    if (BigInt(result.operatorFeeScalar ?? 0) > 0n || BigInt(result.operatorFeeConstant ?? 0) > 0n) {
      throw new Error(`${chain} receipt ${hash}: has an operator fee, which receiptFee does not add yet`);
    }

    return {
      chain,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber,
      status: result.status,
      gasUsed: result.gasUsed,
      effectiveGasPrice,
      ...(result.l1Fee ? { l1Fee: result.l1Fee } : {}),
    };
  }
}
