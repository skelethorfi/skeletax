# summ-sync

Keeps [Summ](https://summ.com) matching a set of Summ CSV files, like
Terraform: pull Summ's state, plan the differences, apply them, pull again.
The design is `docs/specs/summ-sync.md` in this repo.

It is a separate package: it reads files (Summ CSVs with stable `ID`s and a
`row-ids.csv`), not the exporter's code, and needs no runtime dependencies.
It is TypeScript that Node 24 runs directly (type stripping, so only
erasable syntax: no enums or namespaces); `tsc` from the repo root checks it. It talks to Summ only through Summ's MCP server
(`https://mcp.summ.com/mcp`), with your own login.

Status: experimental. `login`, `pull`, `plan` and `apply` work; review every
plan before you apply it.

## A year's sync

1. Export the year with the exporter (a run dir with `csv/`).
2. `login <state dir> --write` once (the token is refreshed after that).
3. `pull <state dir> <run dir>`, then `plan <state dir> <run dir>`. Read `plan.md`.
4. `apply <state dir> <plan dir>` (`--dry-run` first; `--approve-deletes` if the
   plan deletes). It deletes and edits, and holds back categorisation while the
   plan has uploads.
5. Upload the files in `<plan dir>/upload/` to Summ, under the account named
   in `managedSources`. They hold only the rows Summ lacks.
6. `pull`, `plan`, `apply` again: it categorises Summ's own legs, now that
   Summ can pair them with the uploaded rows, and ignores the receives Summ
   made up to pair a send as a transfer.
7. `pull` and `plan`: what is left is under Report, for you to resolve.

Filed years go in a separate apply with `--approve-filed`.

## Usage

    node packages/summ-sync/bin/summ-sync.ts login <state dir> [--write]
    node packages/summ-sync/bin/summ-sync.ts pull  <state dir> [<run dir>] [--full]
    node packages/summ-sync/bin/summ-sync.ts plan  <state dir> <run dir> [--only <scope file>]
    node packages/summ-sync/bin/summ-sync.ts apply <state dir> <plan dir> [--dry-run] [--approve-deletes] [--approve-filed]
    node packages/summ-sync/bin/summ-sync.ts prune <state dir> [--older-than <days>]
    node packages/summ-sync/bin/summ-sync.ts tools <state dir>

- `login` opens the browser to authorise this tool (scope `mcp:read`, or
  `mcp:read mcp:write` with `--write`) and keeps the token in
  `<state dir>/.auth.json` (mode 600).
- `pull` writes `<state dir>/snapshots/<timestamp>.json`: the counts and
  one entry per listed action (id, tx hash, category, tags). The full JSON
  and change history of each action of a managed source goes to the action
  store, `<state dir>/actions/<action id>.json`. Given a run dir, it also
  stores the detail of each action whose tx hash is a txid of the run's
  categorised rows (chains not in `managedChains`). Summ gives an action a
  new id whenever it changes, so an id is fetched once and only ids the
  store lacks are fetched; `--full` fetches them all again (e.g. before
  filing a year) and warns about any stored id whose legs or history
  differ.
- `plan` compares the run's period wallet files with the latest snapshot
  and writes `<state dir>/plans/<timestamp>/`: `plan.json`, `plan.md` and
  `upload/` (the rows Summ lacks, per file). It calls nothing and changes
  nothing in the state dir. `plan.json` lists the legs it adopted (old
  `<file>:<n>` IDs) and the values you changed in Summ that it captured;
  `apply` adds them to `adopted.csv` and `overrides.json`, where overrides
  win over the run while `retainUserEdit` is `undecided` (listed on every
  plan) or `yes`; set it to `no` to have the plan set the run's value back.
  With `--only <scope file>`, the plan covers only the rows the file's
  entries match, one per line (a `#` at the start or after a space starts
  a comment): a row ID, a txid (any 64 hex digits), or any other text
  found in the row's CSV line (e.g. `ThorSavers.` or a wallet address);
  legs with no row match by their ID in Summ, a txid or the text in their
  description, or a txid of a row in scope; legs that also name the tx of
  a row outside the scope that the plan uploads are left, and the scope's
  rows and other legs with no row of that tx wait with them (unless an
  entry is their ID in Summ). Everything else, including a decision on a row outside
  the scope, waits for another plan, and so does a categorisation whose
  event has an upload the plan does not carry; `plan.md` notes each, and each
  entry that matches nothing. Use it to apply one stage at a time.
- `apply` carries out a plan made from the latest snapshot: deletes (only
  with `--approve-deletes`), then edits and categorisation, each checked
  against Summ's current value first (categorisation waits while the plan
  has uploads); then it adds the plan's adoptions and captured overrides
  to `adopted.csv` and `overrides.json` and lists the upload files. It
  applies the current years' entries, or with `--approve-filed` only the
  filed years'. `--dry-run` does the look-ups and checks with read tools
  only and writes nothing. Every write goes to `<state dir>/apply-log.jsonl`
  with its undo handle (`undo_edit`; deletes have none). Before a delete,
  it saves each action as it inspected it (full JSON and change history) to
  the action store, `<state dir>/actions/<action id>.json`. Summ cannot undo a delete
  and the MCP cannot recreate an uploaded row, so to bring a row back,
  upload its CSV line again (from the run that wrote it); the saved file
  shows what Summ held. It needs `login --write`. Afterwards, upload the
  files, then pull and plan again.
- `prune` removes the snapshots older than `--older-than` days (default
  30; never the latest) and the stored actions no remaining snapshot lists
  (except those apply saved before a delete), once they are committed (keep the state dir in git; git keeps the removed files). If
  any is not committed, it removes nothing and lists them.
- `tools` lists the server's tools.

Each command may call only the tools it needs; `login` and `pull` use read
tools only, `plan` none, `apply` also `edit_transaction` and
`bulk_edit_transactions`. Requests are spaced 400 ms apart.

## State dir

Your private folder, never a public repo: it holds your token and a copy of
your transactions. Settings are in `<state dir>/summ-sync.json`, all
optional:

```json
{
  "managedChains": ["THOR", "MAYA"],
  "managedSources": ["thorchain"],
  "filedBefore": "2024-01-01",
  "timezone": "Europe/London",
  "extraDirs": ["../manual"]
}
```

- `managedChains`: chains whose CSV files you upload; the sync manages
  their rows. Rows of other chains only correct Summ's own import of those
  wallets. Choose per chain by which gives the better rows, never both for
  one wallet (its rows would count twice).
- `managedSources`: Summ's source names of the uploaded rows (see
  `get_filter_options`); `pull` saves full detail for their actions.
- `filedBefore`: rows before this date are in filed years; changing them is
  an amendment.
- `timezone`: your Summ account's timezone (default `UTC`), for the days of
  the run's periods and of `filedBefore`.
- `extraDirs`: folders (relative to the state dir, searched recursively) of
  CSV files you made by hand in the run's file shape, e.g. rows the exporter
  cannot produce. A file counts only when its period is one of the run's, and
  its rows are managed like the run's (without it, plan deletes them). An
  extra row the run now exports itself (same txids, type, currency, amount,
  second and wallet) is left out, and its legs in Summ adopt to the run's
  row; one that shares a txid, side and currency but differs is reported,
  and neither is uploaded.
- `keepExtra`: IDs of extra rows that are right beside the run rows they
  overlap: not reported, and uploaded as usual.
- `hold`: rows to leave alone while a decision outside the sync is pending,
  as `{"id": "<row ID>", "reason": "<why>"}`, or every row naming a txid as
  `{"txid": "<txid>", "reason": "<why>"}`. Plan plans nothing for them
  (no delete, edit, upload or categorise) and lists them, with what it left
  out, under Held. A held ID with no row in the run's periods, or a held
  txid no row names, is noted.

## Tests

    cd packages/summ-sync && npm run typecheck && npm test
