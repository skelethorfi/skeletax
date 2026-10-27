import { API_URLS } from "../../config/apiUrls.ts";
import { http } from "../http.ts";
import { RecordStore } from "../store/RecordStore.ts";
import { TCY_CLAIM_RULES } from "../store/Sources.ts";

// What a TCY claim was for (docs/specs/thorfi-collapse.md): the claiming address's claim entries at the height
// before the claim, its savers record of each entry's asset at that height, and its loans. THORNode no longer
// serves loans; Midgard's borrower is their state now, which is the state at the claim, since no loan was closed
// after the collapse.
export interface TcyClaimData {
  // THORNode tcy_claimer at height - 1: an entry per asset; amount in TCY base units
  claims: { asset: string; amount: string }[];
  // THORNode saver of each entry's asset at height - 1 (units 0 when none)
  savers: { asset: string; units: string }[];
  // Midgard borrower: a pool per collateral asset (none when the address never borrowed)
  loans: { collateralAsset: string; collateralDeposited: string; collateralWithdrawn: string }[];
}

export class TcyClaimService {
  private store: RecordStore;
  constructor(store: RecordStore = new RecordStore("_cache")) {
    this.store = store;
  }

  // address: the claiming address (the action's in); height: the claim's; date: the claim's, to file it by
  async getClaim(address: string, height: number, date: Date): Promise<TcyClaimData> {
    return this.store.record(
      "tcy-claim",
      `${address}.${height}`,
      () => this.fetchClaim(address, height),
      TCY_CLAIM_RULES,
      date,
    );
  }

  private async fetchClaim(address: string, height: number) {
    const at = height - 1;
    const claimerUrl = `${API_URLS.thornode}/thorchain/tcy_claimer/${address}?height=${at}`;
    const claimers: { asset: string; amount: string }[] = (await http.get(claimerUrl)).data.tcy_claimer ?? [];
    const claims = claimers.map(({ asset, amount }) => ({ asset, amount }));
    const savers = [];

    for (const { asset } of claims) {
      const saver = (await http.get(`${API_URLS.thornode}/thorchain/pool/${asset}/saver/${address}?height=${at}`)).data;
      savers.push({ asset, units: String(saver.units ?? "0") });
    }

    return {
      data: { claims, savers, loans: await this.fetchLoans(address) },
      url: claimerUrl,
    };
  }

  private async fetchLoans(address: string): Promise<TcyClaimData["loans"]> {
    try {
      const pools: any[] = (await http.get(`${API_URLS.midgard}/v2/borrower/${address}`)).data.pools ?? [];
      return pools.map((pool) => ({
        collateralAsset: pool.collateral_asset,
        collateralDeposited: String(pool.collateral_deposited),
        collateralWithdrawn: String(pool.collateral_withdrawn),
      }));
    } catch (error: any) {
      // Midgard answers 404 for an address that never borrowed
      if (error?.response?.status === 404) {
        return [];
      }
      throw error;
    }
  }
}
