# Summ sync

Keeps Summ matching a run's output, like Terraform: **pull** Summ's state,
**plan** the differences against the run (the desired state), review the
plan, **apply** it, and pull again. A second plan right after an apply is
empty.

It moves no tax treatment of its own. It makes Summ hold the rows the
exporter wrote, so every disposal, acquisition, income and fee in Summ is
the one the source data gives. Summ still prices every row and computes
every gain; the sync never compares or writes fiat values.

## Two kinds of rows

- **Managed rows** come from the exporter's CSVs that the operator uploads
  (by default THORChain and Maya wallets). Summ
  keeps each row's `ID` (`periods.md`, Row IDs) on its leg. The sync plans
  their deletes and edits; new rows reach Summ by upload.
- **Categorised rows** are rows the exporter writes for wallets the user
  lets Summ import itself (by default BTC, ETH and other L1 wallets): the L1
  side of a swap, an LP add or a refund. They are never uploaded. The sync finds Summ's own leg for each
  (same on-chain txid, currency and amount) and edits its type to
  match. It never creates or deletes a leg of Summ's own imports, and never
  edits their amounts or fees: the import read those from the chain.

Each CSV file's chain (in its name, `periods.md`) says which kind its rows
are: chains listed in `managedChains` (default `THOR` and `MAYA`) are
managed, all others categorised, except rows no import of their L1 chain
can hold, which are managed: on a chain other than THORChain and Maya, LP
and savers token receives and returns, price helpers (`spam`), and what a
refund kept (on an L1 file the exporter writes `fee` and `lost` only for
that). Their amount never moves on that chain. A row of these types with a
fee (the L1 gas of a withdraw request, a tx Summ's import of the wallet
holds with its gas) is managed without the fee, in its match and its
upload file, so the gas is counted once. When no leg of Summ's imports
has the row's txid in the fee's currency, the request is missing from
Summ and the gas would count nowhere: the row is listed in the `fee`
report (`not-in-snapshot` when Summ lists the txid but the snapshot lacks
its detail). On THORChain and Maya these types are on chain, so a
user who leaves those chains to Summ's import leaves these rows to it too. The user uploads them into the THORChain or Maya
account, in a file named after their wallet file (plan.md says so beside the
file). Summ keeps such a row's blockchain and resolves its L1 address to the
user's wallet of that chain, so a `lost` or `fee` comes out of that wallet's
balance; it stores the address in lower case (compared without case). Which source a chain's rows come from is
the user's choice, by what gives the better rows: Summ may support a chain's
wallets (it has a THORChain integration) and the user still upload the
exporter's rows because Summ's import of that chain is incomplete. What must
not happen is both for one wallet: its rows would be counted twice.

## What Summ's MCP allows

Summ's MCP server (`mcp.summ.com`, OAuth with the `mcp:read` and
`mcp:write` scopes) is the only interface used. What it can and cannot do
decides the design:

- Read: every action, page by page, and each action's full JSON (legs with
  `_id`, `id`, `description`, `trade`, `importType`, fee legs, comments,
  change history).
- Edit one leg: type, currency, quantity, price, from, to, timestamp,
  blockchain, reviewed. Not the description, the ID or tags. Every edit
  rebuilds the action, so **action ids change on every write**; a leg's
  `_id` does not.
- Bulk: recategorise, ignore, comment, tag, change currency, value or
  account, and **delete (permanent, no undo)**. Edits other than delete
  return an undo handle.
- Create: manual entries only, with no `ID` or description, and no custom
  currencies (LP tokens and other assets created by a CSV import are
  rejected). So the sync does not create rows: the operator uploads CSVs.
- No tool groups two legs into one action: Summ pairs transfers and bridges
  itself, by time and amount.
- No tool deletes one leg of an action: a delete takes whole actions. But a
  leg edited alone to `ignoreIn` or `ignoreOut` is moved by Summ, in the
  edit's own rebuild, to an action of its own; the action's other legs keep
  every field. This holds for a fee leg (it becomes an outgoing leg) and for one
  side of a transfer (the other side is left as a lone send or receive, not
  re-paired).

On upload, Summ skips a row whose `ID` and data equal a row it holds, and
**imports a row with a known `ID` but different data as a second row**;
a changed amount or a changed description alone is enough. The `ID` is
stored as given and shown as the leg's "Tx Hash" (a 121-character ID was
kept whole). So a changed managed row is deleted before the upload that brings its new
version.

## Package

The sync lives in `packages/summ-sync/`, with its own `package.json`, tests
and README. It imports nothing from the exporter and the exporter imports
nothing from it; the only link is the files below. It speaks MCP over
`fetch` (JSON-RPC and OAuth with PKCE, Node built-ins only).

## Commands

    summ-sync login <state dir> [--write]  # browser OAuth; token in the state dir
    summ-sync pull  <state dir> [<run dir>] [--full]  # writes a snapshot
    summ-sync plan  <state dir> <run dir> [--only <scope file>]  # reads files only; calls nothing
    summ-sync apply <state dir> <plan dir> [--dry-run] [--approve-deletes] [--approve-filed]
    summ-sync prune <state dir> [--older-than <days>]  # removes old committed snapshots and actions

The **state dir** holds the action store, snapshots, plans, apply logs, the
adoption table and the overrides file. It is the user's private data: never
in this repo. It is meant to be kept in git (prune relies on it).

## State dir

    actions/<action id>.json    one action's JSON and change history, written once
    snapshots/<time>.json       one pull: counts, and one entry per listed action
    plans/<time>/               plan.json, plan.md, upload/
    adopted.csv, overrides.json, apply-log.jsonl, summ-sync.json

**Action store.** Summ's action ids are database ids made when the action
is (re)built, and every write rebuilds it, so what the sync reads of an
action never changes under the same id: its legs (all fields plan reads)
and its change history entries. An id's detail is therefore fetched and
written once and never rewritten (except by `pull --full`, below). Pull
writes it. Apply adds only the fresh read it makes of an action just
before deleting it, since Summ keeps nothing to fetch afterwards (if the id
is unchanged since the pull, the store holds it already). An action apply edits gets a
new id in Summ; apply does not store it, and the next pull fetches it as a
new id. Other fields do
move under the same id (`lastModified`, `updatedAt`, `balanceSnapshot`,
`sortPriority`), as does the history's "_N earlier versions not read._"
line; the stored file keeps them as first read, and nothing reads them.

**Snapshot file.** A pull's counts (the list's reported total, parsed and
unique counts, managed sources, the run dir, how many details were fetched
and how many the store already held), then one entry per listed action:
`id`, `txHash`, `category`, `tags`, and `detail: true` when the action is
one the plan needs (below). The file is written whole at the end of the
pull, so a pull that stops leaves no snapshot. An action of a managed
source that the full list missed because Summ rebuilt it during the pull
(its new id is only in the source query) is added as an entry, with a
warning, so the plan still reads its legs. Store files are written through
a temporary file, so a stopped pull never leaves half a file under an id. The list pages themselves are
not kept. An action deleted in Summ is simply absent from later snapshots;
its stored detail stays.

**Prune** removes snapshot files older than `--older-than` days (default
30, by the time in their name; never the latest) and store files that no
remaining snapshot lists, except actions apply saved before deleting them
(named in `apply-log.jsonl`), but only files git tracks with no uncommitted
changes (git keeps them); otherwise it removes nothing and lists the files.
Plans keep their snapshot's name.

## Inputs

**Run folder** (written by the exporter): the desired state is its period
wallet files, `csv/<from>_<to>_<CHAIN>_<wallet>_<name>.csv` (`periods.md`),
the files the user uploads. `csv/all.csv` is not read: it holds rows outside
the run's periods. `row-ids.csv` traces an `ID` back to its action for the
user; plan does not need it. No other file is written for the sync.
**Extra folders** (`extraDirs` in `summ-sync.json`): files made by hand in
the same shape and naming, e.g. rows the exporter cannot produce, uploaded
like the run's. Their rows are part of the desired state; without them, plan
would delete those rows as old IDs. Only a file whose period is one of the
run's counts: another period would widen the plan's scope to a year the run
does not hold. An extra file named like a run file goes into the same
upload file, so it must have the same header; plan refuses one that does
not.

An extra row can be overtaken: an amendment made while the exporter could
not map an event, which the run now exports itself under a stable ID. Plan
leaves out an extra row when exactly one run row has its txids, type,
currency, amount, second and wallet (the sender of an outgoing row, the
receiver of an incoming one) (**superseded**).
Summ's legs of the extra row then have no row with their ID, so they are
matched as legacy legs (Matching): they adopt to the run row, and Summ
keeps them and their pairing, when it does not hold the run row as well;
when it does, the extra row's legs are planned for deletion. An override
of the extra row's ID applies to the run row. A run that does not export
the event keeps the extra row, and an extra row without a txid is never
left out.

An extra row that shares a txid with run rows of the same side and base
currency, but fits none of them in type, amount, time or wallet, is
reported (`extra-overlap`), and neither it nor those run rows is uploaded:
it may be one of them in an older shape (a refund as one receive, where the
run has the failed send and the fee kept). If it is, move its file out of
`extraDirs`; if both are right, add its ID to `keepExtra` in
`summ-sync.json`. An extra row on the other side or in another currency
(a cost the exporter cannot produce, beside the run's swap) is not an
overlap. An event the extra row holds with no shared txid, at another time
or amount, cannot be seen: move its file by hand. A row's
on-chain txids are the 64-character hex strings in its description (as
`run-diff.md`); a payout to an L1 wallet names its outbound txid there too
(`fees.md`, Txids in descriptions).

**Snapshot** (written by `pull`, State dir above): every listed action,
and the detail of each action the plan needs: every action of a managed
source, and, when pull is given the run dir, every action whose tx hash is
a txid of a categorised row or of a managed row with a request's gas
(above). Pull fetches only the details the store lacks.
`pull --full` fetches every needed detail again and reports each stored id
whose legs or change history entries differ from Summ's (which would
disprove the store's premise); it then replaces that store file. A snapshot
is never patched: after an apply, pull again.

**Sync config** (`summ-sync.json` in the state dir):

- `filedBefore`: rows before this date belong to filed years; changing them
  is an amendment (below).
- `managedChains`: the chains whose files the user uploads, so their rows
  are managed (default `["THOR", "MAYA"]`). A chain not listed is left to
  Summ's own import of its wallets.
- `managedSources`: Summ's source names of the managed rows (e.g. the
  account name the CSVs were uploaded under).
- `timezone`: the Summ account's timezone (IANA name, default `UTC`): the
  days of the run's periods and of `filedBefore`, as the exporter's
  `timezone` (`periods.md`).

## Matching

**Scope.** Summ holds every year; a run holds its periods. A managed leg
that matches no row is only planned for deletion when its timestamp falls
in one of the run's periods (whole days in `timezone`); one outside them is
left alone and counted.

**Managed rows** match the Summ legs of a managed source with the same `id`.
A row is in Summ as a base leg (the type's side), a quote leg on the other
side for `buy` and `sell` only (Summ keeps no leg for the quote of other
types, e.g. `bridge-trade-out`), and a leg in `fees` when the row has a fee,
all carrying the row's `ID`.

Rows uploaded before stable IDs carry `<file>:<n>`: plan adopts each such
leg to the one unmatched row with a leg on the same side, the same currency
and amount and, when the leg's description holds txids (old descriptions
often do not), the same txids. It takes the best of four fits, in order:

1. the same type at the same second;
2. the same type within `ADOPT_WINDOW` (120 s) and the same wallet (the
   sender of an outgoing leg, the receiver of an incoming one): old exports
   took some times from Viewblock's block time, the run from Midgard's
   action time;
3. another type on the same side, at the same second and in the same
   wallet: an old type (a plain withdrawal that is now a bridge trade). The
   plan then edits the type, so Summ keeps the leg and its pairing;
4. another type on the same side, within the window and in the same wallet.

Each rank is settled for all legacy legs before the next, so a looser fit
of one leg never blocks or takes a row another leg fits exactly.

At one rank, a row that several legacy legs claim goes to the one that is
not ignored, when exactly one of them is not and it fits no other row there
(rows held back for an ambiguous leg at a closer rank aside): the others are its ignored
duplicates. They take no further part in adoption or the lookalike check (an
ignored leg counts nothing) and are deleted, even when they also fitted
another row whose legs stay ambiguous. When that leg fits other rows too, it
takes none, and it and its ignored duplicates are reported as ambiguous.

Plan records each adopted leg in `adopted.csv` (`Leg,ID`: leg `_id`, row
ID); later plans match the leg through that table, so a later change of
the row is an edit, not a re-upload. An in-scope legacy leg that fits no
row is planned for deletion like any other, unless an unmatched row has its
currency and amount in the same wallet within a day (and its txids, if the
leg names any): that leg may be the row under another time or type, and
deleting one while uploading the other could double a disposal or lose
Summ's pairing, so both are reported (`legacy-lookalike`) and neither is
planned. A legacy leg that fits several rows, or a row that several legacy
legs fit, is reported, and no row the leg fits at any rank is uploaded.

**Categorised rows** match a leg of Summ's own imports whose tx hash is a
txid of the row, on the row's side, with the same currency, and an amount
equal to the row's or the row's plus its fee (Summ records the gross amount
on some chains). Exactly one leg must match. A row with no such leg takes
the one leg with its txid, side and currency whatever the amount (or, when
the user split a gas off by hand and ignored it, the one leg not ignored,
once the legs together hold the row's amount) (the txid
is the key: Summ may hold the tx gross of a gas the row does not record, or
the user may have split a fee off by hand), unless another row matched that
leg exactly, or another row would take it the same way (then neither does);
the amount is not edited, and the difference beyond the row's amount, or its
amount plus its fee, is listed in the `fee` report. Several legs, or none, are reported, not guessed,
except when Summ holds the tx twice (seen as a later import of the wallet,
an hour off, holding the gas inside the amount; the time is not compared): of the legs that fit,
the one with the row's shape is the row's, first the row's amount with a fee
leg of the row's fee, then the amount plus the fee with no fee leg, and each
other leg not ignored, and not taken by another row, is reported
(`duplicate-leg`) for the user to resolve in Summ, since it may count the
tx twice.

The fee of a categorised row is compared with the fee leg of Summ's own
action, and a difference is listed in the `fee` report, not edited: Summ's
import read the fee from the chain, while the row's may be a source's
estimate (THORNode gives an EVM inbound's gas as its max fee per gas times
the gas used, above what the wallet paid). A leg holding the row's amount
plus its fee, in the currency sent, with no fee leg is Summ's shape of the
same tx (Bitcoin-style imports keep the gas inside the amount sent): not
reported. A leg with no fee leg may still hold its fee on the leg itself
(`feeQuantity`, seen on Binance Chain imports whose fee leg Summ moved to an
action of its own); that fee is compared as a fee leg would be, and of a tx
Summ holds twice, such a leg ranks after one with a fee leg and before one
of the amount plus the fee. A fee within the amount's tolerance (a tiny
fee on a large amount) cannot be told from no fee, so a leg without a fee
leg is reported then.

**Foreign pairs.** Summ's own matcher pairs an uploaded trade with any leg
of about its value and retypes that leg (change history: `transactionMatching`),
e.g. a bridge receive taken for a swap's payout while the payout is still a
plain receive; while the trade lacks its real partner, it can undo a user's
edit of that leg. A managed row
whose Summ action holds a leg of Summ's imports with an on-chain txid that no
row of its event names (rows sharing a txid) is reported (`foreign-pair`),
with the matcher's changes from the action's history. Not reported: an
exchange's own record (no on-chain txid); a leg with the side, currency and
amount of a categorised row of the event that matched no leg (a payout the
exporter could not name, e.g. before its txid was known; that row is
reported as `no-leg`); a held row (held by the config or in a manual-pairing
event: left alone on purpose). The event is the one Held uses. To undo it: categorise the row's own other
side first, so the matcher has the right partner, then set the leg back.

**Made-up legs.** Summ pairs a send of its own imports with a receive
it makes up itself (source `manual`, import type `soft-transfer`, to an
account such as "THORChain"), so the send is a transfer that disposes of
nothing; a receive it pairs with a made-up send (withdrawal from such an
account). Once the leg is categorised as anything but a plain send or
receive, Summ splits the made-up leg off as an action of its own
(`unmatchedTransfer`), and the asset counts twice. So plan lists each such leg (same txid and
currency, not yet ignored) with the categorised row, and apply ignores
it. A made-up leg is never matched to a categorised row.

## Compared fields

Type, base currency and amount, quote currency and amount (buy and sell),
fee currency and amount, timestamp (to the second; on every leg of the row,
since Summ splits a leg left at another time into an action of its own), blockchain, from and to
(managed rows only), and the description (managed rows with a stable ID; an
adopted leg keeps its old wording). Not price, value or gain.

A row with no fee whose legs in Summ include a fee leg (old exports put an
own-wallet transfer's fee on both sides) loses only that leg: a delete of the
fee leg alone, and the rest is compared as usual. Any other changed shape (a
leg on the other side, a quote leg gained or lost, a fee leg gained, or
legs Summ has split into several actions), currency or description cannot
be an edit (the MCP rejects custom
currencies such as LP tokens, and cannot set descriptions), so such a row is
deleted and uploaded again. The other fields are edits.

The CSV's blockchain names are mapped to Summ's ids by a table in the
package (`THORChain` → `thorchain`, `BNB` → `binancechain`, ...); a chain
the table lacks is not compared, and the plan says which. CSV types are compared as Summ's enum
(`bridge-trade-out` → `bridgeTradeOut`, `receive-lp-token` →
`receivingLiquidityProviderToken`, ...); the mapping table is part of the
package and a type it lacks stops the plan.

Amounts are equal when they differ by less than `1e-8` of the amount, or
by at most one unit at the 8th decimal: the exporter's amounts carry
THORChain's 8 decimals, while Summ's own imports hold e.g. ETH gas in full.

A `sell` row whose fee is in the asset sold is held by Summ with the fee
added to the sold amount (its fee leg is marked `nettedOff`), so that gross
amount matches the row too. Other types (e.g. `bridge-trade-out`) keep the
row's amount.

## Plan

`plan` writes `plans/<timestamp>/plan.json` (machine-readable, the input to
`apply`), `plan.md` (for review) and `upload/`. It changes nothing in
Summ or in the state dir: `apply` adds the legs the plan adopted and the
overrides it captured to `adopted.csv` and `overrides.json` as they are
then (not on a dry run), so a plan that is never applied changes nothing
later plans assume, and an override edited by hand after the plan is kept. Each change names the row `ID`, the leg `_id`, the field, Summ's
value and the desired value; each delete names the legs and how many other
legs share their actions (a delete by action would remove those too).

| Section    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Applied as                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| delete     | managed legs with no row in the run; managed legs whose row changed in a field an edit cannot set (description, ID) or whose action shape changed; a fee leg the row no longer has                                                                                                                                                                                                                                                                                                                                                                                                                            | bulk delete by action id, after splitting a leg off an action whose other legs stay; only with `--approve-deletes`                                                 |
| edit       | managed legs whose row changed only in editable fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `edit_transaction` per action                                                                                                                                      |
| upload     | rows with no leg in Summ after the deletes, per CSV file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | files written to `plans/<timestamp>/upload/` (the file's header and those rows as the run wrote them; filed-year rows in `<file>_filed.csv`), uploaded by the user |
| categorise | categorised rows whose Summ leg differs in type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `edit_transaction`                                                                                                                                                 |
| superseded | extra rows a run row exports itself (Extra folders above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | nothing: their legs adopt to the run row                                                                                                                           |
| report     | categorised rows with no or several matching legs, or whose fee differs from Summ's (not edited); legs of a tx Summ holds twice beside the one a row matched (`duplicate-leg`); extra rows that share a txid, side and currency with run rows without being the same row (`extra-overlap`); legacy legs that fit several rows, or that look like an unmatched row (`legacy-lookalike`); managed rows whose ID Summ holds under a source not in `managedSources` (not uploaded again); managed rows Summ paired with a leg no row of their event names (`foreign-pair`); manual entries repeating a row's txid | nothing: for the user to resolve                                                                                                                                   |
| held       | rows the plan leaves alone (Held below), with what it left out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | nothing                                                                                                                                                            |
| overridden | differences an override keeps (undecided ones on every plan), and overrides captured in this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | nothing                                                                                                                                                            |

**Held.** Nothing is planned for two kinds of row, which are listed instead
with the entries left out:

- a row whose ID is in `hold` in `summ-sync.json`, or that names a txid
  there (not a placeholder of zeros), with a reason: a decision outside
  the sync is pending (a held ID
  with no row in the run's periods, or a held txid no row names, is noted;
  legs with no row in the run under a held ID, or naming a held txid in
  their description, are not deleted);
- every row of an event, the rows linked by a shared txid, when a Summ
  action holding a leg of one of them, or one of its planned deletes, also
  holds a manual entry (import type `manual`), or a manual entry names one
  of their txids: the user's own pairing or stand-in. A placeholder txid
  (all zeros) links no rows. A
  delete, split or edit there could break it, and an upload or a categorise
  beside it could count the same asset twice (a manual receive standing in
  for a swap's payout, next to the import's own receive of it). Legs with no
  row in the run whose action holds a manual entry are not deleted either.
  The user resolves the pairing in Summ, or the run, and plans again.

**Filed years.** An entry whose row or leg is dated before `filedBefore` is
an amendment: listed under its own heading in each section and applied only
with `--approve-filed`, in a separate apply from the current year.

**Drift and overrides.** A value the user changed in Summ is kept, never
set back by default. Summ's change history labels every edit through the
MCP as the user's, so an edit is the sync's own when `apply-log.jsonl`
records it (same leg, field and value), and drift otherwise. The history is
per action, in the web app's labels (`Category`, `Quantity`, `From`, ...),
so a difference counts as drift when its action's history has a `user`
change of that field's label: an edit of another leg in the same action
(e.g. the other side of a transfer) can make it drift too. `plan`
records each one it has not seen before in `overrides.json` in the state
dir: row `ID`, field, the run's value, the user's value, when it was seen,
and a `reason` for the user to fill in, and `retainUserEdit`: the user's
decision on that value.

| `retainUserEdit` | Plan                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `undecided`      | keeps the user's value and lists the entry under overridden on every plan where Summ differs from the run, until decided |
| `yes`            | keeps the user's value                                                                                                   |
| `no`             | sets the run's value (an edit, or a categorisation for an import's leg); after the apply the edit is the sync's own      |

A capture is `undecided`, and so is an entry without the field (written
before it existed); any other value is an error. The decision holds for the
value it was made on (the entry's user value): when the user sets another
value in Summ, whatever the decision, it is captured again as `undecided`,
with the entry's `reason` kept. So a `no` never sets back a different later
value, and a `yes` never keeps one unseen. Deleting an entry means "ask
again": the history still shows the user's edit and apply-log has none of
the user's value, so the next plan captures it as `undecided`.

The same idea elsewhere: Terraform shows drift on every plan until it is
resolved and keeps a field with `lifecycle { ignore_changes }` (`yes`); git
`rerere` reuses a recorded conflict resolution only for the same conflict
(the decision holds for one value); Kubernetes server-side apply reports a
change to a field someone else set as a conflict instead of overwriting it
(`undecided`).

Each plan also lists, under overridden, the overrides it captured for the
first time, and every kept override whose run value has changed since it
was captured: the source data or the mapper moved under it, and the override
still wins until the user decides (an `undecided` one is then listed twice,
as undecided and as run changed). An override whose row or leg no longer
exists is reported and left for the user to delete.

**Scoped plans.** `plan --only <file>` plans one stage of the work, e.g.
the savers rows, apart from the rest of the run. The file has one entry per
line; blank lines are left out, and so is a comment: a `#` at the start of
a line or after a space, to the end of the line. An entry matches a row
with that ID; an entry of 64 hex digits (any case, with or without `0x`) is
a txid and matches the rows naming it (a placeholder of zeros is refused);
any other entry matches a row whose CSV line holds the text (e.g.
`ThorSavers.` or a wallet address). Legs with no row in the run match by
their ID in Summ, a txid in their description, or the text in their
description, and also when their description names a txid of a row in
scope (the same tx: stale legs that would otherwise sit beside its upload).
Unless an entry is their ID in Summ, legs that also name the tx of a row
outside the scope that the plan uploads are not deleted, and the rows of
the scope and other legs with no row naming that tx wait with them, as do
the rows and legs naming any other tx of theirs (nothing of theirs is
carried: no delete, edit, upload, categorisation, adoption, report or
override), each noted: deleting the
legs would drop that row's side from Summ until its own plan uploads it,
and uploading beside them could hold a side twice, so a scoped apply leaves
the tx as it is until the scope takes the other row too. A row outside the
scope that Summ already holds, or that Summ imports itself, loses nothing,
so it does not stop the delete. Held entries with no row are listed when
the scope matches their legs, without this check (nothing is deleted). The plan is made
from the whole run, as without `--only`, then keeps only what concerns the
rows in scope: their deletes, edits, uploads, categorisations, adoptions,
superseded extra rows, held entries, reports (a report with no row when it
names one in scope) and overrides; and the deletes and held entries of legs
with no row in scope. So a decision on a row outside the scope, such as
`retainUserEdit: "no"` on a value that is set back only together with the
full run's deletes and uploads, waits for a plan that covers that row, and
an apply of the scoped plan cannot carry it early. A categorisation in
scope whose event (rows linked by a shared txid) has an upload this plan
does not carry waits too, and is noted, so that Summ can pair its leg with the
uploaded row (Apply below). It waits only for its event's uploads, not for
every upload of the run as apply does, or a scoped categorisation would wait
for the whole run; a categorised row linked to its upload by no txid (a
placeholder outbound) needs that row in the scope. `plan.json` records the
entries (`scope`) and the file (`scopeFile`); `plan.md` lists the entries,
counts the rows in scope (`scopedRows`) and notes each entry that matches
nothing. The other counts of rows, legs and matches still cover the whole
run: the plan matches every row as usual, so a row out of scope is never
uploaded or deleted for want of its neighbours.

## Apply

In this order, stopping at the first failure (a read, query or inspect,
that fails with a server error (5xx) is first retried once after a pause,
in pull too; a write never is, since it may have been made before the
error):

1. Check the plan's snapshot is the latest, and that `apply-log.jsonl`
   records no write since that snapshot was taken; refuse otherwise (pull
   and plan again).
2. Deletes (approved). Each leg is looked up again by `_id`, and only
   actions that now hold nothing but the entry's legs are deleted, by
   their action ids. A leg that shares its action with other legs (in the
   plan or in Summ now) is first split off: one `edit_transaction` per
   action sets the entry's legs in it to `ignoreIn` (incoming) or
   `ignoreOut` (outgoing, fee), and Summ moves them to an action of their
   own. Apply looks them up again (waiting a few seconds, up to five
   times, and once more after it sees them alone) and deletes that action.
   When Summ has not split them off, apply skips the entry there: the legs
   stay ignored (they no longer count), and the skip names the edit's undo
   handle. A leg already ignored that still shares its action is skipped
   (an edit to the same type would not split it). A receive or send Summ
   made up to pair the deleted leg as a transfer (Made-up legs above) is
   then left alone, and is ignored by its action id as in step 3. Never by a
   filter: Summ's `id` filter lists the leg's action but can list
   unrelated actions too, even with `showAssociated: 0`, so a look-up
   inspects each action it lists and keeps only the one holding the leg.
   Summ cannot undo a delete, so apply first saves each action as it
   just inspected it (the shared action before the split edit, the
   split-off one before the delete) to the store (`actions/<action id>.json`, unless the
   store already holds that id), and the log line names the file. A deleted row comes back by
   uploading its CSV line again; the saved file shows what Summ held.
3. Edits and categorisation. Before each action, look it up again by leg
   `_id` (action ids change after every write) and check the leg still
   holds the plan's "Summ value"; a leg that changed since the pull is
   skipped and reported. All changes of one action go in one
   `edit_transaction`.
   Then each made-up leg of the row is looked up again by `_id`
   (waiting a few seconds for Summ to split it off) and ignored by its
   action id, only when that action holds nothing else; if the edit was
   skipped, so is the ignore. An undo handle cannot be relied on to back
   out of this: once Summ re-pairs the categorised leg with another
   (e.g. an uploaded bridge-trade-in), the edit's handle is stale.
4. Print the upload files for the user to upload.
5. Write `apply-log.jsonl` as it goes: each call, its result and its undo
   handle, one line per changed field (`legId`, `field`, `value`) for
   plan's drift check, and each skip.

While the plan has uploads (for the years this apply covers), apply holds
back categorisation: Summ pairs a categorised leg with the other side of
its swap only when that side is already in Summ, so the user uploads first
and runs pull, plan and apply again.

An apply carries out the current years' entries, or with `--approve-filed`
only the filed years'. `--dry-run` does steps 1 to 3 with read tools only
and writes nothing.

Then `pull` and `plan` again: the plan should be empty, apart from what the
upload adds once done.

## Not done here

- Creating rows through the MCP (see above). Revisit if Summ's MCP accepts
  custom currencies, an ID and a description.
- Pairing legs. Summ's own matching pairs them; an unpaired leg shows as a
  report entry (Summ's `unmatchedTransfer` warning).
- Prices and gains.
