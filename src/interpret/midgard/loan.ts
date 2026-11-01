import type { Action, Transaction } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import { parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import { getActionDate, memoDestination } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { inboundGas } from "./gas.ts";

// https://dev.thorchain.org/concepts/memos.html (open loan, repay loan)
const LOANOPEN_DESTADDR = 2;
const REPAYLOAN_ASSET = 1;
const REPAYLOAN_DESTADDR = 2;

// A loan open (docs/specs/loans.md): collateral sent in, with its gas, and the amount borrowed paid to the
// memo's destination. Midgard sometimes shows the input as THOR.TOR; the collateral sent is then in the
// THORNode tx.
export function interpretLoanOpen(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;

  if (action.in.length !== 1) {
    throw new Error(`loan: expected 1 input but there were ${action.in.length}`);
  }

  const sent = getCollateral(action, bundle);
  const output = getOutput(action, sent.memo, LOANOPEN_DESTADDR);
  const gas = inboundGas(sent.txid, bundle, sent.wallet, sent.asset, protocol);

  return activity(
    bundle,
    protocol,
    "loan.open",
    sent.memo,
    [
      { ...leg("out", sent.wallet, sent.asset, sent.amount, sent.txid) },
      ...(gas ? [{ ...gas, txid: sent.txid }] : []),
      leg("in", output.address, output.coins[0].asset, output.coins[0].amount, output.txID ?? ""),
    ],
    {},
  );
}

// A loan repayment: the repayment sent in, with its gas; when the loan closes (one output), the collateral
// paid back to the memo's destination. The memo names the collateral asset.
export function interpretLoanRepay(bundle: RawBundle, protocol: Protocol): Activity {
  const action = bundle.data as Action;

  if (action.in.length !== 1) {
    throw new Error(`loan: expected 1 input but there were ${action.in.length}`);
  }

  const input = action.in[0];
  const memo = action.metadata.swap?.memo;

  if (!memo) {
    throw new Error("loan: no memo");
  }

  const txid = input.txID ?? "";
  const gas = inboundGas(txid, bundle, input.address, input.coins[0].asset, protocol);
  const closed = action.out.length === 1 ? getOutput(action, memo, REPAYLOAN_DESTADDR) : undefined;

  return activity(
    bundle,
    protocol,
    "loan.repay",
    memo,
    [
      leg("out", input.address, input.coins[0].asset, input.coins[0].amount, txid),
      ...(gas ? [{ ...gas, txid }] : []),
      ...(closed ? [leg("in", closed.address, closed.coins[0].asset, closed.coins[0].amount, closed.txID ?? "")] : []),
    ],
    { collateral: memo.split(":")[REPAYLOAN_ASSET] },
  );
}

function getCollateral(
  action: Action,
  bundle: RawBundle,
): { wallet: string; asset: string; amount: string; txid: string; memo?: string } {
  if (action.in[0].coins[0].asset !== "THOR.TOR") {
    const input = action.in[0];
    return {
      wallet: input.address,
      asset: input.coins[0].asset,
      amount: input.coins[0].amount,
      txid: input.txID ?? "",
      memo: action.metadata.swap?.memo,
    };
  }

  const tx = bundle.thornodeTxs[0]?.tx;
  const coin = tx?.coins[0];

  if (!coin) {
    throw new Error("loan: missing input coin");
  }

  return { wallet: tx.from_address ?? "", asset: coin.asset, amount: coin.amount, txid: tx.id ?? "", memo: tx.memo };
}

function getOutput(action: Action, memo: string | undefined, destIndex: number): Transaction {
  if (!memo) {
    throw new Error("loan: no memo");
  }

  const dest = memoDestination(memo, destIndex);
  const out = action.out.find((out) => out.address.toLowerCase() === dest?.toLowerCase());

  if (!out) {
    throw new Error("loan: no matching out tx");
  }

  return out;
}

// Loan amounts are reported with 8 decimals, as THORChain's are
function leg(direction: Leg["direction"], wallet: string, asset: string, amount: string, txid: string): Leg {
  return {
    direction,
    wallet,
    asset: toAsset(asset),
    amount: parseAmount(amount, 8),
    role: "principal",
    basis: "observed",
    txid,
  };
}

function activity(
  bundle: RawBundle,
  protocol: Protocol,
  kind: Activity["kind"],
  memo: string | undefined,
  legs: Leg[],
  details: Record<string, string>,
): Activity {
  const action = bundle.data as Action;

  return {
    id: getBundleKey(bundle),
    protocol: protocol.id,
    kind,
    status: action.status as Activity["status"],
    time: getActionDate(action),
    ...(memo ? { memo } : {}),
    legs,
    prices: [],
    details,
  };
}
