import { type SummRow, SummRowType } from "../export/summ/csv/index.ts";
import { formatAmount } from "../domain/Amount.ts";
import { addressKey } from "../utils/Address.ts";
import { PROTOCOLS } from "../domain/Protocol.ts";

// The balance check (docs/specs/run-summary.md, Balance check): what the exported rows say each wallet holds, against
// what the chain says it holds. Pure: the shell fetches the balances and writes the lines to summary.md.

// Amounts are summed exactly, as integers with this many decimals
export const SCALE = 18;

// A difference smaller than this (0.000001 of the asset) is not reported
export const DUST = 10n ** BigInt(SCALE - 6);

// Wallet (addressKey) → currency → amount (SCALE decimals)
export type Holdings = Map<string, Map<string, bigint>>;

// A decimal string as written in a row ('0.02', '-1', '5000') as an integer with SCALE decimals; digits beyond SCALE
// are dropped
export function parseDecimal(text: string): bigint {
  const match = text.trim().match(/^(-?)(\d*)(?:\.(\d*))?$/);

  if (!match || (!match[2] && !match[3])) {
    throw new Error(`Invalid amount: ${text}`);
  }

  const value = BigInt((match[2] || "0") + (match[3] ?? "").slice(0, SCALE).padEnd(SCALE, "0"));
  return match[1] ? -value : value;
}

export function formatDecimal(value: bigint): string {
  return formatAmount({ base: value, decimals: SCALE });
}

// A base-unit amount from a source (e.g. a bank balance) with SCALE decimals
export function fromBase(base: string, decimals: number): bigint {
  return BigInt(base) * 10n ** BigInt(SCALE - decimals);
}

// Row types that always take the base amount out of the row's wallet, or always bring it in, whatever From and To
// say: a fee row of a send to itself has From and To both the wallet, and still costs the wallet the fee
const OUTGOING: ReadonlySet<SummRowType> = new Set([
  SummRowType.Fee,
  SummRowType.Expense,
  SummRowType.Lost,
  SummRowType.Stolen,
  SummRowType.Burn,
]);
const INCOMING: ReadonlySet<SummRowType> = new Set([
  SummRowType.Income,
  SummRowType.Staking,
  SummRowType.Interest,
  SummRowType.Mining,
  SummRowType.Airdrop,
  SummRowType.Rebate,
]);

// Each wallet's net holdings by currency over every row given: what came in, less what went out and the fees.
// - A fee, expense or loss row took the base amount out of its wallet; an income or staking reward row brought it
//   in.
// - Any other row whose To is its wallet brought the base amount in; one whose From is its wallet sent it out. A
//   sell (From and To both the wallet) sent the base out and brought the quote in; a buy the other way round.
// - The fee is always paid by the row's wallet.
// - Spam rows (price helpers) move nothing. A failed-in or failed-out row moves only its fee, as in Summ.
export function computeHoldings(rows: SummRow[]): Holdings {
  const holdings: Holdings = new Map();

  for (const row of rows) {
    if (!row.wallet || row.type === SummRowType.Spam) {
      continue;
    }

    const wallet = addressKey(row.wallet);
    const held = holdings.get(wallet) ?? new Map<string, bigint>();
    holdings.set(wallet, held);
    const add = (currency: string | undefined, amount: string | undefined, sign: 1n | -1n) => {
      if (currency && amount) {
        held.set(currency, (held.get(currency) ?? 0n) + sign * parseDecimal(amount));
      }
    };
    const isWallet = (address?: string) => !!address && addressKey(address) === wallet;

    if (OUTGOING.has(row.type)) {
      add(row.baseCurrency, row.baseAmount, -1n);
    } else if (INCOMING.has(row.type)) {
      add(row.baseCurrency, row.baseAmount, 1n);
    } else if (row.type === SummRowType.Sell) {
      add(row.baseCurrency, row.baseAmount, -1n);
      add(row.quoteCurrency, row.quoteAmount, 1n);
    } else if (row.type === SummRowType.Buy) {
      add(row.baseCurrency, row.baseAmount, 1n);
      add(row.quoteCurrency, row.quoteAmount, -1n);
    } else if (row.type !== SummRowType.FailedIn && row.type !== SummRowType.FailedOut) {
      if (isWallet(row.from)) {
        add(row.baseCurrency, row.baseAmount, -1n);
      }

      if (isWallet(row.to)) {
        add(row.baseCurrency, row.baseAmount, 1n);
      }
    }

    add(row.feeCurrency, row.feeAmount, -1n);
  }

  return holdings;
}

// A pool position (LP units, a savers position, RUNEPool units, a Rujira merge share): held in the protocol, not in
// the wallet's bank balance, and every move of it is an action the protocol records
export function isPositionToken(currency: string): boolean {
  const prefixes = [
    ...Object.values(PROTOCOLS).flatMap((protocol) => [protocol.lpTokenPrefix, protocol.saversTokenPrefix]),
    "RujiraMerge",
  ];
  return prefixes.some((prefix) => currency.startsWith(`${prefix}.`));
}

export interface WalletBalances {
  address: string;
  name: string;
  // A THORChain or Maya wallet: every move of its funds is an action the protocol records, so any holding below zero
  // is flagged. For another wallet only its position tokens are: its other funds also move outside the protocol.
  native: boolean;
  // Where the on-chain balances come from, e.g. 'THORNode'
  source?: string;
  // The bank balances (SCALE decimals) by currency, when fetched
  onChain?: Map<string, bigint>;
  // Why the bank balances were not compared
  notChecked?: string;
}

export interface BalanceReport {
  lines: string[];
  checked: number;
  differences: number;
  negatives: number;
}

// For each wallet, the holdings below zero, then each currency whose bank balance differs from the rows' by more
// than dust (position tokens are not in the bank balance, so they are not compared)
export function balanceReport(holdings: Holdings, wallets: WalletBalances[]): BalanceReport {
  const report: BalanceReport = { lines: [], checked: 0, differences: 0, negatives: 0 };
  const byName = (a: string, b: string) => a.localeCompare(b);

  for (const wallet of wallets) {
    const label = `${wallet.name} (${wallet.address})`;
    const held = holdings.get(addressKey(wallet.address)) ?? new Map<string, bigint>();

    for (const currency of [...held.keys()].sort(byName)) {
      const amount = held.get(currency)!;

      if (amount <= -DUST && (wallet.native || isPositionToken(currency))) {
        report.negatives++;
        report.lines.push(
          `${label} ${currency}: rows give ${formatDecimal(amount)}, below zero (a row with the wrong sign, or a missing acquisition)`,
        );
      }
    }

    if (wallet.notChecked) {
      report.lines.push(`${label}: bank balance not checked: ${wallet.notChecked}`);
    }

    if (!wallet.onChain) {
      continue;
    }

    report.checked++;
    const onChain = wallet.onChain;
    const currencies = new Set([
      ...[...held.keys()].filter((currency) => !isPositionToken(currency)),
      ...onChain.keys(),
    ]);

    for (const currency of [...currencies].sort(byName)) {
      const rows = held.get(currency) ?? 0n;
      const balance = onChain.get(currency) ?? 0n;
      const difference = balance - rows;

      if (difference >= DUST || difference <= -DUST) {
        report.differences++;
        report.lines.push(
          `${label} ${currency}: rows give ${formatDecimal(rows)}, ${wallet.source} balance ${formatDecimal(balance)} (difference ${difference > 0n ? "+" : ""}${formatDecimal(difference)})`,
        );
      }
    }
  }

  return report;
}
