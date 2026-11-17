import { http } from "../http.ts";
import { RecordStore, StoreMissError } from "../store/RecordStore.ts";
import { InputError } from "../../utils/InputError.ts";
import { V1_BLOCK_TIME_RULES, V1_SENDS_LIST } from "../store/Sources.ts";
import { API_URLS } from "../../config/apiUrls.ts";
import { THORNODE_V1_LAST_HEIGHT } from "./ThornodeService.ts";
import type { ViewblockTx } from "../viewblock/ViewblockTx.ts";

// THORChain v1's archive lists every successful native tx an address signed (`message.sender`), which Midgard does not
// always list: a pending add withdrawn, a deposit that did nothing (docs/specs/sends.md, Txs Midgard omits). Failed txs
// are not in that index; Midgard lists them. The current chain (from the 2024-09-04 fork) has no such index.

// A native tx of the v1 chain, trimmed to what the mappers read
export interface V1Tx {
  hash: string;
  height: number;
  // The tx's time, to the second (the block time is fetched for the txs that give rows: blockTime)
  timestamp: string;
  code: number;
  // The first message: its type ('MsgDeposit', 'MsgSend'), signer, memo and coins
  type: string;
  signer: string;
  memo: string;
  coins: { asset: string; amount: string }[];
  // Its events, keys and values decoded (the archive gives them base64 for older blocks)
  events: { type: string; attributes: Record<string, string> }[];
}

// The day after the v1 chain's last block (the 2024-09-04 fork): a run that ends before the cutoff or starts from this
// day reads none of its txs
export const THORNODE_V1_UNTIL = "2024-09-05";

// The archive answers at most this many txs a page
const PAGE = 100;
// A guard against a listing that never ends
const MAX_PAGES = 1000;

// A block's time, with its nanoseconds (row times are taken from it, to the millisecond)
export interface V1BlockTime {
  height: number;
  time: string;
}

// A value as the archive gives it: plain, or base64 for older blocks
function decode(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return value;
  }

  const text = Buffer.from(value, "base64").toString("utf8");
  return /^[\x20-\x7e]+$/.test(text) ? text : value;
}

export function toV1Tx(response: any): V1Tx {
  const message = response.tx?.body?.messages?.[0] ?? {};
  const coins = message.coins ?? message.amount ?? [];
  return {
    hash: response.txhash,
    height: Number(response.height),
    timestamp: response.timestamp,
    code: Number(response.code ?? 0),
    type:
      String(message["@type"] ?? "")
        .split(".")
        .pop() ?? "",
    signer: message.signer ?? message.from_address ?? "",
    memo: message.memo ?? response.tx?.body?.memo ?? "",
    coins: coins.map((coin: any) => ({
      asset: String(coin.asset ?? coin.denom ?? "").toUpperCase(),
      amount: String(coin.amount ?? "0"),
    })),
    events: (response.events ?? [])
      .filter((event: any) => event.type !== "tx")
      .map((event: any) => ({
        type: event.type,
        attributes: Object.fromEntries((event.attributes ?? []).map((a: any) => [decode(a.key), decode(a.value)])),
      })),
  };
}

// The archive is best-effort, as Viewblock is (docs/specs/sends.md, Txs Midgard omits): a failure is a warning for
// the run summary, not the end of the run
export class ThornodeV1 {
  private store: RecordStore;
  private listWarnings: string[] = [];
  // Blocks whose time could not be fetched
  private blockWarnings: string[] = [];
  constructor(store: RecordStore) {
    this.store = store;
  }

  // What the run should say about the archive: lists that could not be fetched or came back short, and blocks
  // whose time could not be fetched (their txs' rows keep the listed second)
  warnings(): string[] {
    return [
      ...this.listWarnings,
      ...(this.blockWarnings.length
        ? [
            `THORChain v1: could not fetch the time of ${this.blockWarnings.length} blocks; their txs' rows are at the ` +
              `second the archive listed, so a row entered by hand at the block's time is not overtaken ` +
              `(docs/specs/sends.md, Txs Midgard omits): ${this.blockWarnings.join(", ")}`,
          ]
        : []),
    ];
  }

  // Every successful native tx the address signed on the v1 chain, through the store (fetched once)
  async getSends(address: string): Promise<V1Tx[]> {
    if (this.store.addedSinceReplay("thornode-v1-sends")) {
      return [];
    }

    const url = `${API_URLS.thornodeArchive}/cosmos/tx/v1beta1/txs?events=message.sender='${address}'`;
    return this.store.list("thornode-v1-sends", address, async () => ({ ...(await this.fetchSends(address)), url }), {
      ...V1_SENDS_LIST,
      onIncomplete: (incomplete) =>
        this.listWarnings.push(
          `THORChain v1's list of the txs ${address} signed is short (${incomplete}); a deposit that did nothing or a ` +
            "withdrawn pending add, which Midgard does not list, may be missing (docs/specs/sends.md, Txs Midgard omits)",
        ),
      onFetchError: (error, stored) =>
        this.listWarnings.push(
          `THORChain v1: could not list the txs ${address} signed (${reason(error)}); ` +
            (stored
              ? "using the list stored by an earlier run"
              : "its deposits that did nothing and withdrawn pending adds from 2022-04-01, which Midgard does not list, are missing") +
            " (docs/specs/sends.md, Txs Midgard omits)",
        ),
    });
  }

  // A block's time, through the store; undefined when it cannot be fetched (a warning, and the replay of this run
  // skips it too), as for Viewblock's inbounds. Not stored when offline or replayed, or not matching the replayed run,
  // is an error
  async getBlockTime(height: number, date?: Date): Promise<V1BlockTime | undefined> {
    const key = String(height);

    if (this.store.skippedInReplay("thornode-v1-block", key)) {
      this.blockWarnings.push(`${key} (skipped by the replayed run)`);
      return undefined;
    }

    try {
      return await this.store.record(
        "thornode-v1-block",
        key,
        async () => {
          const url = `${API_URLS.thornodeArchive}/cosmos/base/tendermint/v1beta1/blocks/${height}`;
          const header = (await http.get(url)).data.block.header;
          return { data: { height, time: header.time }, url };
        },
        V1_BLOCK_TIME_RULES,
        date,
      );
    } catch (error) {
      if (error instanceof StoreMissError || error instanceof InputError) {
        throw error;
      }

      this.store.recordSkipped("thornode-v1-block", key);
      this.blockWarnings.push(`${key} (${reason(error)})`);
      return undefined;
    }
  }

  // One tx by hash, unstored (the fixture tool: the tx may be anyone's)
  async fetchTx(hash: string): Promise<V1Tx> {
    const response = (await http.get(`${API_URLS.thornodeArchive}/cosmos/tx/v1beta1/txs/${hash}`)).data;
    return toV1Tx({ ...response.tx_response, tx: response.tx ?? response.tx_response?.tx });
  }

  private async fetchSends(address: string): Promise<{ data: V1Tx[]; incomplete?: string }> {
    const txs: V1Tx[] = [];
    let seen = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = (
        await http.get(`${API_URLS.thornodeArchive}/cosmos/tx/v1beta1/txs`, {
          params: {
            events: `message.sender='${address}'`,
            "pagination.limit": PAGE,
            "pagination.offset": page * PAGE,
            order_by: "ORDER_BY_ASC",
          },
        })
      ).data;
      const listed = (response.tx_responses ?? []).map((tx: any, i: number) =>
        toV1Tx({ ...tx, tx: response.txs?.[i] ?? tx.tx }),
      );
      txs.push(...listed.filter((tx: V1Tx) => tx.height <= THORNODE_V1_LAST_HEIGHT));
      seen += listed.length;
      const total = Number(response.pagination?.total ?? 0);

      if (listed.length < PAGE || (total && seen >= total)) {
        // A page that came back short of the total the archive reports
        return total && seen < total ? { data: txs, incomplete: `${seen} of ${total} txs` } : { data: txs };
      }
    }

    return { data: txs, incomplete: `more than ${MAX_PAGES * PAGE} txs` };
  }
}

// THORChain's Reserve module, which a native tx's fee is paid to
const RESERVE = "thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt";
// THORChain's native fee on the v1 chain, in base units (0.02 RUNE)
const V1_NATIVE_FEE = 2000000n;
// The events of moving coins, which every tx has for its fee; any other event is THORChain's (an add, a withdrawal,
// an outbound, a bond) and means the tx did something
const COIN_EVENTS = new Set(["coin_spent", "coin_received", "transfer", "message"]);

// A deposit that did nothing (docs/specs/sends.md, Txs Midgard omits): a successful MsgDeposit with no THORChain event,
// whose only transfers are the native fee from the signer to the Reserve
export function isNoopDeposit(tx: V1Tx): boolean {
  if (tx.type !== "MsgDeposit" || tx.code !== 0 || tx.events.some((event) => !COIN_EVENTS.has(event.type))) {
    return false;
  }

  const transfers = tx.events.filter((event) => event.type === "transfer").map((event) => event.attributes);
  const fee = transfers.reduce((sum, t) => sum + BigInt(/^(\d+)rune$/.exec(t.amount ?? "")?.[1] ?? "-1"), 0n);
  return (
    transfers.length > 0 &&
    transfers.every((t) => t.sender === tx.signer && t.recipient === RESERVE && /^\d+rune$/.test(t.amount ?? "")) &&
    fee === V1_NATIVE_FEE
  );
}

// A native asset as Viewblock and Midgard name it ('rune' → 'THOR.RUNE')
function assetName(asset: string): string {
  return asset === "RUNE" ? "THOR.RUNE" : asset;
}

// The tx in Viewblock's shape, so the pending-add pairing and its mapper read it as they read Viewblock's
// (docs/specs/fees.md, Pending adds that are withdrawn). time: ms since 1970, the block's time when known
export function toViewblockTx(tx: V1Tx, time: number = Date.parse(tx.timestamp)): ViewblockTx {
  const action = tx.memo.trim().split(":")[0].toUpperCase();
  const types =
    tx.type === "MsgSend"
      ? ["send"]
      : // First: an add or a withdrawal that did nothing paid only its fee (a pending withdrawal has an outbound)
        isNoopDeposit(tx)
        ? ["deposit", "noop"]
        : ["+", "ADD", "A"].includes(action)
          ? ["liquidity", "add"]
          : ["-", "WD", "WITHDRAW"].includes(action)
            ? ["liquidity", "withdraw"]
            : ["deposit"];
  const outbounds = tx.events
    .filter((event) => event.type === "outbound" && event.attributes.coin)
    .map((event) => {
      const [amount, asset] = event.attributes.coin.split(" ");
      const id = event.attributes.id ?? "";
      return {
        ...(/^0*$/.test(id) ? {} : { hash: id }),
        chain: event.attributes.chain ?? "",
        from: event.attributes.from ?? "",
        to: event.attributes.to ?? "",
        amount,
        asset: assetName(asset ?? ""),
        timestamp: time,
      };
    });
  const coin = tx.coins[0];
  return {
    hash: tx.hash,
    timestamp: time,
    height: tx.height,
    blockIndex: 0,
    code: tx.code,
    status: tx.code === 0 ? "success" : "failed",
    types,
    memo: tx.memo,
    signer: tx.signer,
    input: { chain: "THOR", asset: assetName(coin?.asset ?? "RUNE"), amount: coin?.amount ?? "0" },
    msgs: [],
    outbounds,
  };
}

// The tx at its block's time (ms since 1970), and its outbounds with it
export function atBlockTime(tx: ViewblockTx, time: number): void {
  tx.timestamp = time;
  for (const outbound of tx.outbounds ?? []) {
    outbound.timestamp = time;
  }
}

function reason(error: any): string {
  return String(error?.response?.status ?? error?.code ?? error?.message ?? error);
}
