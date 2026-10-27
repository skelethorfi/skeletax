import { type Action, ActionTypeEnum as ActionType } from "@xchainjs/xchain-midgard";
import type { Issue } from "../domain/Issue.ts";
import type { RawBundle } from "../sources/RawBundle.ts";
import { type Protocol, THORCHAIN } from "../domain/Protocol.ts";
import { interpretBond } from "./midgard/bond.ts";
import { interpretSwap } from "./midgard/swap.ts";
import { interpretRefund } from "./midgard/refund.ts";
import { interpretAddLiquidity, interpretWithdraw } from "./midgard/liquidity.ts";
import { interpretRunePool, interpretSwitch } from "./midgard/switch.ts";
import { interpretLoanOpen, interpretLoanRepay } from "./midgard/loan.ts";
import { interpretTcyClaim, interpretTcyDistribution, interpretTcyStake, interpretThorname } from "./midgard/tcy.ts";
import type { Activity, Leg } from "../domain/Activity.ts";
import { interpretRujira, RUJIRA_CONTRACT_TYPES } from "./midgard/rujira.ts";
import { interpretSend } from "./midgard/send.ts";
import { interpretFailedDeposit } from "./midgard/failed.ts";
import { interpretViewblockSend } from "./viewblock/send.ts";
import { interpretMayaDistribution } from "./maya/distribution.ts";

// The activities of one bundle, which an exporter turns into rows, and its problems
export interface Interpretation {
  activities: Activity[];
  issues: Issue[];
}

// Turns one bundle into activities. Pure: no network, files, clock or logging; problems are returned as issues.
export type Interpreter = (bundle: RawBundle, protocol: Protocol) => Interpretation;

const activity =
  (interpreter: (bundle: RawBundle, protocol: Protocol) => Activity): Interpreter =>
  (bundle, protocol) => ({ activities: [interpreter(bundle, protocol)], issues: [] });

// Keyed on 'source/type' or 'source/type/subtype'; a subtype entry wins over its type's
const REGISTRY: Record<string, Interpreter> = {
  [`midgard/${ActionType.AddLiquidity}`]: interpretAddLiquidity,
  [`midgard/${ActionType.Withdraw}`]: interpretWithdraw,
  [`midgard/${ActionType.Swap}`]: interpretSwap,
  [`midgard/${ActionType.Swap}/loanOpen`]: activity(interpretLoanOpen),
  [`midgard/${ActionType.Swap}/loanRepayment`]: activity(interpretLoanRepay),
  [`midgard/${ActionType.Refund}`]: interpretRefund,
  [`midgard/${ActionType.Switch}`]: activity(interpretSwitch),
  [`midgard/${ActionType.Thorname}`]: activity(interpretThorname),
  [`midgard/${ActionType.RunePoolDeposit}`]: activity(interpretRunePool),
  [`midgard/${ActionType.RunePoolWithdraw}`]: activity(interpretRunePool),
  "midgard/bond": activity(interpretBond),
  "midgard/unbond": activity(interpretBond),
  "midgard/tcy_claim": interpretTcyClaim,
  "midgard/tcy_stake": activity(interpretTcyStake),
  "midgard/tcy_unstake": activity(interpretTcyStake),
  [`midgard/${ActionType.Send}`]: interpretSend,
  "midgard/failed": interpretFailedDeposit,
  ...Object.fromEntries(RUJIRA_CONTRACT_TYPES.map((type) => [`midgard/contract/${type}`, interpretRujira])),
  // Viewblock gives only sends from before 2022-04 that Midgard does not list (docs/specs/sends.md)
  "viewblock/send": interpretViewblockSend,
  "tcy/distribution": activity(interpretTcyDistribution),
  "maya-distribution/payout": (bundle, protocol) => ({
    activities: interpretMayaDistribution(bundle, protocol),
    issues: [],
  }),
};

// Midgard action types handled on protocols other than THORChain (see docs/specs/maya.md)
const NON_THORCHAIN_ACTION_TYPES: string[] = [
  ActionType.Swap,
  ActionType.AddLiquidity,
  ActionType.Withdraw,
  ActionType.Refund,
  ActionType.Send,
  "failed",
];

export function getBundleType(bundle: RawBundle): { type: string; subtype?: string } {
  switch (bundle.source) {
    case "midgard": {
      const action = bundle.data as Action;

      if (action.type === ActionType.Swap) {
        const txType = (action.metadata.swap as any)?.txType;
        // Some loan opens show as a noOp swap from TOR, the swap output being the loan
        const isLoanOpen = txType === "noOp" && action.in[0].coins[0].asset === "THOR.TOR";
        return { type: action.type, subtype: isLoanOpen ? "loanOpen" : txType };
      }

      if ((action.type as string) === "contract") {
        return { type: action.type, subtype: (action.metadata as any).contract?.contractType };
      }

      return { type: action.type };
    }
    case "viewblock":
      return { type: "send" };
    case "tcy":
      return { type: "distribution" };
    case "maya-distribution":
      return { type: "payout" };
  }
}

export function findInterpreter(bundle: RawBundle, protocol: Protocol): Interpreter | undefined {
  const { type, subtype } = getBundleType(bundle);

  if (bundle.source === "midgard" && protocol.id !== THORCHAIN.id && !NON_THORCHAIN_ACTION_TYPES.includes(type)) {
    return undefined;
  }

  return (
    (subtype !== undefined ? REGISTRY[`${bundle.source}/${type}/${subtype}`] : undefined) ??
    REGISTRY[`${bundle.source}/${type}`]
  );
}

export function interpret(bundle: RawBundle, baseProtocol: Protocol): Interpretation {
  // The native fee at the action's height, when the source gave it, is the default gas of every leg it pays
  const protocol = bundle.nativeFee ? { ...baseProtocol, defaultGas: bundle.nativeFee } : baseProtocol;

  try {
    const interpreter = findInterpreter(bundle, protocol);

    if (!interpreter) {
      const { type, subtype } = getBundleType(bundle);
      return {
        activities: [],
        issues: [{ kind: "unsupported", message: `unsupported action: ${[type, subtype].filter(Boolean).join(" ")}` }],
      };
    }

    return withSourceTxids(interpreter(bundle, protocol));
  } catch (e: any) {
    return { activities: [], issues: [{ kind: "failed", message: failureMessage(bundle, protocol, e) }] };
  }
}

// A leg names a txid only when the source gives a tx: not an empty one, nor the all-zero txid Midgard gives a
// payout made on the protocol's own chain, which has no tx of its own (docs/specs/activity.md)
function withSourceTxids(result: Interpretation): Interpretation {
  const hasTx = (leg: Leg) => !!leg.txid && !(leg.direction === "in" && /^0+$/.test(leg.txid));
  const activities = result.activities.map((activity) => ({
    ...activity,
    legs: activity.legs.map((leg) => {
      if (hasTx(leg)) {
        return leg;
      }

      const { txid, ...rest } = leg;
      return rest;
    }),
  }));
  return { ...result, activities };
}

function failureMessage(bundle: RawBundle, protocol: Protocol, e: any): string {
  const message = e?.message || "unknown error";

  if (bundle.source !== "midgard") {
    return message;
  }

  const action = bundle.data as Action;
  const txId = action.in?.[0]?.txID || "unknown";
  return `[${protocol.id === THORCHAIN.id ? "Midgard" : protocol.id + " Midgard"}] ${message}. type: ${action.type}, txid: ${txId}`;
}
