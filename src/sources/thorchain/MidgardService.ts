import { RecordStore } from "../store/RecordStore.ts";
import { MIDGARD_LIST, RUNE_PRICE_RULES, type RunePrice } from "../store/Sources.ts";
import { type Action, Configuration, DefaultApi } from "@xchainjs/xchain-midgard";
import assert from "assert";
import { API_URLS } from "../../config/apiUrls.ts";
import { http } from "../http.ts";
import { checksumAddress, isEvmAddress } from "../../utils/Address.ts";

// https://github.com/xchainjs/xchainjs-lib/tree/master/packages/xchain-midgard
// midgard api: https://midgard.thorswap.net/v2/doc
// midgard swagger json: https://midgard.thorchain.info/v2/swagger.json (a copy: docs/reference/midgard-api-2.32.9.json)

// NOTE:
// can load balance between 2 like web3tax
// MIDGARD_URL_A: "https://midgard.thorchain.info/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}"
// MIDGARD_URL_B: "https://midgard.thorswap.net/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}"

// Seconds in one of Midgard's 5min history buckets
const RUNE_PRICE_INTERVAL = 300;

// Midgard matches the `address` filter exactly. EVM senders are lowercase, and Midgard lowercases other EVM
// addresses only for events on the chains it treats as case-insensitive (ETH on THORChain; ETH and ARB on Maya);
// otherwise (e.g. an outbound on AVAX, BSC or BASE for a swap from BTC) the address keeps the case of the memo, which
// is usually the lowercase or the checksum (EIP-55) spelling. So an EVM wallet is queried in those spellings and as
// configured (Midgard splits the filter on commas and returns an action matching any). Other formats are
// case-sensitive and are queried as given.
export function midgardAddress(address: string): string {
  if (!isEvmAddress(address)) {
    return address;
  }

  return [...new Set([address.toLowerCase(), checksumAddress(address), address])].join(",");
}

export class MidgardService {
  api: DefaultApi;

  // source: the store folder, e.g. 'midgard' or 'maya-midgard'
  private store: RecordStore;
  private source: string;
  private basePath: string;
  constructor(
    store: RecordStore = new RecordStore("_cache"),
    source: string = "midgard",
    basePath: string = API_URLS.midgard,
  ) {
    this.store = store;
    this.source = source;
    this.basePath = basePath;
    this.api = new DefaultApi(new Configuration({ basePath }), basePath, http);
  }

  async getActions(address: string): Promise<Action[]> {
    console.log(`[Midgard] getActions('${address}')`);

    return this.store.list(
      this.source,
      address,
      async () => ({
        data: await this.fetchActions(midgardAddress(address)),
        url: `${this.basePath}/v2/actions?address=${midgardAddress(address)}`,
      }),
      MIDGARD_LIST,
    );
  }

  // RUNE's USD price in the 5-minute bucket holding `date`, as a `<source>-rune-price` record
  async getRunePrice(date: Date): Promise<RunePrice> {
    const start = Math.floor(date.getTime() / 1000 / RUNE_PRICE_INTERVAL) * RUNE_PRICE_INTERVAL;
    const url = `${this.basePath}/v2/history/rune?interval=5min&from=${start}&to=${start + RUNE_PRICE_INTERVAL}`;

    return this.store.record<RunePrice>(
      `${this.source}-rune-price`,
      String(start),
      async () => {
        const intervals: Omit<RunePrice, "final">[] = (await http.get(url)).data.intervals;
        const bucket = intervals.find((item) => Number(item.startTime) === start);

        if (!bucket) {
          throw new Error(`[Midgard] no RUNE price for the bucket starting ${start}`);
        }

        const final = Number(bucket.endTime) * 1000 <= Date.now();
        return {
          data: { startTime: bucket.startTime, endTime: bucket.endTime, runePriceUSD: bucket.runePriceUSD, final },
          url,
        };
      },
      RUNE_PRICE_RULES,
      date,
    );
  }

  private async fetchActions(address: string): Promise<Action[]> {
    let actions: Action[] = [];
    let count: number = 0;

    for (let page = 0; page <= 100; page++) {
      const response = await this.api.getActions(
        address,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        50,
        page * 50,
      );
      count = parseInt(response.data.count || "0");

      console.log(`[Midgard] Total actions: ${count}`);
      console.log("page:", page);
      console.log("actions:", response.data.actions.length);

      if (count === 0) {
        break;
      }

      actions = actions.concat(response.data.actions);

      console.log(new Date(parseInt(response.data.actions[0].date) / 1000000));

      if (response.data.actions.length < 50) {
        break;
      }
    }

    assert.equal(actions.length, count);

    return actions;
  }
}
