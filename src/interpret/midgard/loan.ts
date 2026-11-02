import type { Action, Transaction } from "@xchainjs/xchain-midgard";
import type { Activity, Leg } from "../../domain/Activity.ts";
import type { Issue } from "../../domain/Issue.ts";
import { formatAmount, parseAmount } from "../../domain/Amount.ts";
import { toAsset } from "../../domain/Asset.ts";
import { getActionDate, memoDestination, onlyCoin } from "../../sources/thorchain/MidgardUtils.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "../../sources/RawBundle.ts";
import { inboundGas } from "./gas.ts";
import type { Interpretation } from "../registry.ts";

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
  const borrowed = loanCoin(output);

  return activity(
    bundle,
    protocol,
    "loan.open",
    sent.memo,
    [
      { ...leg("out", sent.wallet, sent.asset, sent.amount, sent.txid) },
      ...(gas ? [{ ...gas, txid: sent.txid }] : []),
      leg("in", output.address, borrowed.asset, borrowed.amount, output.txID ?? ""),
    ],
    {},
  );
}

// A loan repayment: the repayment sent in, with its gas; when the loan closes, the collateral paid back to the
// memo's destination in the asset the memo names. The collateral can come back in several outputs (a large
// outbound is split); each is a leg. Any other output is not exported and raises a warning.
export function interpretLoanRepay(bundle: RawBundle, protocol: Protocol): Interpretation {
  const action = bundle.data as Action;

  if (action.in.length !== 1) {
    throw new Error(`loan: expected 1 input but there were ${action.in.length}`);
  }

  const input = action.in[0];
  const memo = action.metadata.swap?.memo;

  if (!memo) {
    throw new Error("loan: no memo");
  }

  const collateral = memo.split(":")[REPAYLOAN_ASSET] ?? "";
  const dest = memoDestination(memo, REPAYLOAN_DESTADDR);

  if (!dest) {
    throw new Error(`loan: the memo names no destination (${memo})`);
  }

  const isCollateral = (out: Transaction) =>
    out.address.toLowerCase() === dest.toLowerCase() &&
    out.coins.length === 1 &&
    out.coins[0].asset.toUpperCase() === collateral.toUpperCase();
  const returned = action.out.filter(isCollateral);
  const others = action.out.filter((out) => !isCollateral(out));
  const issues: Issue[] = others.map((out) => ({
    kind: "warning",
    message: `loan repayment: output of ${out.coins.map((coin) => `${formatAmount(parseAmount(coin.amount, 8))} ${coin.asset}`).join(", ")} to ${out.address} is not the ${collateral} collateral paid to the memo's destination; not exported`,
  }));

  const txid = input.txID ?? "";
  const repaid = loanCoin(input);
  const gas = inboundGas(txid, bundle, input.address, repaid.asset, protocol);

  return {
    activities: [
      activity(
        bundle,
        protocol,
        "loan.repay",
        memo,
        [
          leg("out", input.address, repaid.asset, repaid.amount, txid),
          ...(gas ? [{ ...gas, txid }] : []),
          ...returned.map((out) => leg("in", out.address, out.coins[0].asset, out.coins[0].amount, out.txID ?? "")),
        ],
        { collateral },
      ),
    ],
    issues,
  };
}

function getCollateral(
  action: Action,
  bundle: RawBundle,
): { wallet: string; asset: string; amount: string; txid: string; memo?: string } {
  const input = action.in[0];
  const inputCoin = loanCoin(input);

  if (inputCoin.asset !== "THOR.TOR") {
    return {
      wallet: input.address,
      asset: inputCoin.asset,
      amount: inputCoin.amount,
      txid: input.txID ?? "",
      memo: action.metadata.swap?.memo,
    };
  }

  const tx = bundle.thornodeTxs[0]?.tx;
  const coin = onlyCoin(tx, "loan");

  if (!tx || !coin) {
    throw new Error("loan: missing input coin");
  }

  return { wallet: tx.from_address ?? "", asset: coin.asset, amount: coin.amount, txid: tx.id ?? "", memo: tx.memo };
}

// The one coin of a loan's input or output: none, or several, fails the action (onlyCoin)
function loanCoin(tx: { coins: { asset: string; amount: string }[] }): { asset: string; amount: string } {
  const coin = onlyCoin(tx, "loan");

  if (!coin) {
    throw new Error("loan: a tx with no coin");
  }

  return coin;
}

function getOutput(action: Action, memo: string | undefined, destIndex: number): Transaction {
  if (!memo) {
    throw new Error("loan: no memo");
  }

  const dest = memoDestination(memo, destIndex);

  if (!dest) {
    throw new Error(`loan: the memo names no destination (${memo})`);
  }

  const out = action.out.find((out) => out.address.toLowerCase() === dest.toLowerCase());

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
