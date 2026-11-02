# Periods and CSV files

A run splits its rows into periods (`fromDate`, `toDate`, `frequency`) and
writes, for each period, one CSV per wallet for Summ to import, plus
`all-<from>_<to>.csv`. `all.csv` holds every row, whatever its date. The
layout is `csvFiles` in `src/export/summ/files.ts`.

## Required behaviour

- A period is made of whole calendar days: it starts at midnight at the start
  of `fromDate` and ends at midnight at the end of `toDate`. A row at
  23:59 on the last day is in the period.
- The days are those of the config's `timezone`, an IANA name such as
  `Europe/London`. Without it they are UTC days, as before the key existed.
- Daylight saving is followed: in New York a period ending 30 June ends at
  04:00 UTC on 1 July (UTC-4), one ending 31 December at 05:00 UTC on
  1 January (UTC-5).
- When `toDate` is left out it is today's date in that timezone (UTC
  without the key).
- An unknown timezone name stops the run before anything is fetched.
- The config is checked when it is loaded, before anything is fetched
  (`TaxConfig.applyDefaults`), and a mistake stops the run with a message
  naming the key:
  - `fromDate` is required. `fromDate` and `toDate` are calendar dates,
    `"2025-07-01"`; an unquoted TOML date (`fromDate = 2025-07-01`) is read as
    the same date, a date-time is refused (one at exactly UTC midnight reads
    as its date), and so is a day not on the
    calendar (`"2023-02-30"`). `toDate` is not before `fromDate`.
  - `frequency` is required: `"monthly"`, `"yearly"` or `"none"`.
  - `wallets` is required (it may be empty). Each wallet has a `name`, an
    `address` no other wallet has (in any letter case) and a `blockchain`
    holding a letter or digit, written in upper case with anything else
    dropped (`thor` gives `THOR`), the form summ-sync reads back from the
    file names.
  - `protocols`, when set, lists `"thorchain"` and `"maya"`, each at most once.
- File names keep the period's dates (`2025-07-01_2026-06-30_…`); the
  timezone does not appear in them.
- The run writes the timezone it used to `run.json` in its folder,
  `{ "version": 1, "timezone": "<IANA name>" }` (`UTC` when the config sets
  none), for summ-sync to check against its own (`summ-sync.md`).

## Why

Summ assigns a row to a tax year by its timestamp in the account's timezone.
In a zone nine hours ahead of UTC (`Asia/Tokyo`), a year ending 30 June ends
at 15:00 UTC. With UTC periods, a row between 15:00 and 24:00 UTC on 30 June
is in Summ's next year but in the earlier year's file (in a zone behind UTC
the mismatch is at the start of 1 July instead). A year's files then hold rows of the next year, and a row of the next
year is missed if the earlier year was uploaded before it was exported. With
the account's timezone set, each period file holds exactly the rows Summ
counts in that period.

The period only decides which upload a row is in; Summ still dates each row
by its own timestamp.

## Row IDs

Each row's `ID` column says what the row is, never its amounts or wording:

    <action time>.<role>.<hash>
    2023-05-24T10:15:31.478Z.out.e2c2d9933761

- **Action time**: the action's own time (UTC), so the rows of one action
  sort together, also when a row's timestamp is offset (the LP token and
  price-helper rows are 10 and 20 seconds later).
- **Role**: what moved, not how the row is exported. A row is named by the
  leg in its base columns: `out` or `in` for what the wallet sent or
  received, `reward` for income the protocol paid (e.g. a TCY distribution),
  `gas` when the network fee is all the row records (a THORName update). A
  row that records no single leg is `price-helper` (the market-price row of
  an LP add or withdraw) or `unreturned` (what a refund did not give back,
  exported as `Fee` or `Lost`). So a change of treatment, e.g. a swap exported
  as a bridge instead of a trade, a refund's remainder as `Lost` instead of
  `Fee`, or another naming of trade assets, changes the row's type or
  currency but not its ID; a row that only one treatment has simply appears
  or goes.
- **Hash**: the first 12 hex digits of SHA-256 over `v1|<record>|<wallet>|
<role>|<asset>`: the action's store record key (source, type, txid, and
  the contract event or members where they tell actions apart,
  `snapshots.md`; a FIN swap's without its fill hash, `rujira.md`, FIN
  fills), the row's wallet, the role, and the leg's asset as the source
  names it (`BTC.BTC`, whatever the CSV calls it). Twelve hex digits
  only have to tell apart the rows that share a time and role.

A row has the same ID in every file it is in and in every run. Summ shows it
as the "Tx Hash", and keeps it on each leg, so a row in Summ is traced back by
its ID: each run writes `row-ids.csv` next to `csv/` (not uploaded), with each
ID's timestamp, type, wallet, record, role and asset. An ID changes only when
what the row is changes (e.g. a mapper fix splits a row); `v1` changes if the
format ever does. Two rows with one ID are a mapper bug, and stop the run.

On upload, Summ skips a row whose ID and data equal a row it already holds,
and imports a row with a known ID but different data as a second row (Summ
help, "Handling duplicate transactions"). So a corrected row replaces the old
one only after the old one is deleted (`summ-sync.md`).

## History

- Before October 2026 the ID was `<file>:<n>`, numbered from the oldest row in
  the file, so one added row renumbered every newer row; then briefly
  `<action time>.<mapper's name>` with `.2` for a repeat.
- Before October 2026, periods ended at 00:00 UTC on their last day, so a
  row later that day was in no period file (only in `all.csv`).
- October 2026: periods include their whole last day (UTC), and the
  `timezone` key was added.
- Until November 2026 most config mistakes were found only after every
  wallet was fetched, and some not at all: an unquoted TOML date skipped the
  Viewblock source, an unknown `frequency` was read as yearly, and
  `"2023-02-30"` made a period that ended before it started.
- November 2026: runs write `run.json`; a run folder from before has none.
