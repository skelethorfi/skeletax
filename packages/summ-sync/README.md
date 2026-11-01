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
   Its Decisions section comes first: what the deletes leave behind, with the options.
   Applying does not wait for them, so choose first with `decide`, and plan again.
4. `apply <state dir> <plan dir>` (`--dry-run` first; `--approve-deletes` if the
   plan deletes). It deletes and edits, and holds back categorisation while the
   plan has uploads. Read what each delete removes and leaves in `plan.md`.
5. Upload the files in `<plan dir>/upload/` to Summ, under the account named
   in `managedSources`, once apply lists them. They hold only the rows Summ lacks.
6. `pull`, `plan`, `apply` again: it categorises Summ's own legs, now that
   Summ can pair them with the uploaded rows, and ignores the receives Summ
   made up to pair a send as a transfer.
7. Recalculate in Summ. Summ may pause its automatic calculation after
   uploads and edits (its calculation then needs a refresh), and
   until it runs, gains, cost bases and reports show the old figures.
8. `pull` and `plan`: what is left is under Report, for you to resolve.

Filed years go in a separate apply with `--approve-filed`. A change there also moves
the cost bases of later disposals, in later years and the current one.

## Usage

    node packages/summ-sync/bin/summ-sync.ts login <state dir> [--write]
    node packages/summ-sync/bin/summ-sync.ts pull  <state dir> [<run dir>] [--all]
    node packages/summ-sync/bin/summ-sync.ts plan  <state dir> <run dir> [--only <scope file>]
    node packages/summ-sync/bin/summ-sync.ts decide <state dir> <plan dir> <d1:a> [<d2:b> ...]
    node packages/summ-sync/bin/summ-sync.ts apply <state dir> <plan dir> [--dry-run] [--approve-deletes] [--approve-filed]
    node packages/summ-sync/bin/summ-sync.ts prune <state dir> [--older-than <days>]
    node packages/summ-sync/bin/summ-sync.ts tools <state dir>

- `decide` adds a plan's decision options to `summ-sync.json`, all or none, and writes nothing to Summ. It refuses a plan
  that is not from the latest snapshot, or one Summ was written to since. Plan again after it.
- `login` opens the browser to authorise this tool (scope `mcp:read`, or
  `mcp:read mcp:write` with `--write`) and keeps the token in
  `<state dir>/.auth.json` (mode 600).
- `pull` writes `<state dir>/snapshots/<timestamp>.json`: the counts and
  one entry per listed action (id, tx hash, category, tags). The full JSON
  and change history of each action of a managed source goes to
  `<state dir>/snapshots/<time>.details.jsonl` as it is read. Given a run dir,
  it also reads each action whose tx hash is a txid of the run's categorised
  rows (chains not in `managedChains`), and covers only the run's periods;
  `--all` covers the whole history, which a plan needs for uploads, deletes,
  categorising (beyond an import leg's price alone) or filed years. `plan` needs a pull made with its run.
  Every pull reads every detail, because an action can change and keep its
  id: minutes for a year, half an hour for everything. A stopped pull goes on
  from where it stopped when run again. Its snapshot is written only once
  Summ's list has stopped changing.
- `plan` compares the run's period wallet files with the latest snapshot
  and writes `<state dir>/plans/<timestamp>/`: `plan.json`, `plan.md` and
  `upload/` (the rows Summ lacks, per file). It calls nothing and changes
  nothing in the state dir. `plan.json` lists the legs it adopted (old
  `<file>:<n>` IDs) and the values you changed in Summ that it captured;
  `apply` adds them to `adopted.csv` and `overrides.json`, where overrides
  win over the run while `retainUserEdit` is `undecided` (listed on every
  plan) or `yes`; set it to `no` to have the plan set the run's value back.
  A manual entry holds its event until you resolve it in Summ, or name it in `deleteManualEntries` in
  `summ-sync.json` (leg, currency, quantity, reason) to have the plan delete it, which Summ cannot undo.
  With `--only <scope file>`, the plan covers only the rows the file's
  entries match, one per line (a `#` at the start or after a space starts
  a comment): a row ID, a txid (any 64 hex digits), or any other text
  found in the row's CSV line (e.g. `ThorSavers.` or a wallet address);
  legs with no row match by their ID in Summ, a txid or the text in their
  description, or a txid of a row in scope; legs that also name the tx of
  a row outside the scope that the full plan uploads are left, and the
  scope's rows and other legs with no row of that tx, or of any other tx
  of theirs, wait with them (unless an entry is their ID in Summ).
  Everything else, including a decision on a row outside the scope, waits
  for another plan, and so does a categorisation whose event has an upload
  the plan does not carry; `plan.md` notes each, and each entry that
  matches nothing. Use it to apply one stage at a time.
  Reference prices: a sell whose quote Summ cannot price is one entry with
  what each leg gets, so both sides hold the same value; a sell whose quote
  has a market price is listed as held; the leg of Summ's own import of a
  swap takes its row's USD price, never a change of its amount or fee.
- `apply` carries out a plan made from the latest snapshot: deletes (only
  with `--approve-deletes`), then edits and categorisation (categorisation
  waits while the plan has uploads). A two-leg price entry makes two edits,
  the sell, then the buy from the value read back; a stop between them
  goes on by doing the buy. Every entry is classified by a fresh read
  on every run: not yet done, done, or anything else, which stops the run and
  reports what it found. So after any stop, run the same command again: it goes
  on from where it stopped, or refuses, and then you pull and plan. Every write's
  result is checked and read back. Ctrl-C finishes the current entry and exits 130.
  A delete compares a fresh read with the values in `plan.md`, and stops on any
  difference, on a leg in the action the plan does not name, or on a manual entry
  in the action or naming the row's txid (`plan.md` marks a delete with no txid to
  look for). A plan from an older version, whose
  deletes hold no values, is refused: pull and plan again.
  Apply lists no upload while any delete this apply selects is not made: a row uploaded
  beside an old version would count twice. It says what to do instead.

  When every entry is done it adds the plan's adoptions and captured overrides
  to `adopted.csv` and `overrides.json` and lists the upload files; a finished plan
  reports that and does nothing. `<state dir>/.lock` keeps a second apply out. It
  applies the current years' entries, or with `--approve-filed` only the
  filed years'. `--dry-run` does the look-ups and checks with read tools
  only and writes nothing. Before every write it saves the action as just read
  (full JSON and change history) to `<plan dir>/pre/<entry>.<step>.json` and logs its
  intent to `<state dir>/apply-log.jsonl`; after it logs the result and undo handle
  (`undo_edit`; deletes have none). Summ cannot undo a delete
  and the MCP cannot recreate an uploaded row, so to bring a row back,
  upload its CSV line again; a delete's pre-image holds that line when the run or
  the plan's upload files have it, and shows what Summ held. It needs `login --write`. Afterwards, upload the
  files, then pull and plan again; recalculate in Summ before reading any
  figures.

- `prune` removes the snapshots older than `--older-than` days (default
  30; never the latest), with their details files, and the stored actions no remaining snapshot lists
  (except those the apply log names; a snapshot whose plan has pre-images stays too), once they are committed (keep the state dir in git; git keeps the removed files). If
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
  out, under Held; legs with no row under a held ID, or naming a held
  txid, are not deleted. A held ID with no row in the run's periods, or a
  held txid no row names, is noted.

## Tests

    cd packages/summ-sync && npm run typecheck && npm test
