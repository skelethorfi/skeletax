# ThorFi collapse and TCY claims

ThorFi was THORChain's savers and lending. In January 2025 both were
suspended: Savers were deprecated on 4 January 2025, and later that month the
nodes paused lending and savers withdrawals because the protocol could not
cover what it owed. What it owed, in savers positions, loan collateral and
some other assets, was converted to a new token, TCY: one TCY per
dollar owed. Owners claim their TCY on chain. This spec covers what the
source data shows of that, and how each part is exported. The positions
themselves are in `savers.md` and `loans.md`; TCY staking and its
distributions in `activity.md`.

## What happened on chain

- **Positions were frozen, not closed.** A savers position is still on
  THORNode after the collapse (`/thorchain/pool/<asset>/saver/<address>`:
  units, deposit and redeem value, with no withdrawal). Users cannot
  withdraw it: the `BurnSynths` Mimir is set, and a savers withdraw fails
  while it is ("burning synths is disabled, unable to withdraw to savers",
  THORNode's withdraw handler).
  THORNode's lending endpoints (`/borrower/`) are no longer served.
- **The claim list.** THORNode embeds a fixed list of claims
  (`common/tcyclaimlist/tcy_claimers_mainnet.json`): `{asset, address,
tcy_claim}`, with the amount in TCY (8 decimals). Some address and asset
  pairs appear in it more than once; THORNode adds them up when it loads
  the list, so its state holds one entry per address and asset, not per
  position: one address with a savers position and a loan in the same asset
  has one entry for both. (The file's repeated rows may be such a split;
  not checked.)
- **A claim** is a deposit with the memo `tcy:<thor address>`, sent from the
  address that holds the claim: an L1 address (a dust send on its chain),
  or a THORChain address for a claim it holds (e.g. a synth holder's).
  THORNode pays every entry of that address at once, one `tcy_claim` event
  per asset (with the asset and amount), and deletes the entries. The TCY
  goes straight from the claiming module to the staking module, staked for
  the THORChain address in the memo: the claimed TCY never sits in the
  wallet unstaked (the staker's amount rises by the claim at its height,
  and the wallet's TCY balance does not change).
- **Midgard** lists one `tcy_claim` action per event, so a claim tx that
  paid several entries is several actions with the same txid: in, the
  claiming address; out, the THORChain address and that entry's TCY. Its
  database keeps each event's asset (`tcy_claim_events.asset`), but the
  action shows only the memo. The asset comes from THORNode:
  `/thorchain/tcy_claimer/<address>` at the height before the claim lists
  the entries (asset and amount), and an action's TCY equals one of them;
  from the claim's height on, the address has none.

## Rows

| Event                                       | Rows                                                                                                                                                                                                                                                                                                                                      | Status                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Freeze of a position (January 2025)         | none: nothing moved, and the position is still held                                                                                                                                                                                                                                                                                       | –                                           |
| TCY claim for a savers position             | a disposal of the position for the TCY, at the claim tx: `ReturnLpToken` of the position's units (`ThorSavers.<chain>.<asset>`, in the wallet that holds it), the `Spam` price helper of the TCY (its value for the token, as for any withdrawal, `liquidity.md`), and `RemoveLiquidity` of the TCY in the THORChain wallet (`savers.md`) | exported                                    |
| TCY claim for a loan's collateral           | the end of the loan: collateral never returned, debt never repaid, TCY for the net of the two (`loans.md`)                                                                                                                                                                                                                                | planned (today a `Receive`, with a warning) |
| TCY claim for anything else (e.g. a synth)  | `Receive` of the TCY                                                                                                                                                                                                                                                                                                                      | exported                                    |
| The TCY staked at the claim                 | `StakingDeposit` of the TCY, in the THORChain wallet, after every claim's rows, so a later unstake (`StakingWithdrawal`) returns TCY that was deposited                                                                                                                                                                                   | exported                                    |
| Distributions to staked TCY, stake, unstake | `activity.md`                                                                                                                                                                                                                                                                                                                             | exported                                    |

Why a claim is a disposal and not income: the TCY is what the protocol gave
for a position it could no longer pay out. The position (or the collateral)
is given up for it; the TCY's market value at the claim is the proceeds, and
the cost of the position carries to that disposal. The claim tx is the
observed event; the freeze moved nothing.

**Loans.** A borrower could claim TCY equal to the collateral's value less
the loan's debt. Nothing on chain settled the debt or released the
collateral: the claim handler touches no loan, the migration that loaded the
claim list changed none, and no later change closed them (THORNode reported
them as open until its lending code was removed, November 2025). In
substance the loan ended at the claim: the collateral is never returned, the
debt is never repaid, and the TCY is the net of the two. How to record that
(e.g. a disposal of the collateral whose proceeds include the debt no longer
owed) is decided when loan claims are exported; until then a loan's claim is
a `Receive` and its debt stays open in the export.

The exporter stores this per claim (`tcy-claim`, `snapshots.md`), so an
`--offline` run over a period with a claim needs one run online first.

**Which kind of claim.** For each action, the exporter finds the entry it
paid (THORNode's `tcy_claimer` at the height before the claim, by amount)
and checks the claiming address at that height: a savers record of the
entry's asset with units means a savers claim (its units are the position
returned). A loan opened from that address with that asset as collateral
(`loans.md`) means a loan claim. Both at once share one entry: the claim is
exported as a `Receive` with a warning, since the source does not say how
much was for each.

## Golden cases

`tcy/claim` (a claim for something other than savers or a loan: `Receive`
and `StakingDeposit`) and `tcy/claim-savers` (a DOGE savers position given up
for TCY).
