import type { Activity } from "../../domain/Activity.ts";
import type { Issue } from "../../domain/Issue.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { memoOf, type ViewblockTx } from "../../sources/viewblock/index.ts";
import { nativeGas } from "../midgard/bond.ts";
import { depositActionName } from "../midgard/failed.ts";

// A THORChain v1 deposit Midgard does not list that did nothing (docs/specs/sends.md, Txs Midgard omits): e.g. an
// UNBOND with nothing to unbond, or a withdrawal sent again after the position was out. It paid the native fee.
export function interpretNoopDeposit(
  bundle: RawBundle,
  protocol: Protocol,
): { activities: Activity[]; issues: Issue[] } {
  const tx = bundle.data as ViewblockTx;
  const memo = memoOf(tx);
  return {
    activities: [
      {
        id: getBundleKey(bundle),
        protocol: protocol.id,
        kind: "deposit.noop",
        status: "success",
        time: new Date(tx.timestamp),
        memo: memo || undefined,
        legs: [{ ...nativeGas(tx.signer, protocol), txid: tx.hash }],
        prices: [],
        details: { from: tx.signer, to: protocol.counterparty, action: depositActionName(memo) },
      },
    ],
    issues: [],
  };
}

// Any other v1 tx Midgard does not list (a send, a deposit that moved more than its fee): not guessed at
export function interpretUnlistedV1Tx(bundle: RawBundle): { activities: Activity[]; issues: Issue[] } {
  const tx = bundle.data as ViewblockTx;
  return {
    activities: [],
    issues: [
      {
        kind: "warning",
        message: `a THORChain tx Midgard does not list (${tx.hash}, ${tx.types.join("/")}${memoOf(tx) ? `, memo ${memoOf(tx)}` : ""}): check what it did and enter it by hand`,
      },
    ],
  };
}
