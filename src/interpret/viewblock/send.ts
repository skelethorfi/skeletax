import type { Activity } from "../../domain/Activity.ts";
import type { Issue } from "../../domain/Issue.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { memoOf, MSG_SEND_TYPES, type ViewblockTx } from "../../sources/viewblock/index.ts";
import { failedSend, type Send, sendActivity } from "../midgard/send.ts";

// A Viewblock send, for sends before 2022-04 that Midgard does not list (docs/specs/sends.md). The coin is
// the tx's input; a failed tx (code other than 0) moved nothing, and before 2022-04 paid no fee either (failedSend).
export function interpretViewblockSend(
  bundle: RawBundle,
  protocol: Protocol,
): { activities: Activity[]; issues: Issue[] } {
  const tx = bundle.data as ViewblockTx;
  const msgs = tx.msgs.filter((msg) => MSG_SEND_TYPES.includes(msg["@type"]));

  if (msgs.length !== 1 || msgs[0].amount.length !== 1) {
    throw new Error(`a Viewblock send with ${msgs.length} send messages`);
  }

  const send: Send = {
    id: getBundleKey(bundle),
    time: new Date(tx.timestamp),
    txid: tx.hash,
    from: msgs[0].from_address,
    to: msgs[0].to_address,
    asset: tx.input.asset,
    amount: msgs[0].amount[0].amount,
    memo: memoOf(tx),
  };

  if (tx.code !== 0) {
    return failedSend(send, tx.height, bundle.wallet, protocol);
  }

  return { activities: [sendActivity(send, bundle.wallet, protocol)], issues: [] };
}
