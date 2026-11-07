# Run summary

Each run writes `summary.md` to its folder, next to `csv/`, `snapshots.json`,
`unsupported/`, `failures/` and `unmapped.json`. It keeps what the run printed that is worth
reading later, so a run (and a filed year) still shows what was flagged
after the terminal is gone. The run prints the same lines as before.

| Section             | What                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                 | the config, start time, period and timezone, protocols, and the mode (fetch, refetch all, offline, or the run replayed) with the store                                                                                |
| Not fetched         | each wallet the run skipped because a source failed for it: its name, address, the source and the error (below)                                                                                                       |
| Counts              | actions that are not final, by age; actions skipped (listed for an earlier wallet; sends that are another action's inbound), rows exported, the snapshot summary and the records found changed or missing             |
| Warnings            | warnings about the whole run: config keys no longer used, an old cache, wallets missing from the config, and the end-of-run warnings (e.g. sends with an action memo, or what Viewblock could not give, `sends.md`)   |
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
