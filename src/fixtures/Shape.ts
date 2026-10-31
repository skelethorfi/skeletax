import type { Action } from "@xchainjs/xchain-midgard";

// The parts of a Midgard action that decide how it is mapped. Two actions with the same
// shape should exercise the same mapper code path, so a public tx with the same shape as
// a private one can be used as its fixture.
export interface ActionShape {
  type: string;
  status: string;
  subtype?: string;
  inAssets: string[][];
  outAssets: string[][];
  // Denoms sent to a contract (contract actions carry their amounts here, not in coins)
  funds?: string[];
  // The memo's action, e.g. '=' or 'swap' for a user swap, or 'MAYA-PREFERRED-ASSET-…' for a
  // protocol-initiated swap of affiliate fees
  memoAction?: string;
  // The memo names an aggregator's final token: mapped from the outbound's receipt (activity.md)
  finalToken?: boolean;
}

export function getActionShape(action: Action): ActionShape {
  const metadata = action.metadata as any;

  return {
    type: action.type,
    status: action.status,
    subtype: metadata?.swap?.txType ?? metadata?.contract?.contractType ?? undefined,
    inAssets: action.in.map((tx) => tx.coins.map((coin) => coin.asset).sort()),
    outAssets: action.out.map((tx) => tx.coins.map((coin) => coin.asset).sort()).sort(),
    ...(metadata?.contract ? { funds: parseFundsDenoms(metadata.contract.funds) } : {}),
    ...(metadata?.swap?.memo !== undefined ? { memoAction: getMemoAction(metadata.swap.memo) } : {}),
    ...(metadata?.swap?.memo?.split(":")[7] ? { finalToken: true } : {}),
  };
}

// Swap memos start with '=', 's' or 'swap' (case-insensitive) for a user swap
export function getMemoAction(memo: string): string {
  const action = memo.split(":")[0].toLowerCase();
  return ["=", "s", "swap"].includes(action) ? "swap" : action.replace(/-[^-]*$/, "");
}

// Contract funds are "<amount><denom>" entries separated by commas, e.g. "11127297300x/ruji"
export function parseFundsDenoms(funds: string | undefined): string[] {
  return (funds ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^\d+/, ""))
    .filter((denom) => denom)
    .sort();
}

export function sameShape(a: ActionShape, b: ActionShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function describeShape(shape: ActionShape): string {
  const assets = (txs: string[][]) => txs.map((coins) => coins.join("+")).join(", ");
  const funds = shape.funds?.length ? ` funds [${shape.funds.join(", ")}]` : "";
  const final = shape.finalToken ? " to an aggregator's final token" : "";
  return `${shape.type}${shape.subtype ? `/${shape.subtype}` : ""} ${shape.status}: [${assets(shape.inAssets)}] -> [${assets(shape.outAssets)}]${funds}${final}`;
}

// Every address and txid in the action, used to check a candidate shares nothing private
export function getActionIds(action: Action): string[] {
  const ids: string[] = [];

  for (const tx of [...action.in, ...action.out]) {
    if (tx.address) ids.push(tx.address);
    if (tx.txID) ids.push(tx.txID);
  }

  return ids;
}
