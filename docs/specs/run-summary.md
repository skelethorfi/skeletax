# Run summary

Each run writes `summary.md` to its folder, next to `csv/`, `snapshots.json`,
`unsupported/`, `failures/` and `unmapped.json`. It keeps what the run printed that is worth
reading later, so a run (and a filed year) still shows what was flagged
after the terminal is gone. The run prints the same lines as before.

| Section             | What                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                 | the config, start time, period and timezone, protocols, and the mode (fetch, refetch all, offline, or the run replayed) with the store                                                                                |
| Counts              | actions that are not final, by age; actions skipped (listed for an earlier wallet; sends that are another action's inbound), rows exported, the snapshot summary and the records found changed or missing             |
| Warnings            | warnings about the whole run: config keys no longer used, an old cache, wallets missing from the config, and the end-of-run warnings (e.g. sends with an action memo, `sends.md`)                                     |
| Enter by hand       | actions to enter by hand, with their message                                                                                                                                                                          |
| Action warnings     | warnings on one action                                                                                                                                                                                                |
| Not final           | every Midgard action whose status is not `success`, oldest first: its status, age, whether it is recent, waiting or stuck, and whether it was exported, what covers it, or which send stands in for it (`pending.md`) |
| Unsupported actions | actions with no mapper; each is saved in `unsupported/`                                                                                                                                                               |
| Failed actions      | actions whose mapper failed, with the error; each is saved in `failures/`                                                                                                                                             |

`unmapped.json` is the same unsupported and failed actions, for summ-sync to
read: `{ "version": 1, "records": [...] }`, each record with its `kind`
(`unsupported` or `failed`), store record key (`record`), `wallet`, `time`
(the action's, as a row ID starts) and `txids` (every 64-hex string in the
action, in lower case), and its message (`reason`). It is written on every
run, empty when nothing failed, so summ-sync can tell such a run from one
made before the file (`summ-sync.md`, Held).

Each line about one action ends with its store record key (e.g.
`midgard/swap.<txid>`), which says which action it was. A section with
nothing in it is left out; the issue and warning sections give their count.
