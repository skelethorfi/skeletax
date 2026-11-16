import { assetFromStringEx } from "@xchainjs/xchain-util";
import type { Activity, Leg } from "../../domain/Activity.ts";
import type { Protocol } from "../../domain/Protocol.ts";
import { type SummRow, SummRowType } from "./csv/index.ts";
import { fee, findLeg, leg, legTrace, named } from "./common.ts";

// Reward distribution wallets known from what they do (docs/specs/sends.md): ordinary wallets, not protocol
// modules, so no source names them. Their transfers of the listed assets are income unless the config sets
// incomeFrom, which replaces this list.
export const KNOWN_DISTRIBUTORS: { address: string; assets: string[]; what: string }[] = [
  // 2,147 of its 2,150 sends are MAYA, to 868 recipients, with no memo; funded by the wallet below
  {
    address: "maya1nhwdya4kw04nqv0wqlut89hh08pyjfn2lw2tr7",
    assets: ["MAYA.MAYA"],
    what: "Maya: MAYA token distribution",
  },
  // Maya's operator treasury: its MAYA sends (3,635 of 3,860, to 2,549 recipients) are distributions; it also
  // trades and sends CACAO and other tokens, which are not assumed to be income
  {
    address: "maya18z343fsdlav47chtkyp0aawqt6sgxsh3vjy2vz",
    assets: ["MAYA.MAYA"],
    what: "Maya: treasury, MAYA distributions",
  },
];

// Whether a transfer received is income: its sender is in incomeFrom, or, when the config does not set it, a known
// distributor of that asset
export function isIncomeReceipt(from: string, asset: string, incomeFrom?: string[]): boolean {
  const sender = from.toLowerCase();

  if (incomeFrom !== undefined) {
    return incomeFrom.some((address) => address.toLowerCase() === sender);
  }

  return KNOWN_DISTRIBUTORS.some((known) => known.address === sender && known.assets.includes(asset.toUpperCase()));
}

// The run summary's lines about known distributors' transfers among the rows
export function knownDistributorReport(rows: SummRow[], incomeFrom?: string[]): { info: string[]; warnings: string[] } {
  const fromKnown = (type: string) =>
    rows.filter(
      (row) => row.type === type && KNOWN_DISTRIBUTORS.some((known) => known.address === row.from?.toLowerCase()),
    );
  const income = incomeFrom === undefined ? fromKnown(SummRowType.Income) : [];
  const receives = fromKnown(SummRowType.Receive);

  return {
    info: income.length
      ? [
          `${income.length} receipts from known distribution wallets are income (incomeFrom is not set; docs/specs/sends.md)`,
        ]
      : [],
    warnings: receives.length
      ? [
          `WARN: ${receives.length} receipts from known distribution wallets are plain receives (${[...new Set(receives.map((row) => `${row.baseCurrency} from …${row.from!.slice(-8)}`))].join(", ")}): if they are income, list the sender in incomeFrom`,
        ]
      : [],
  };
}

// A send or a receive on the wallet that listed it. A transfer received is income when isIncomeReceipt says so.
// A send to itself (e.g. an Arkeo delegation) moves nothing out of the wallet, so only its gas is exported, as a
// fee row (docs/specs/sends.md). So is a failed send's, which moved nothing.
export function sendRows(activity: Activity, protocol: Protocol, incomeFrom?: string[]): SummRow[] {
  if (activity.status === "failed") {
    return failedSendRows(activity, protocol);
  }

  const coin = leg(activity, "principal");
  const isSend = coin.direction === "out";

  if (isSend && isToItself(activity)) {
    return selfSendRows(activity, protocol);
  }

  const isIncome = !isSend && isIncomeReceipt(activity.details.from ?? "", coin.asset.notation, incomeFrom);
  const type = isSend ? SummRowType.Send : isIncome ? SummRowType.Income : SummRowType.Receive;
  const { currency, amount } = named(coin, protocol);
  const txId = coin.txid ?? "";
  const description = `${isSend ? "Send" : isIncome ? "Income: receive" : "Receive"} ${amount} ${label(coin)}; ${txId}`;

  return [
    {
      wallet: coin.wallet,
      timestamp: activity.time,
      type,
      baseCurrency: currency,
      baseAmount: amount,
      ...(isSend ? fee(activity, protocol) : {}),
      from: activity.details.from,
      to: activity.details.to,
      blockchain: protocol.blockchain,
      trace: legTrace(coin),
      description,
    },
  ];
}

function isToItself(activity: Activity): boolean {
  const { from, to } = activity.details;
  return !!from && from.toLowerCase() === to?.toLowerCase();
}

function selfSendRows(activity: Activity, protocol: Protocol): SummRow[] {
  const coin = leg(activity, "principal");
  const gas = findLeg(activity, "gas");

  if (!gas) {
    return [];
  }

  const { currency, amount } = named(gas, protocol);
  const sent = named(coin, protocol);
  const txId = coin.txid ?? "";
  const description =
    activity.details.purpose === "delegate-arkeo"
      ? `1/1 - DelegateArkeoWallet; ${txId}`
      : activity.details.failedAction
        ? `Fee: failed ${activity.details.failedAction} sent to itself; ${txId}`
        : `Fee: send ${sent.amount} ${label(coin)} to itself; ${txId}`;

  return [
    {
      wallet: gas.wallet,
      timestamp: activity.time,
      type: SummRowType.Fee,
      baseCurrency: currency,
      baseAmount: amount,
      from: activity.details.from,
      to: activity.details.to,
      blockchain: protocol.blockchain,
      trace: legTrace(gas),
      description,
    },
  ];
}

function failedSendRows(activity: Activity, protocol: Protocol): SummRow[] {
  const gas = leg(activity, "gas");
  const { currency, amount } = named(gas, protocol);

  return [
    {
      wallet: gas.wallet,
      timestamp: activity.time,
      type: SummRowType.Fee,
      baseCurrency: currency,
      baseAmount: amount,
      from: activity.details.from,
      to: activity.details.to,
      blockchain: protocol.blockchain,
      trace: legTrace(gas),
      description: `Fee: failed send; ${gas.txid ?? ""}`,
    },
  ];
}

// A failed deposit's paid native fee (docs/specs/failed.md): the shape of a failed send's row
export function failedDepositRows(activity: Activity, protocol: Protocol): SummRow[] {
  const gas = leg(activity, "gas");
  const { currency, amount } = named(gas, protocol);
  const reason = activity.details.reason ? ` (${activity.details.reason})` : "";

  return [
    {
      wallet: gas.wallet,
      timestamp: activity.time,
      type: SummRowType.Fee,
      baseCurrency: currency,
      baseAmount: amount,
      from: activity.details.from,
      to: activity.details.to,
      blockchain: protocol.blockchain,
      trace: legTrace(gas),
      description: `Fee: failed ${activity.details.failedAction}${reason}; ${gas.txid ?? ""}`,
    },
  ];
}

// A deposit that did nothing (docs/specs/sends.md, Txs Midgard omits): its native fee
export function noopDepositRows(activity: Activity, protocol: Protocol): SummRow[] {
  const gas = leg(activity, "gas");
  const { currency, amount } = named(gas, protocol);

  return [
    {
      wallet: gas.wallet,
      timestamp: activity.time,
      type: SummRowType.Fee,
      baseCurrency: currency,
      baseAmount: amount,
      from: activity.details.from,
      to: activity.details.to,
      blockchain: protocol.blockchain,
      trace: legTrace(gas),
      description: `Fee: ${activity.details.action} that did nothing${activity.memo ? ` (${activity.memo})` : ""}; ${gas.txid ?? ""}`,
    },
  ];
}

function label(coin: Leg): string {
  const ticker = assetFromStringEx(coin.asset.notation).ticker;
  return coin.asset.kind === "synth" ? `Synth ${ticker}` : coin.asset.kind === "trade" ? `Trade ${ticker}` : ticker;
}
