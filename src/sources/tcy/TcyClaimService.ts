import crypto from "node:crypto";
import { API_URLS } from "../../config/apiUrls.ts";
import { http } from "../http.ts";
import { RecordStore } from "../store/RecordStore.ts";
import { TCY_CLAIM_RULES, TCY_CLAIM_SYNTHS_RULES } from "../store/Sources.ts";

// THORNode's claim list, as embedded since TCY was added (thornode c979858d8; unchanged since), and its SHA-256:
// a fixed list of {asset, address, tcy_claim}. THORNode serves no past heights through the public gateway, and
// after a claim the address has no entries, so the list is where a claim's asset comes from.
const CLAIM_LIST_URL =
  "https://gitlab.com/thorchain/thornode/-/raw/c979858d83106d8959c1140365231a1a6492b837/common/tcyclaimlist/tcy_claimers_mainnet.json";
const CLAIM_LIST_SHA256 = "84ed39921085534b5c3c213fe87115ec046eff9fd238674491c572ca87ee29ff";

// What a TCY claim was for (docs/specs/thorfi-collapse.md): the claiming address's entries in the claim list, its
// savers positions and its loans. Savers and loans are Midgard's, built from their add, withdraw, open and repay
// events: none happened after the collapse, so they are the positions at the claim (THORNode's own savers records
// were changed by later migrations, which Midgard does not follow).
export interface TcyClaimData {
  // The claim list's entries of the address, one per asset (THORNode sums repeated rows); amount in TCY base units
  claims: { asset: string; amount: string }[];
  // Midgard saver: a pool per savers position, its units (the position tokens the adds gave)
  savers: { asset: string; units: string }[];
  // Midgard borrower: a pool per collateral asset (none when the address never borrowed)
  loans: { collateralAsset: string; collateralDeposited: string; collateralWithdrawn: string }[];
  // A THORChain address's synths in the block before the claim (Midgard's balance at that height), synth notation
  // ('ETH/VTHOR-0X…'); absent for an L1 address, and for a run replayed from before it was kept
  synths?: { asset: string; amount: string }[];
}

export class TcyClaimService {
  private store: RecordStore;
  private claimList?: Promise<{ asset: string; address: string; tcy_claim: number }[]>;
  constructor(store: RecordStore = new RecordStore("_cache")) {
    this.store = store;
  }

  // address: the claiming address (the action's in); height and date: the claim's, to key and file it by.
  // Undefined when replaying a run made before this source existed: such a run read nothing from it.
  async getClaim(address: string, height: number, date: Date): Promise<TcyClaimData | undefined> {
    if (this.store.addedSinceReplay("tcy-claim")) {
      return undefined;
    }

    const key = `${address}.${height}`;
    const claim = await this.store.record("tcy-claim", key, () => this.fetchClaim(address), TCY_CLAIM_RULES, date);

    // Synths a THORChain address held are frozen with ThorFi and can be what a claim was for: kept as their own
    // record, so claims stored before it get it too
    if (!address.toLowerCase().startsWith("thor1") || this.store.addedSinceReplay("tcy-claim-synths")) {
      return claim;
    }

    const synths = await this.store.record(
      "tcy-claim-synths",
      key,
      () => this.fetchSynths(address, height),
      TCY_CLAIM_SYNTHS_RULES,
      date,
    );
    return { ...claim, synths };
  }

  // The address's synth balances in the block before the claim
  private async fetchSynths(address: string, height: number) {
    const coins: { asset: string; amount: string }[] =
      (await this.midgard(`/v2/balance/${address}?height=${height - 1}`))?.coins ?? [];
    return {
      data: coins
        // A synth is '<chain>/<asset>'; 'x/…' is a Cosmos denom (e.g. x/ruji), not a synth
        .filter((coin) => coin.asset.includes("/") && !/^x\//i.test(coin.asset) && BigInt(coin.amount) > 0n)
        .map((coin) => ({ asset: coin.asset.toUpperCase(), amount: String(coin.amount) })),
      url: `${API_URLS.midgard}/v2/balance/${address}?height=${height - 1}`,
    };
  }

  private async fetchClaim(address: string) {
    const amounts = new Map<string, bigint>();

    for (const entry of await this.loadClaimList()) {
      if (entry.address.toLowerCase() === address.toLowerCase()) {
        const asset = entry.asset.toUpperCase();
        amounts.set(asset, (amounts.get(asset) ?? 0n) + BigInt(entry.tcy_claim));
      }
    }

    const savers: any[] = (await this.midgard(`/v2/saver/${address}`))?.pools ?? [];
    const loans: any[] = (await this.midgard(`/v2/borrower/${address}`))?.pools ?? [];

    return {
      data: {
        claims: [...amounts].map(([asset, amount]) => ({ asset, amount: String(amount) })),
        savers: savers.map((pool) => ({ asset: pool.pool, units: String(pool.saverUnits) })),
        loans: loans.map((pool) => ({
          collateralAsset: pool.collateral_asset,
          collateralDeposited: String(pool.collateral_deposited),
          collateralWithdrawn: String(pool.collateral_withdrawn),
        })),
      },
      url: `${API_URLS.midgard}/v2/saver/${address}`,
    };
  }

  // Midgard answers 404 for an address with no savers position, or that never borrowed
  private async midgard(path: string): Promise<any> {
    try {
      return (await http.get(`${API_URLS.midgard}${path}`)).data;
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  // Fetched once per run, and checked against its hash. A failed fetch is not kept, so a retry fetches again.
  private loadClaimList() {
    this.claimList ??= (async () => {
      const text: string = (await http.get(CLAIM_LIST_URL, { responseType: "text", transformResponse: (x) => x })).data;
      const hash = crypto.createHash("sha256").update(text).digest("hex");

      if (hash !== CLAIM_LIST_SHA256) {
        throw new Error(`TCY claim list: unexpected content (sha256 ${hash})`);
      }

      return JSON.parse(text);
    })().catch((error) => {
      this.claimList = undefined;
      throw error;
    });
    return this.claimList;
  }
}
