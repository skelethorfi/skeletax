import { http } from "../http.ts";
import { RecordStore, StoreMissError } from "../store/RecordStore.ts";
import { VIEWBLOCK_LIST, VIEWBLOCK_TX_RULES } from "../store/Sources.ts";
import type { ViewblockInbound, ViewblockTx } from "./ViewblockTx.ts";

// Viewblock's THORChain API, used for sends Midgard does not list, from before 2022-04 (docs/specs/sends.md),
// and for the gas of an inbound THORNode has pruned (docs/specs/fees.md). It is unofficial: it answers requests that carry viewblock.io as their Origin, as
// its web pages do, and may change without notice.
const BASE_URL = "https://api.viewblock.io/thorchain";
const HEADERS = { Origin: "https://viewblock.io" };

interface Page {
  docs: ViewblockTx[];
  pages: number;
  total: number;
}

// A guard against a listing that never ends
const MAX_PAGES = 1000;

// Viewblock answered 429: its quota for the unofficial API is small, and the lockout it gives (value, in ms) can
// last days. Not retried, as retrying within the run cannot help: the rest of the run skips Viewblock.
export class ViewblockRateLimited extends Error {
  constructor(until?: Date) {
    super(`Viewblock is rate-limited (429)${until ? ` until ${until.toISOString()}` : ""}`);
    this.name = "ViewblockRateLimited";
  }
}

// Viewblock is best-effort (docs/specs/sends.md): a failure is a warning for the run summary, not the end of the run
export class Viewblock {
  private store: RecordStore;
  private rateLimited?: { until?: Date };
  private listWarnings: string[] = [];
  private gasSkipped: string[] = [];
  private gasStale: string[] = [];
  constructor(store: RecordStore) {
    this.store = store;
  }

  // Every tx of the address, through the store. A complete list once stored is not fetched again (only by
  // --refetch-all): only its txs before 2022-04 are used, and those do not change. A short one is fetched again on
  // the next run, and warned about on every run that uses it. When the fetch fails, the stored list is used.
  async getTxs(address: string): Promise<ViewblockTx[]> {
    const url = `${BASE_URL}/addresses/${address}/txs?network=mainnet`;
    return this.store.list("viewblock", address, async () => ({ ...(await this.fetchTxs(url)), url }), {
      ...VIEWBLOCK_LIST,
      onIncomplete: (incomplete) =>
        this.listWarnings.push(
          `Viewblock's list of the txs of ${address} is short (${incomplete}); ` +
            "a send or a withdrawn pending add before 2022-04-01, which Midgard does not list, may be missing (docs/specs/sends.md)",
        ),
      onFetchError: (error, stored) =>
        this.listWarnings.push(
          `Viewblock: could not list the txs of ${address} (${reason(error)}); ` +
            (stored
              ? "using the list stored by an earlier run"
              : "its sends and withdrawn pending adds before 2022-04-01, which Midgard does not list, are missing") +
            " (docs/specs/sends.md)",
        ),
    });
  }

  // The gas THORNode observed for one inbound, through the store; undefined when replaying a run made before
  // this source was read or that could not reach it, or when Viewblock cannot be reached and nothing is stored
  // (a stored copy is used when a refetch fails, as for lists). date: of the action the tx belongs to
  async getInbound(hash: string, date?: Date): Promise<ViewblockInbound | undefined> {
    if (this.store.addedSinceReplay("viewblock-tx") || this.store.skippedInReplay("viewblock-tx", hash)) {
      return undefined;
    }

    const url = `${BASE_URL}/txs/${hash}?network=mainnet`;

    try {
      return await this.store.record(
        "viewblock-tx",
        hash,
        async () => ({ data: await this.fetchInbound(url, hash), url }),
        VIEWBLOCK_TX_RULES,
        date,
        { onFetchError: (error) => this.gasStale.push(`${hash} (${reason(error)})`) },
      );
    } catch (error) {
      if (error instanceof StoreMissError) {
        throw error;
      }

      this.store.recordSkipped("viewblock-tx", hash);
      this.gasSkipped.push(`${hash} (${reason(error)})`);
      return undefined;
    }
  }

  // What the run should say about Viewblock in its summary: lists it could not fetch or that came back short, and
  // inbounds whose gas it could not fetch (left out, or the stored copy used)
  warnings(): string[] {
    return [
      ...(this.rateLimited
        ? [
            `Viewblock answered 429 (rate-limited${this.rateLimited.until ? ` until ${this.rateLimited.until.toISOString()}` : ""}); the rest of the run skipped it`,
          ]
        : []),
      ...this.listWarnings,
      ...(this.gasSkipped.length
        ? [
            `Viewblock: could not fetch the gas of ${this.gasSkipped.length} inbound(s) THORNode has pruned; their fee is left out (docs/specs/fees.md): ${this.gasSkipped.join(", ")}`,
          ]
        : []),
      ...(this.gasStale.length
        ? [
            `Viewblock: could not fetch again the gas of ${this.gasStale.length} inbound(s); using the copy stored by an earlier run (docs/specs/fees.md): ${this.gasStale.join(", ")}`,
          ]
        : []),
    ];
  }

  private async fetchInbound(url: string, hash: string): Promise<ViewblockInbound> {
    const response = await this.get(url, (status) => status === 200 || status === 404);

    if (response.status === 404) {
      return { hash, found: false, gas: [] };
    }

    const gas = (response.data?.observation?.gas ?? []).map(({ asset, amount }: any) => ({ asset, amount }));
    return { hash, found: true, gas };
  }

  // Pages until one comes back empty or adds nothing new, or the total is reached: the page count the API reports
  // has been seen to stop short of its total. A listing still short of the total is kept, marked incomplete.
  private async fetchTxs(url: string): Promise<{ data: ViewblockTx[]; incomplete?: string }> {
    const first = await this.page(url, 1);
    const txs = new Map(first.docs.map((tx) => [tx.hash, tx]));

    for (let page = 2; page <= MAX_PAGES && txs.size < first.total; page++) {
      const docs = (await this.page(url, page)).docs ?? [];
      const before = txs.size;
      docs.forEach((tx) => txs.has(tx.hash) || txs.set(tx.hash, tx));

      if (txs.size === before) {
        break;
      }
    }

    return {
      data: [...txs.values()],
      ...(txs.size !== first.total ? { incomplete: `listed ${txs.size} of the ${first.total} txs it reports` } : {}),
    };
  }

  private async page(url: string, page: number): Promise<Page> {
    return (await this.get(`${url}&page=${page}`)).data;
  }

  // Once Viewblock has answered 429, the rest of the run asks it nothing
  private async get(url: string, validateStatus?: (status: number) => boolean) {
    if (this.rateLimited) {
      throw new ViewblockRateLimited(this.rateLimited.until);
    }

    try {
      return await http.get(url, { headers: HEADERS, ...(validateStatus ? { validateStatus } : {}) });
    } catch (error: any) {
      if (error?.response?.status !== 429) {
        throw error;
      }

      const value = Number(error.response.data?.value);
      this.rateLimited = { until: value > 0 ? new Date(Date.now() + value) : undefined };
      throw new ViewblockRateLimited(this.rateLimited.until);
    }
  }
}

function reason(error: any): string {
  return String(error?.response?.status ?? error?.code ?? error?.message ?? error);
}
