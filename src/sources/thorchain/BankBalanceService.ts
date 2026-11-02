import { type Fetched, type RecordRules, RecordStore } from "../store/RecordStore.ts";
import { http } from "../http.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { parseMidgardAsset } from "./MidgardUtils.ts";
import { RECEIPT_TOKENS } from "../../interpret/midgard/rujira.ts";

// A THORChain or Maya wallet's bank balances now (/cosmos/bank/v1beta1/balances/<address>), for the balance check
// (docs/specs/run-summary.md, Balance check). Amounts are in base units of each denom.
export interface BankBalances {
  balances: { denom: string; amount: string }[];
}

// A balance changes whenever the wallet moves funds, so every run that fetches asks again; a fetch that returns
// what the latest copy holds stores nothing. Keyed by the address, filed in undated/.
export const BANK_BALANCE_RULES: RecordRules<BankBalances> = { isPending: () => true };

export class BankBalanceService {
  private store: RecordStore;
  private url: string;
  readonly source: string;
  constructor(store: RecordStore, url: string, source: string) {
    this.store = store;
    this.url = url;
    this.source = source;
  }

  async balances(address: string): Promise<BankBalances> {
    return this.store.record(this.source, address, () => this.fetchBalances(address), BANK_BALANCE_RULES);
  }

  private async fetchBalances(address: string): Promise<Fetched<BankBalances>> {
    const url = `${this.url}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=1000`;
    const data = (await http.get(url)).data;

    if (data?.pagination?.next_key) {
      throw new Error(`${url}: more than one page of balances`);
    }

    // Only the coins: the pagination total says nothing the list does not
    const balances = (data?.balances ?? []).map(({ denom, amount }: any) => ({ denom, amount: String(amount) }));
    return { data: { balances }, url };
  }
}

// A bank denom as the CSV names its currency (docs/specs/assets.md), and the decimals of its amounts: rune → RUNE,
// btc/btc → ThorSynth.BTC.BTC, btc-btc → BTC (or ThorSecured.BTC.BTC), x/ruji → RUJI, x/staking-x/ruji → SRUJI. A
// denom that is no asset Midgard names (e.g. an IBC denom) keeps the denom as its name.
export function bankCurrency(denom: string, protocol: Protocol): { currency: string; decimals: number } {
  const notation = RECEIPT_TOKENS[denom] ?? (/[/\-~.]/.test(denom) ? denom : `${protocol.nativeChain}.${denom}`);

  try {
    return {
      currency: parseMidgardAsset(notation.toUpperCase(), protocol).currency,
      decimals: protocol.decimals(notation),
    };
  } catch {
    return { currency: denom, decimals: protocol.decimals(notation) };
  }
}
