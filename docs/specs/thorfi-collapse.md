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
  action shows only the memo. The asset comes from the claim list: an
  action's TCY equals one of the claiming address's entries (THORNode's
  `/thorchain/tcy_claimer/<address>` lists them only before the claim, and
  the public gateway serves no past heights).

## Rows

| Event                                       | Rows                                                                                                                                                                                                                                                                                                                                      | Status                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Freeze of a position (January 2025)         | none: nothing moved, and the position is still held                                                                                                                                                                                                                                                                                       | –                                           |
| TCY claim for a savers position             | a disposal of the position for the TCY, at the claim tx: `ReturnLpToken` of the position's units (`ThorSavers.<chain>.<asset>`, in the wallet that holds it), the `Spam` price helper of the TCY (its value for the token, as for any withdrawal, `liquidity.md`), and `RemoveLiquidity` of the TCY in the THORChain wallet (`savers.md`) | exported                                    |
| TCY claim for a loan's collateral           | the end of the loan: collateral never returned, debt never repaid, TCY for the net of the two (`loans.md`)                                                                                                                                                                                                                                | planned (today a `Receive`, with a warning) |
| TCY claim for a synth the address held      | a trade of the synth for the TCY, at the claim tx: `BridgeTradeOut` of the whole holding (`ThorSynth.<chain>.<asset>`, quote the TCY) and `BridgeTradeIn` of the TCY, in the THORChain wallet                                                                                                                                             | exported                                    |
| TCY claim for anything else                 | `Receive` of the TCY                                                                                                                                                                                                                                                                                                                      | exported                                    |
| The TCY staked at the claim                 | `StakingDeposit` of the TCY, in the THORChain wallet, after every claim's rows, so a later unstake (`StakingWithdrawal`) returns TCY that was deposited                                                                                                                                                                                   | exported                                    |
| Distributions to staked TCY, stake, unstake | `activity.md`                                                                                                                                                                                                                                                                                                                             | exported                                    |

**Synths.** A synth held in a wallet was frozen too: with `BurnSynths` set it
could not be swapped back, and the claim list holds an entry for it in its
asset (`eth.vthor` for synth `ETH/VTHOR`), paid to the THORChain address that
held it. The synth stays in the wallet after the claim, worth nothing, until a
later THORNode upgrade burns it (v3.20.0's ADR-028 writedown burned the whole
synth supply of some pools); that burn gives no row, since the holding was
given up at the claim. The claim covers the whole holding: in the public vTHOR
claims checked (five holders), the TCY paid per synth unit is the same ratio.
The synth given up is valued at that TCY (`prices.md`), not at its pool's
price.

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

**Which kind of claim.** For each action, the exporter finds the entry it
paid in the claim list (THORNode's file at the commit that added it, checked
by its hash; repeated rows of an address and asset summed, as THORNode does),
by amount. A savers position of the claiming address in the entry's asset
makes it a savers claim: Midgard's `/v2/saver/<address>`, whose units are
the sum of the position's adds and withdraws, so the units returned are the
position tokens the deposits gave (THORNode's own savers records were changed
by later migrations, which Midgard does not follow). A loan from that address
with that asset as collateral, not withdrawn (Midgard's
`/v2/borrower/<address>`, `loans.md`), makes it a loan claim. No savers or
loan event followed the collapse, so both are the positions at the claim.
Both at once share one entry: the claim is exported as a `Receive` with a
warning, since the source does not say how much was for each. With neither,
a synth of the entry's asset that the claiming THORChain address held in the
block before the claim (Midgard's `/v2/balance/<address>?height=`, which lists
synths) makes it a synth claim, for the whole holding. (A THORChain
address's entry can also combine synths it held with a synth savers position
in the same asset; the sources do not show that split, and such a claim is
exported as a savers claim.)

**Several entries in one tx.** The actions of one claim tx share a txid, so
each is stored under a key with its TCY amount (`tcy_claim.<txid>.<amount>`).
Entries of equal amount give actions nothing tells apart (an action has no
asset): they are stored once, and that action receives the TCY of all of them,
as a `Receive` with a warning, since which asset each was for is not known. An
action is otherwise matched to its entry by amount. A claim sent from the THORChain
wallet itself paid the native fee once for the tx: the fee goes on the action
whose entry's asset sorts first (entries of amount 0 pay nothing and have no
action). That action keeps the key without its amount for its row IDs, so a
single-entry claim's rows keep the IDs they had; without the claim list's
entries every action is treated as that one, as before, and with several
entries an action that matches none of them is not.

**Not handled.** A synth savers position and a held synth of one asset share
one entry; the claim is exported as a savers claim and the held synth stays.
Synths with no entry of their own, synths sent away before the claim, and
synths received after it stay held in the export.

The exporter stores this per claim (`tcy-claim`, and a THORChain address's
synths as `tcy-claim-synths`, `snapshots.md`), so an
`--offline` run over a period with a claim needs one run online first; a
replay of a run made before it existed gets nothing, and the claim is a
`Receive`.

## Golden cases

`tcy/claim` (a claim for something other than savers or a loan: `Receive`
and `StakingDeposit`), `tcy/claim-savers` (a DOGE savers position given up
for TCY) and `tcy/claim-synth` (synth vTHOR given up for TCY, valued at the TCY).
