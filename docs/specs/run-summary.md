# Run summary

Each run writes `summary.md` to its folder, next to `csv/`, `snapshots.json`,
`unsupported/`, `failures/` and `unmapped.json`. It keeps what the run printed that is worth
reading later, so a run (and a filed year) still shows what was flagged
after the terminal is gone. The run prints the same lines as before.

| Section             | What                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                 | the config, start time, period and timezone, protocols, and the mode (fetch, refetch all, offline, or the run replayed) with the store                                                                                |
| Not fetched         | each wallet the run skipped because a source failed for it: its name, address, the source and the error (below)                                                                                                       |
| Counts              | actions that are not final, by age; actions skipped (listed for an earlier wallet; sends that are another action's inbound), rows exported, rows outside the periods (in `all.csv` only), the snapshot summary and the records found changed or missing             |
| Warnings            | warnings about the whole run: config keys no longer used, an old cache, wallets missing from the config, and the end-of-run warnings (e.g. sends with an action memo, or what Viewblock could not give, `sends.md`)   |
| Balance check       | each holding below zero, each bank balance that differs from the rows, and each wallet whose balance could not be read (below)                                                                                        |
| Enter by hand       | actions to enter by hand, with their message                                                                                                                                                                          |
| Action warnings     | warnings on one action                                                                                                                                                                                                |
| Not final           | every Midgard action whose status is not `success`, oldest first: its status, age, whether it is recent, waiting or stuck, and whether it was exported, what covers it, or which send stands in for it (`pending.md`) |
| Unsupported actions | actions with no mapper; each is saved in `unsupported/`                                                                                                                                                               |
| Failed actions      | actions whose mapper failed, with the error; each is saved in `failures/`                                                                                                                                             |

`unmapped.json` is the same unsupported and failed actions, plus each
bundle that gave no rows with only a warning (e.g. a withdrawal whose
pending add is not found), for summ-sync to
read: `{ "version": 1, "records": [...] }`, each record with its `kind`
(`unsupported`, `failed` or `warning`), store record key (`record`), `wallet`, `time`
(the action's, as a row ID starts), `times` (every time a row ID made of
it can start with: the action's, then each attached inbound's, e.g. a Maya
liquidity auction's deposits, dated by their THORChain send, and a withdrawn
pending add's, whose rows carry the add's time), `txids`
(every 64-hex string anywhere in the bundle, in lower
case), and its message (`reason`). It is written on every
run, empty when nothing failed, so summ-sync can tell such a run from one
made before the file (`summ-sync.md`, Held).

Each line about one action ends with its store record key (e.g.
`midgard/swap.<txid>`), which says which action it was. A section with
nothing in it is left out; the issue and warning sections give their count.

## Not fetched

The run fetches wallet by wallet, each from its sources in turn (Viewblock,
THORChain Midgard, other protocols' Midgards, TCY distributions, CACAO payouts
to MAYA holders). When a source throws for a wallet, after the source's own
retries (e.g. a Midgard page retried on its own), that wallet is skipped
whole and the run goes on with the next one:

- its bundles from every source are dropped, and its actions are not listed
  under Not final, so it gives no row and no CSV file. A row of another
  wallet's action whose wallet is the skipped one is dropped too (Counts says
  how many). A wallet file never misses one source's rows while looking
  complete;
- the line `<name> (<address>): <source>: <error>` goes under Not fetched,
  where the source is `viewblock`, `midgard`, `<protocol>-midgard`, `tcy` or
  `maya-distribution`. The stack is printed for an unexpected error, not for
  a record missing from the store;
- the run writes `not-fetched.json` to its folder, before the CSV files:
  `{ "version": 1, "wallets": [{ "name", "address", "source", "error" }] }`.
  summ-sync's `plan` and `pull` refuse a run folder that has it
  (`summ-sync.md`, Inputs): the skipped wallet has no file, so a plan would
  delete its rows in Summ. A run that fetched every wallet does not write it;
- the run writes everything else as usual and exits 1, naming the skipped
  wallets.

A price fetch, which runs after every wallet's bundles are listed, still stops
the run. An error before fetching (a bad argument or config, a replayed run
that cannot be read) and a record missing from the store print `Error:` and
the message, without a stack, and exit 1.

## Balance check

The biggest risk in a tax export is a missing or wrong row. After the CSV
files are written, the run adds up what its rows say each wallet holds and
compares it with what the chain says (`src/pipeline/balances.ts`). A row it
cannot read (an amount that is no decimal) skips the check with a warning.

What the rows say, for each wallet and currency, over every row of the run
(`all.csv`, inside and outside its periods):

- A `fee`, `expense`, `lost`, `stolen` or `burn` row took the base amount out
  of its wallet, and an `income`, `staking`, `interest`, `mining`, `airdrop`
  or `rebate` row brought it in, whatever its From and To (the fee row of a
  send to itself has both the wallet).
- Any other row whose To is its wallet brought the base amount in; one whose
  From is its wallet sent it out. A sell (From and To both the wallet, a FIN swap)
  sent the base out and brought the quote in.
- The fee is paid by the row's wallet.
- Spam rows (price helpers) move nothing. A `failed-in` or `failed-out` row
  moves only its fee, as in Summ.

What it reports, each finding only when it is 0.000001 or more of the asset:

| Finding                                | For                                                                                                                                                                  | Likely cause                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a holding below zero                   | every currency of a THORChain (`thor1`) or Maya (`maya1`) wallet; position tokens (`ThorLP.`, `ThorSavers.`, `MayaLP.`, `MayaSavers.`, `RujiraMerge.`) of any wallet | a row exported with the wrong sign, or a missing acquisition                                                                                                                                       |
| the bank balance differs from the rows | each `thor1` wallet (THORNode, when `thorchain` is among the protocols) and `maya1` wallet (Mayanode, when `maya` is), every currency but position tokens            | a missing or wrong row; or activity the export does not cover: rows not supported yet (README), unsupported or failed actions, sends before April 2022 when the period starts later, IBC transfers |
| bank balance not checked               | a `thor1` or `maya1` wallet whose balance could not be read                                                                                                          | offline with no balance stored, a replayed run that read none, or a failed fetch                                                                                                                   |

An L1 wallet (BTC, ETH, ...) also moves funds outside THORChain, which no row
shows, so its L1 holdings are not flagged below zero and have no balance to
compare; only its position tokens are checked.

The difference is the bank balance minus what the rows give, e.g.
`main (thor1…) RUNE: rows give 100, THORNode balance 98.5 (difference -1.5)`.
A position token is not compared with the bank balance: LP units, savers
positions, RUNEPool units and merge shares are held by the protocol, not in
the wallet. A position added from one wallet and withdrawn from another (a
symmetric add from the L1 address, withdrawn from the THORChain one) leaves
the first above zero and the second below. A trade account holding is named
like its L1 asset (`assets.md`) but is not in the bank balance either: the
rows' total of it is kept as `<currency> (trade account)`, apart from a
secured asset of the same name, checked for going below zero and not
compared.

The balance is read after the wallet's Midgard list, and Midgard can lag
THORNode by a few blocks: activity in between gives a one-off difference.
With `--offline` the stored balance may come from another fetch than the
stored lists. A changed balance is not listed among the records the run
found changed.

The bank balance is `/cosmos/bank/v1beta1/balances/<address>` now, each denom
named as the rows name its asset (`assets.md`): `rune` is `RUNE`, `btc/btc`
`ThorSynth.BTC.BTC`, `btc-btc` `BTC` (or `ThorSecured.BTC.BTC`), `x/ruji`
`RUJI`, `x/staking-x/ruji` `SRUJI`. A denom that is no asset Midgard names
keeps its denom: an IBC denom (`ibc/<hash>`), and a receipt token
(`x/…-rcpt`) other than the liquid staking ones above, so two receipt tokens
are never added together. Amounts have 8 decimals, CACAO 10 and MAYA 4.
It is stored like any record (`snapshots.md`, sources `thornode-balance` and
`mayanode-balance`, keyed by the address): every run that fetches asks again,
and stores a new copy only when the balance changed. `--offline` compares with the
latest stored balance; `--replay` with the one the replayed run read. The
Counts section says how many wallets were compared and what was found.

A wallet the run skipped (Not fetched) has no rows and is not checked.

Not checked yet: LP, savers and RUNEPool positions against Midgard's member
endpoints, trade account balances (THORNode's trade account endpoint), and L1
balances.
