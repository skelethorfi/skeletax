# Loans (THORChain lending)

## Summary

Loan opens and repayments are Midgard `swap` actions with `txType` `loanOpen`
or `loanRepayment`. The exporter normally skips actions that are not
`success`. Two exceptions apply:

- **Loan repayments** that are `pending`: Midgard keeps a repayment pending
  until the loan is closed, but the repayment itself happened.
- **Loan opens with an output** that are `pending`: an output means the loan
  was paid out. In practice these are loans that borrowed RUNE, which Midgard
  reports as pending although they were paid (see below).

Pending loan opens with no output are skipped.

A loan's collateral, payout, repayment and returned collateral are each one
coin; a tx with none, or with several, fails the action (`activity.md`, One
coin per tx).

## Why a pending loan open with an output counts as success

Midgard adds an output when it records the payout. For loans paid out on
another chain, that is also when the action becomes `success`, so no such loan
is pending with an output. RUNE payouts are recorded without a txid, and those
actions stay `pending` although the output (the payout) is there. The rule is
therefore "an output means it was paid", not "RUNE is special"; the evidence:

Checked on 2026-10-01 against 3,000 public loan opens from Midgard (via
Liquify), January to September 2024, while lending was operating normally:

| Status      | Borrowed         | Outbound txid    | Count   |
| ----------- | ---------------- | ---------------- | ------- |
| success     | non-RUNE asset   | yes              | 2,657   |
| **pending** | **RUNE**         | **no**           | **325** |
| success     | RUNE             | yes (15), no (1) | 16      |
| pending     | nothing recorded | no               | 2       |

- `pending` tracks **RUNE payouts**, not failed loans. RUNE is paid out natively
  on THORChain, and Midgard records that payout without a txid, so it never
  marks those loan opens complete. Loans of any other asset are never pending,
  so every pending loan open with an output borrowed RUNE.
- **The loans were paid.** THORNode has pruned these transactions (even the
  successful ones), so payouts were checked with Midgard's borrower records
  (`/v2/borrower/<address>`): all 26 pending RUNE loan opens whose borrower has
  only that one loan have debt issued against it. None have zero.
- **Statuses change after the fact.** At least one RUNE loan open was reported
  as `success` in September 2024 and has been `pending` in every snapshot since
  December 2024. Exports made at different times can disagree unless pending
  RUNE loan opens are included.

### Edge case: pending with no output

Of the 2 pending loan opens with no output recorded, the one that can be
checked (a single-loan borrower) also has debt issued, so Midgard sometimes
omits the payout entirely. These are still skipped: without an output there is
no amount to export, and a borrower's debt is a per-address total, which can't
be attributed to one loan when the borrower has several.

## Rows

| Action         | Rows                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Loan open      | `CollateralDeposit` (collateral sent in, with the inbound fee) and `Loan` (amount borrowed, no fee)               |
| Loan repayment | `LoanRepayment` (amount sent in, with the inbound fee) and, when the loan closes, `CollateralWithdrawal` (no fee) |

Fees follow `fees.md`.

## The collateral paid back

The repayment memo (`loan-:<collateral asset>:<destination>:…`) names the
collateral asset and the address it is paid back to. A memo with no
destination fails the action with an error that says so.

The collateral paid back is every output to the memo's destination (in any
case) in the collateral asset, however many outputs the action has:

- **None**: the loan is not closed (`No closure`); only the `LoanRepayment`
  row.
- **One or more**: the loan is closed. A large outbound is split into several
  outputs, each with its own txid; they are one `CollateralWithdrawal` row,
  their total, whose description names each payout txid (`fees.md`).

Any other output (another address, or another asset) is not exported, and
raises a warning naming its amount, asset and address, so it can be entered by
hand. An output to the destination with several coins fails the action (One
coin per tx, above).

Checked on 2026-11-02 against 150 public loan repayments from Midgard (via
Liquify), the latest listed: 89 with no output, 60 with one (the collateral),
and 1 with two, both ETH to the destination, together the collateral withdrawn
(`3DE14894…`, the golden case `loan/repay-eth-loan-with-usdc-closed-split-outbound`:
the borrower record shows 3,496.12 ETH collateral withdrawn; the two outputs
add up to the swap's 3,444.45 ETH out less the two outbound fees).

## Loans open at the ThorFi collapse

Lending was suspended in January 2025. A loan still open then was never
repaid or closed on chain. Its owner could claim TCY equal to the
collateral's value less the debt, one TCY per dollar; the claim ends the loan
in substance (`thorfi-collapse.md`). Not exported yet: the claim is a
`Receive` and the debt stays open.
