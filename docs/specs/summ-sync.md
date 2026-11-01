# Summ sync

Keeps Summ matching a run's output, like Terraform: **pull** Summ's state,
**plan** the differences against the run (the desired state), review the
plan, **apply** it, and pull again. A second plan right after an apply is
empty.

It moves no tax treatment of its own. It makes Summ hold the rows the
exporter wrote, so every disposal, acquisition, income and fee in Summ is
the one the source data gives. Summ still computes every gain. The fiat
values the sync writes are a row's USD reference price, on a managed row or
on an import's leg of a swap, and on a sell whose quote Summ cannot price the
buy leg's local price that gives it the sell's value (Prices below). They
move the proceeds, cost base or income of that row.

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
  edits their amounts or fees: the import read those from the chain. The leg
  of a swap also takes its row's USD price (Prices below).

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
- Edit one leg: type, currency, quantity, price, price currency, from, to,
  timestamp, blockchain, reviewed. Not the description, the ID or tags. **An action's
  id can change on any write or recalculation, and can stay the same across
  an edit** (it does while Summ's computation is paused), so an id says
  nothing about whether an action changed. A leg's `_id` stays across
  rebuilds, except on legs Summ makes itself (`assumed-fee`).
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
    summ-sync pull  <state dir> [<run dir>] [--all]  # writes a snapshot; resumes a stopped pull
    summ-sync plan  <state dir> <run dir> [--only <scope file>]  # reads files only; calls nothing
    summ-sync apply <state dir> <plan dir> [--dry-run] [--approve-deletes] [--approve-filed]
    summ-sync prune <state dir> [--older-than <days>]  # removes old committed snapshots and actions

The **state dir** holds the action store, snapshots, plans, apply logs, the
adoption table and the overrides file. It is the user's private data: never
in this repo. It is meant to be kept in git (prune relies on it).

## State dir

    snapshots/<time>.json       one finished pull: counts, one entry per listed action
    snapshots/<time>.details.jsonl  each action detail that pull read
    actions/<action id>.json    details read before pulls kept their own, and actions older applies saved
    plans/<time>/               plan.json, plan.md, upload/, pre/ (apply's pre-images)
    adopted.csv, overrides.json, apply-log.jsonl, summ-sync.json, .lock (while an apply runs)

**Pull.** Every pull reads the detail of every action the plan needs. There is
no reuse by id, and no cheaper signal is safe: an edit can keep its action id, the
list shows no price, and Summ's last-modified sort is not reliably ordered. It is
slow (minutes for a year, half an hour for the whole history), so it is resumable.

With a run dir the pull covers the run's periods with a day's margin each side
(`range` in the snapshot, in the account's timezone); `--all`, or no run dir, covers
the whole history. A leg dated outside the range is not in the snapshot, so a row
could look missing, or a tx's other copy go unseen. So a plan from a partial snapshot
may hold only edits of managed rows in current years. Uploads, deletes,
categorisations and filed-year edits make plan refuse, and ask for `pull --all`, except a categorise
entry in a current year that changes only an import leg's price, with nothing to ignore, since it rests only on a leg the snapshot holds; and
`plan.md` says its reports can miss or misstate a tx with legs outside the range.

Plan refuses a snapshot pulled for another run or none, or under other
`managedSources` or `managedChains`.

**Details file.** Each detail goes on a line of `<time>.details.jsonl` as it is read
(`a`: the action id, `at`, `action`, `history`; the first line records the run, range
and sources). So each pull's state stays on record, under the action id it was read
by. A stopped pull leaves this file and no `<time>.json`. The next pull of the same
run, range and sources goes on from it, reading what is left, a line cut off by the
stop, and any detail read over an hour ago, since an edit can keep its id. A stopped
pull over a day old, or older than a write apply logged, starts afresh.

**Snapshot file.** Named by the time it finished, so the latest is the last to
finish. `version: 2`, `takenAt` (when the pull started, so a write during
it counts as after it), the counts, `run`, `range`, `rounds`, then one entry per
listed action: `id`, `txHash`, `category`, `tags`, and `detail: true` for the actions
the plan needs. It is written whole, last. It is written only when the pull
**settled**: a round had nothing left to read and listed exactly what the round
before it did, the list's count equals its unique ids, every action of a managed
source is in the list, and no leg is in two actions (those actions are read again).
Otherwise the pull lists again,
up to five rounds, then stops and keeps what it read. A recalculation during a pull
rebuilds every id, so everything is read again.

This is not a point-in-time copy, which Summ cannot give. An edit that keeps its id,
to an action already read, is not seen by this pull. Apply's re-read of each leg
before writing it catches that for the plan's own legs.

**Action store.** `actions/` is no longer written, and older snapshots and older log
lines (`saved`) still name it.

**Prune** removes snapshot files older than `--older-than` days (default
30, by the time in their name; never the latest), with their details files, and store files that no
remaining snapshot lists, but only files git tracks with no uncommitted
changes (git keeps them); otherwise it removes nothing and lists the files.
It keeps what a rollback needs: a delete's `actionIds` and any `saved` file in
`apply-log.jsonl`, and the snapshot and details file of every plan
with a `pre` line, and so what that snapshot lists. A plan with `pre` lines whose
`plan.json` is gone stops the prune. Plans, with their pre-images, are never removed.

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
(above). Every pull reads them all (State dir, Pull). A snapshot is never
patched: after an apply, pull again.

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
adopted leg keeps its old wording). Not value or gain. The price is compared
apart (Prices below), because Summ does not hold the USD price it was given.

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

## Prices

A managed row with a reference price (`prices.md`) should have that price in
Summ. A row uploaded before its price was filled holds Summ's market price
until the sync sets it.

**What Summ holds.** A leg's `price` is always in the user's local currency.
Given a USD price, by upload or by an edit with `priceValueCurrency: "USD"`,
Summ converts it at its own rate and keeps no USD figure. An edit marks the leg
`priceValueCurrency: "USD"`; an upload does not. Only a base leg is priced this way (Trades below). The mark
proves nothing on its own: `undo_edit` restores `price` and leaves the mark
behind. So the sync cannot read the USD price back from Summ, and does not
convert anything itself: an FX rate would add a source, and a threshold to
hide its noise.

**The recorded price.** Apply writes a `price` line (`intent`, Journal) before each price
edit, so a crash or a lost answer leaves the edit unconfirmed rather than
unrecorded. It then reads the leg from the rebuilt actions the edit's result
names, since only Summ's search lags a write, and logs a second line with the local
price Summ shows (`after`). The read counts only when the leg's `updatedAt` is later
than before the edit and the leg is marked USD. `updatedAt` moves on any write, even
one that leaves the price as it was and adds no history line, so an unchanged price
is not mistaken for a lost edit or a stale read. After a few short tries `after` is
null: unconfirmed, nothing assumed. Summ's change history cannot do this: it shows a
rounded price, and only the latest versions.
The USD price a leg holds is:

1. when the log has a `price` line for the leg: the latest line's value, if the
   leg still shows that line's `after`;
2. with no such line, no override decided on the leg's price and no `user` `Price` line in the action's history,
   on a leg from a managed source: the reference price of the row in the `plans/*/upload/` files made before the leg's
   `createdAt`, by the time in the plan folder's name, if they all give the same price. Any of them can be the one
   uploaded, so files that disagree, a file with no price, or no such file give none, and the leg is edited once, to
   the same USD price at worst. A newer plan's file does not count for a leg already in Summ. A leg uploaded from
   outside `plans/` is taken to hold what those files say. A user edit or a Summ repricing older than the history
   window Summ shows reads as holding that price. A leg with no `createdAt`, or from another source (Summ's own
   import), goes by the newest file, and only if marked USD;
3. otherwise none.

**Plan.** For a managed base leg, and an import's leg matched to a categorised row
of a swap (`bridge-trade-in`, `bridge-trade-out`), not a held row, not
a fee or quote leg:

| Run's reference price | Recorded price | Plan                                                                               |
| --------------------- | -------------- | ---------------------------------------------------------------------------------- |
| set                   | the same       | nothing                                                                            |
| set                   | other, or none | a `price` edit, or an override (below)                                             |
| blank                 | set            | report `price-blank`: an edit cannot give the price back to Summ, the user decides |
| blank                 | none           | nothing                                                                            |

Prices are compared as the numbers the CSV and the log hold, with no
tolerance. Every price comes from a stored Midgard record, so a replay gives
the same number, and a difference is a real change.

A price that is not the sync's is drift, handled as in Drift and overrides: the
user's price is kept and captured as `undecided`, and the decision holds for
that local price. Prices go by the leg's local price rather than by history and
log values, since the history is a window: a decision is kept, or applied, while
the leg shows the price it was made on, and a different price is captured again.
A price is not the sync's when:

- the leg no longer shows the `after` of its latest line (a user's edit, an undo,
  or Summ repricing the leg);
- with no line standing, the leg's price is not the one an override was decided on;
- with no line standing, the action's history has more `user` than `undo` `Price`
  lines than the sync has edits (`intent` lines) of the action's legs. The history is per action,
  so another row's edit in the action can count here too; and since the log is
  whole and the history a window, a user's edit can go unseen on an action where
  the sync edited another leg, and shows as an ordinary price edit in the plan. An
  edit the user made and undid is not drift. Deleting a price override asks again
  only while the history still shows the edit.

An edit that failed still counts as one of the sync's, since it may have landed, so
a user's edit of that leg before the next plan shows as an ordinary price edit in the
plan rather than an override.

A line with no `after` (unconfirmed, or a crash after the `intent`) proves nothing: unless one of these
holds, the edit is made again. A `no` is applied whenever the leg shows the price
it was decided on, including after an undo back to that price. The override's
`run` is in USD and its `summ` in the local currency.

A row planned for delete and upload gets no price edit: the upload carries its
price.

A row dated before `filedBefore` is an amendment, like any other edit: it
needs `--approve-filed`.

**Trades.** A price edit must not part a disposal's proceeds from the cost base of what
it bought. Summ values each leg apart: an upload of a sell gives the two sides one value
when it has no market price for the quote, and an edit of one leg leaves the other where
it was.

| The row                                                                              | Plan                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One row with a quote leg (a sell), its quote without a market price                  | one entry, two edits: the base leg's USD price, then the quote leg, so both sides hold the same value                                                                                                     |
| One row with a quote leg, its quote with a market price                              | the price edit is held (`held`, kind `price`), awaiting a test of what upload produces, and so is a row whose price stands with its sides parted, so that none stays parted unseen. Its other edits go on |
| Two rows of a swap, both managed                                                     | each its own price, from its own pool; the gap between them is what the swap cost                                                                                                                         |
| A managed row and the import's leg of its other side, or two imports' legs of a swap | the import's leg takes its categorised row's USD price, in one edit with its category if that differs too                                                                                                 |

Other categorised rows keep Summ's market price, and so does an import's fee leg. An
import's amount and fee are never edited. Its leg follows the same recorded price and
override rules as a managed leg, and is planned under categorise, so it waits as a
categorisation does while the plan has uploads. A partial snapshot allows it only as above (State dir, Pull).

A quote has no market price when Summ's action says so: the quote leg's
`currencyIdentifier.source` is `unknown`. Anything else, an older copy with no source too,
is taken as having one.

**The second edit.** Summ converts USD at its own rate, so the sell's local value is known
only once it is read back. So the entry's `match` names the quote leg, and apply edits it
second: local price = base price × sold amount ÷ quote quantity, with no price currency. A
sell paying its fee in the asset sold holds the fee in its quantity, and Summ values what it
bought at the net amount, so the sold amount is the base quantity less a fee leg of that
currency. The edit adds no USD mark and leaves one the leg already has, which says nothing:
proceeds and cost base go by `price`. `match.desired` is that price when the base leg
has no edit to wait for, and otherwise null. A sell paying its fee in the asset bought is not covered: Summ
values it as the price times what was bought plus the fee, and the sync would read it as parted; such a row
with an unknown quote or a standing price needs this added first.

A row's quote leg is compared with its base leg by value, price × the amount above, after any
quantity edit in the entry, within `1e-9` of the value: float noise, as an upload's two
sides differ by. No recorded figure comes into it, so a row repaired by hand, whose sell
has a standing price and whose buy holds its value, plans nothing, and neither does a
row after its apply. A quote leg holding the base's value follows a new price on the base leg, whoever set it. When its base leg's price is not the sync's (an override, or drift), the
quote leg is left alone. A row with no reference price, or no quote amount, plans no second edit.

A quote leg's price that parts the sides is the user's when the leg no longer shows its own
`after`, or when with no such line standing, an override exists on another value or the action's
history has more `user` than `undo` `Price` lines than the sync has edits of the action's legs. It
is kept and captured with `leg: "quote"`, as in Drift and overrides, and the sell's own edit goes
on. Its `run` is the local price that would match, null when only the base's edit would tell. Its
log lines hold the local price in `value`, with `local: true`.

`plan.md` lists price edits apart from the other edits, an import's leg marked so, largest leg value
first, each with Summ's price, the USD price and the rate between them
(Summ's price ÷ the USD price), and heads the list with the legs whose rate is
furthest from the median of the list. Most of the list differs only by FX and
Summ's coarser prices; those at the head are the ones to read (a frozen or
thin pool, or a Summ price from another market). Below them, each two-leg
entry is one line, with what the sell and the buy get.

## Plan

`plan` writes `plans/<timestamp>/plan.json` (machine-readable, the input to
`apply`), `plan.md` (for review) and `upload/`. It changes nothing in
Summ or in the state dir: `apply` adds the legs the plan adopted and the
overrides it captured to `adopted.csv` and `overrides.json` as they are
then (not on a dry run), so a plan that is never applied changes nothing
later plans assume, and an override edited by hand after the plan is kept. Each change names the row `ID`, the leg `_id`, the field, Summ's
value and the desired value. Each delete holds, for its legs and for every other
leg sharing their actions, the leg's values (`side`, `trade`, currency, quantity,
timestamp, source, import type, row `ID`, from, to, blockchain, description, price, the fee
held on the leg, comments), and its row's txids. `plan.md` shows each of those legs, one line each, and whether it
is deleted, deleted by another entry, stays, or stays and is ignored as made up. Apply compares them
(Deletes below). A delete with no txids (no row, and no txid in its legs' descriptions: usually an old ID)
is marked `no txid`: there is nothing to look for, so a manual entry naming it cannot be seen, and only one
in its action stops it.

| Section    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Applied as                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| delete     | managed legs with no row in the run; managed legs whose row changed in a field an edit cannot set (description, ID) or whose action shape changed; a fee leg the row no longer has                                                                                                                                                                                                                                                                                                                                                                                                                            | bulk delete by action id, after splitting a leg off an action whose other legs stay; only with `--approve-deletes`                                                 |
| edit       | managed legs whose row changed only in editable fields; managed base legs whose reference price is not the recorded one, and the quote leg of a sell Summ cannot price (Prices above)                                                                                                                                                                                                                                                                                                                                                                                                                         | `edit_transaction` per action                                                                                                                                      |
| upload     | rows with no leg in Summ after the deletes, per CSV file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | files written to `plans/<timestamp>/upload/` (the file's header and those rows as the run wrote them; filed-year rows in `<file>_filed.csv`), uploaded by the user |
| categorise | categorised rows whose Summ leg differs in type; an import's leg of a swap whose reference price is not the recorded one (Prices above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `edit_transaction`                                                                                                                                                 |
| superseded | extra rows a run row exports itself (Extra folders above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | nothing: their legs adopt to the run row                                                                                                                           |
| report     | categorised rows with no or several matching legs, or whose fee differs from Summ's (not edited); legs of a tx Summ holds twice beside the one a row matched (`duplicate-leg`); extra rows that share a txid, side and currency with run rows without being the same row (`extra-overlap`); legacy legs that fit several rows, or that look like an unmatched row (`legacy-lookalike`); managed rows whose ID Summ holds under a source not in `managedSources` (not uploaded again); managed rows Summ paired with a leg no row of their event names (`foreign-pair`); manual entries repeating a row's txid | nothing: for the user to resolve                                                                                                                                   |
| held       | rows the plan leaves alone (Held below), with what it left out; a price edit held (Prices, Trades)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | nothing                                                                                                                                                            |
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
  row in the run whose action holds a manual entry, or whose txid a manual entry
  names, are not deleted either. A manual entry names a txid in its description, its comments or its Tx Hash.

  The user resolves the pairing in Summ, or the run, and plans again. Or the user names the entry in `deleteManualEntries`
  (below): a manual entry never goes without being named.

**Decisions.** The plan compares Summ with the run row by row, so it cannot tell that an old trade it deletes was what a
kept entry sold from. `decisions.ts` reads the finished plan (after `--only`) and says what its deletes leave behind, as
the first section of `plan.md`, and in `plan.json` as `decisions` and `checks`. It changes nothing in the plan, and apply
does not stop on it: apply prints how many are open. Most old legs hold no txid, so legs are linked by currency, amount
and time: strong for exact amounts, not proof, and each decision says so. No gain is computed: Summ's own figures show the
effect after a recalculation.

A leg is _added back_ by a row this plan uploads, or a kept leg that counts, with the same currency and amount within a
day, or about the amount (within 1%, a fee apart) within 5 minutes. A row uploaded with the same amount under another
ticker within 5 minutes counts too. Each row side or kept leg adds back one leg, the nearest first: disposals, then acquisitions, then plain receives, each in time order. What counts
goes by type. For a disposal: a type that disposes, not a send, bridge, failed send, fee, approval, or a move into staking,
collateral, a position or a repayment, whose treatment is Summ's. A kept leg goes by its type after this plan's edit or
categorisation, and not by what the run has, since an override or a scope can keep its type. For something coming in: anything
but spam or a failed receive; a kept plain receive only with no send kept beside it, and a row's only with no send of the same going ahead or kept
within 5 minutes, since it is then half of a transfer. A held row adds nothing, nor does a row outside the scope, a made-up or
ignored leg, a fee leg, or a bridge's quote, which only names the other asset. A decision is opened by:

- a disposal removed with nothing to add it back: its gain or loss goes;
- a removed incoming leg with nothing to add it back, when a kept manual leg sends on the same currency and amount, from 5
  minutes before to a day after: it disposes from nothing, a false gain;
- a row going ahead whose type acquires what a kept manual leg of an acquiring type also holds, within a day: acquired twice.

What is linked to it joins one decision per event: deletes moving the same amounts within 5 minutes, rows naming them within 5 minutes, rows that add them back, every row their txids chain to, manual legs of those amounts (within a day of a delete or a row, within 5 minutes of
another manual leg) with the rest of their actions, and manual legs those rows are held for or whose text names their txids. A
manual leg joins one decision only. An old trade whose sold side is a row of the run, while the rows' incoming side has neither
its bought currency nor its amount, is shown as a changed swap. The decision also says when rows are held while deletes of the
same event go, why when they name no txid, when an override keeps a row's type, and which entries named in
`deleteManualEntries` go beside it.

Each decision has two options, each with the config to add to `summ-sync.json` before planning again:

- **a**: with manual entries, the run is right and they were stand-ins: every manual leg the plan would otherwise hold the entries
  for (fee and ignored legs of their actions, legs naming their txids), for `deleteManualEntries`. It says when they span filed
  and current years, which a plan takes one kind at a time. With none, the plan is right: nothing to add.
- **b**: keep what Summ has: a `hold` on each of its deletes, by row ID or old ID, and on each of its rows going ahead, which
  would otherwise count the event twice. A hold on an old ID with legs in Summ gives no note.

A decision is filed by the entries option a names, or with none by its legs.

`decide <state dir> <plan dir> d1:a [d2:b ...]` adds what the options name to `summ-sync.json`, all or none, leaving what is
already there, and prints what the next plan does. It refuses a choice the plan does not have, a decision chosen twice, filed and current-year
entries together (with those of the same option, or with those the plan already deletes), a plan not from the latest snapshot or with a write to Summ since it, and a plan not made from
`summ-sync.json` as it is now (`plan.json` holds its `configSha`): a decision's number means something only in its plan, so after
a choice, plan again before choosing more. It writes nothing to Summ: the entries still go through a plan and apply's approvals. Apply refuses a plan whose `configSha` is not the config's now until that plan has written, so that a choice is not overtaken by an older plan. To undo a choice, remove the lines from `summ-sync.json`.

Or neither: change the entries in Summ or the run, then pull and plan. `checks` lists the other removed acquisitions, a named manual entry's included, with nothing to add them back that have kept outgoing legs of that asset within a week: nothing links them but the asset. An
agent or a person decides; a plan never picks.

**Filed years.** An entry whose row or leg is dated before `filedBefore` is
an amendment: listed under its own heading in each section and applied only
with `--approve-filed`, in a separate apply from the current year. Under that
heading the plan says that a change there to an amount, price or type also moves the cost bases of later
disposals of those assets, in later years and the current one, once Summ recalculates.

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
description, and also when their description names a txid of a row in scope
(the same tx: stale legs that would otherwise sit beside its upload).
Unless an entry is their ID in Summ, legs that also name the tx of a row
outside the scope that the full plan uploads are not deleted, and the rows
of the scope and other legs with no row naming that tx wait with them, as
do the scope's rows and legs naming any other tx of theirs (nothing of
theirs is carried: no delete, edit, upload, categorisation, adoption,
superseded row, held entry, report or override), each noted: deleting the
legs would drop that row's side from Summ until its own plan uploads it,
and uploading beside them could hold a side twice, so a scoped apply leaves
the tx as it is until the scope takes the other row too. Legs an entry
names by their ID in Summ are deleted all the same, with a note when their
tx waits or names a row outside the scope that the full plan uploads. A row
outside the scope that Summ already holds, or that Summ imports itself,
loses nothing, so it does not stop the delete. Held entries with no row are
listed when the scope matches their legs, without this check (nothing is
deleted). The plan is made from the whole run, as without `--only`, then
keeps only what concerns the rows in scope: their deletes, edits, uploads,
categorisations, adoptions, superseded extra rows, held entries, reports (a
report with no row when it names one in scope) and overrides; and the
deletes and held entries of legs with no row in scope. So a decision on a
row outside the scope, such as `retainUserEdit: "no"` on a value that is
set back only together with the full run's deletes and uploads, waits for a
plan that covers that row, and an apply of the scoped plan cannot carry it
early. A categorisation in scope whose event (rows linked by a shared txid)
has an upload this plan does not carry waits too, and is noted, so that
Summ can pair its leg with the uploaded row (Apply below). It waits only
for its event's uploads, not for every upload of the run as apply does, or
a scoped categorisation would wait for the whole run; a categorised row
linked to its upload by no txid (a placeholder outbound) needs that row in
the scope. `plan.json` records the entries (`scope`) and the file
(`scopeFile`); `plan.md` lists the entries, counts the rows in scope
(`scopedRows`) and notes each entry that matches nothing. The other counts
of rows, legs and matches still cover the whole run: the plan matches every
row as usual, so a row out of scope is never uploaded or deleted for want
of its neighbours.

## Apply

An apply can always go on from where it stopped, and stops rather than guesses. Run the
same command again after any stop. In this order (a read, query or inspect, that fails with
a server error (5xx) is first retried once after a pause, in pull too; a write never is,
since it may have been made before the error):

1. Take `<state dir>/.lock` (exclusive create, holding the pid). A lock whose process is
   dead, or with no pid, is cleared; a live one refuses. A dry run neither takes it nor
   logs anything.
2. Check the plan may start or go on (Refusal below), and log `apply-start`.
3. Deletes (approved), each a state machine (Deletes below).
4. Edits and categorisation, each classified (Classifying below). All changes of one
   action go in one `edit_transaction`. A price change sends `price` with
   `priceValueCurrency: "USD"`. An entry with a `match` then makes its second edit
   (Classifying below), read and written as an edit of its own.
   Then each made-up leg of the row is read by its id, waiting a few seconds for Summ to
   split it off, and ignored by its action id, only when that action holds nothing else.
   Already ignored: done. Gone: done if this plan logged its ignore, otherwise stop. No
   longer a made-up leg: stop. Still sharing: left as it is, reported in the run's output, and logged
   with a `skip` line naming it (`leftLeg`), and the run goes on, since its entry's own write stands.
   The leg stays counted on its own until it is ignored. Every later full plan reports it, and a scoped plan when its row is in scope (`made-up-left`,
   with its row, if any, and why), whether a delete or a categorise left it, for as long as the pull finds it
   in Summ and not ignored; pull reads its action by the leg's id for that. A leg outside a pull's range is not
   seen, as the range's limits say. Older `skip` lines name no leg and are not reported. An undo handle cannot be relied on to back
   out of this: once Summ re-pairs the categorised leg with another (e.g. an uploaded
   bridge-trade-in), the edit's handle is stale.
5. Only when every entry is done: add the plan's adoptions and captures to the tables
   (idempotent), log `apply-stop` with `reason: complete`, and print the upload files,
   unless a row in them waits on a delete (Uploads below).
   A finished plan run again reports that it is complete and does nothing.
6. Write the journal as it goes (below): each call, its result and its undo
   handle, one line per changed field (`legId`, `field`, `value`) for
   plan's drift check and recorded prices (the line after a price edit holds the
   local price read back, `after`; its value is in USD).

**Reads.** Every look-up is `inspect_transaction` by `transactionId` (the leg's `_id`), which
returns the action holding the leg now, whatever its id has become, with no search lag. Only
Summ's own error for that very leg, `Transaction '<id>' was not found`, means the leg is gone.
Any other failure is a failed read: the run stops, and that says nothing of the leg.

**Classifying.** Every entry, on every run, by a fresh read of its legs:

| The legs hold                                                          | Then                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| all the plan's before-value, and the action's other legs are unchanged | proceed                                                     |
| all the after-value                                                    | done: counted, logged `call: found`, `via: found`, no write |
| anything else, including some at one and some at the other             | stop and report what was found                              |

The other legs are compared with the plan's snapshot: which legs are there, and their trade,
currency, quantity, timestamp, from, to, blockchain and price. Legs this apply itself changes
or moves are left to their own entries, and Summ-made `assumed-fee` legs have no lasting id.

A USD price cannot be read back in USD, so a price change is classified on its local price:

| Local price                                                                                                      | Then                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| a value this plan confirmed earlier (`after` in the log) still stands                                            | done                                                                   |
| differs from that confirmed value                                                                                | stop                                                                   |
| equals the before-value                                                                                          | proceed: re-sending is harmless, and an edit can really change nothing |
| differs, an intent logged for this plan, marked USD, `updatedAt` later than the leg's in that intent's pre-image | done; its `via: found` line holds `after`                              |
| differs, otherwise                                                                                               | stop                                                                   |

An entry's `match`, the quote leg of a sell, is classified after its first edit is settled, from
a fresh read, so a stop between the two edits goes on by doing the second:

| The quote leg                                                            | Then                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| holds the base leg's value (Prices, within the tolerance)                | done; a line with `after` if this plan logged an intent |
| holds the plan's price, the action's other legs unchanged                | edit it                                                 |
| anything else; or a `match.desired` the base leg's value no longer gives | stop                                                    |

A price found done gets a line in the shape of the one after a price edit, so plan reads the
same recorded price. An entry found at its after-value with no intent logged is not recorded
as the sync's own edit, so it is not taken for one later.

**Deleting a manual entry.** A manual entry can be the user's stand-in, so the sync deletes one only when the
user names it in `summ-sync.json`:

    "deleteManualEntries": [{ "legId": "<leg>", "currency": "BTC", "quantity": 0.1, "reason": "<why>" }]

Plan refuses a named leg that is not a manual entry, or whose currency or amount differ. Pull reads a named leg's action
even when nothing else needs it; a named leg not in the snapshot gives a note, so its line can be removed. Named legs of
one action are one delete entry, first in the plan, whatever `--only` says (a note says so), with the reason, values and
comments in `plan.md`, and a warning if Summ's matcher changed the action: such an entry may be guarding a pairing. The
entry's txids include those its comments name. It is filed if any of its legs is.

Only an entry that will go excuses anything. Another manual entry in its action or naming one of its txids, or a `hold` on
its ID, its txid or a row of its txid, leaves it held, and its event held with it, along with every other named entry: one that cannot go keeps them all until it can. Plan refuses filed and current-year
entries named together, since a run covers one: name one kind, apply, pull and plan, then the other. A run that would leave a named entry in Summ stops before writing anything: it needs
`--approve-deletes`, and `--approve-filed` for a filed entry, while one already gone stops nothing. Named entries run as
any delete: a split from what stays, a fresh read compared with the plan, two reads that agree, the journal and the
pre-image. Any other manual entry still holds its event in the plan and stops apply. Summ has no undo for a delete; a
pre-image is what it can be entered again from.

**Manual entries.** Before a delete entry's split, and before the reads that agree on its
delete, apply lists the actions holding a manual entry (`importType` filter, every page) and reads
each. A manual entry naming one of the entry's txids (the row's, or with no row those its legs name)
stops the entry. An edit or categorisation with txids checks the same, against one list read for the
run's edits. A list stays good until the run's next write. Every page is read, and the actions must
reach its `total`. An answer that is neither a list nor Summ's own empty answer (`0 total` and "No transactions
found matching your filters."), or an action listed with no manual entry in it, stops. Any manual entry in the action of a leg to delete stops too. A plan
holds back an event with a manual entry it can see, so these are the ones added since the pull.

**Deletes.** Before anything else, a plan whose delete holds no values (made by an older version) is
refused when deletes are approved, dry run too: pull and plan again. Every read of a delete's legs
is compared with the plan, and any difference stops the entry before its next write:

- each leg's row `ID`, currency, quantity, timestamp, source and import type, always.
- its `side` and `trade`, unless it now reads ignored and this plan logged its split, even by intent alone
  (a crash can lose the result); a fee leg then reads outgoing. A leg not ignored is compared whatever was logged.
- its from, to, blockchain, description, price, fee on the leg and comments (a hand edit a delete would lose),
  unless it reads ignored and the split's result line shows the split landed.

- any leg in the action the plan does not name: a partner Summ paired after the pull, or a made-up
  leg. It is neither split from nor ignored. Allowed: legs of this apply's other deletes and their
  made-up legs, and Summ-made `assumed-fee` legs, whose ids do not last.
- each named other leg still there: its identity fields and `trade`; a named leg that has left.
  After a split in that action by this plan, its `trade` and its leaving are not compared, as
  Summ may retype or re-pair what stays.

A leg's action is read by its `_id`; no filter chooses what is written. Then, by what the read shows,
and read again after each step:

| The legs                                 | Then                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all gone, a delete logged for this entry | done                                                                                                                                                                                                                                   |
| all gone, none logged                    | stop                                                                                                                                                                                                                                   |
| some gone, some not                      | stop                                                                                                                                                                                                                                   |
| sharing an action, not ignored           | split: one `edit_transaction` per action sets the entry's legs in it to `ignoreIn` (incoming) or `ignoreOut` (outgoing, fee), and Summ moves them to an action of their own. Once per leg in a run; a leg not ignored after that stops |
| sharing, ignored, its split logged       | wait a few seconds, up to five times, then stop, naming the undo handles; the legs stay ignored and no longer count                                                                                                                    |
| sharing, ignored, no split logged        | stop: an edit to the same type would not split it, and the ignore is not the sync's                                                                                                                                                    |
| alone                                    | two reads, a few seconds apart, must agree on the action ids and their legs; then delete by action id                                                                                                                                  |

A bulk delete removes whole actions. What guards that is the `alone` row: no action is sent unless
the read just before shows it holds only the entry's legs. A leg joining after that read would go with
it, and only `Bulk delete removed N` shows it: N must equal the entry's legs, or the run stops.

Never by a filter. A receive or send Summ made up to pair the deleted leg as a transfer (Made-up
legs above) is named on the split's lines (`madeUp`), since nothing else names it once the leg is
gone, and is then ignored as in step 4. Summ cannot undo a delete; a deleted row comes back by
uploading its CSV line again, and its pre-image (Journal) shows what Summ held.

**Uploads.** A row both deleted and uploaded by the plan (a remake) must not be uploaded before
its delete: Summ would hold the new version beside the old, and count its disposal or income twice.
The same can hold for a delete with no row, whose new version carries another ID. So apply prints no upload
list while any delete it selected is not made: not on a run without `--approve-deletes` (also when it reports
that plan complete), a stop or a signal. It says not to upload, and what to do next: run with the flag, or again,
and pull and plan if refused. A dry run has made no delete: with the flag it says what a live run would then
list; it never tells to upload while a delete is to come.

**Results.** Summ reports a wrong id as a success that did nothing, so every result is checked and
every write read back. `Patched N`, `Bulk delete removed N` and `Bulk ignore updated N` must report
the legs or action sent; an edit's and an ignore's must name affected actions. A quote leg's second edit
must read back at its local price. Then a read of the
ids the result names (several tries, seconds apart) must show the legs at their new values; a price
must show `updatedAt` moved and the USD mark, and its local price goes in the log as `after`, null when
unconfirmed. A delete's legs must read as gone. Anything else stops the run, as does a write that
fails. A failed write is never retried in the same run: the next run classifies the leg.

**Refusal.** There is no flag past these; the way on is to pull and plan.

- First start (no `apply-start` for this plan): the plan's snapshot is the latest, and the log has
  no write since its `takenAt`.
- Resume: the same snapshot is still the latest, `planSha` (the hash of `plan.json`) equals the logged
  `apply-start`, and every write line since `takenAt` belongs to this plan's runs (its `plan`, and a `run`
  one of its `apply-start` lines has).
- Flags (`--approve-deletes`, `--approve-filed`) bind once the plan has a write line: other flags are then
  refused, on a complete plan too. A plan that has written nothing can run with other flags, so one run
  without its flag needs no new pull.
- Complete: a plan that completed under these flags reports it and does nothing, whatever the snapshot.

A write line is any line but `skip`, `found`, `apply-start`, `apply-stop` and `torn-line`. So a failed read,
which logs only `apply-stop`, blocks nothing, and a failed write, which logs an `error` line, counts. An
`error` line of an older log counts as it did.

**Stops.** `apply-stop` carries a `reason`: `complete`, `signal`, `conflict`, `bad-result`, `read-back`,
`write-failed` or `error`, with what was found. A hard kill leaves none; the next run needs none.
The first SIGINT or SIGTERM says it is waiting, finishes the steps of an entry this run has begun to write
(split, delete, ignore, and both edits of a sell), writes `apply-stop` and exits 130. A delete entry with no split yet in this run
stops before its split or its permanent delete. A second stops at once, which is as safe as a crash.

What a resume cannot tell: a user's edit in the moment between the read and the write is overwritten
(the read and the write are not atomic; the pre-image and the change history keep it). A crash during a USD
edit is inferred, so a hand edit after it, marked USD, with no confirmed `after`, reads as the sync's. A
leg joining an action between the last read and its delete is seen only in the removed count, after the fact.
`updatedAt` moves on Summ's rebuilds too.

**Journal.** Every write to Summ (split edit, delete, edit, ignore), in this order:

1. Read the action fresh. An action not read since an earlier write of the apply
   is read again, as with the second action of a split.
2. Save that read, the full action and its change history, as a pre-image:
   `plans/<plan>/pre/<entry>.<step>.json`, through a temporary file and fsynced. It
   always holds this read. It never replaces a file: if the name is taken (a stop
   between this step and the next) the new read goes to `<entry>.<step>.2.json`.
   `<entry>` is the plan's section and index (`delete-3`, `edit-12`, `categorise-4`),
   `<step>` one of `split-<n>`, `delete`, `edit`, `match`, `ignore-<n>`.
3. Append an `intent: true` line to `apply-log.jsonl`, fsynced: one per changed
   field for an edit, one for a bulk call.
4. Make the call.
5. Append the result lines. A call that throws may still have landed: it gets a line
   with `error`, then apply stops.
6. Check the result and read the write back (Results above).

Write lines carry `entry` and `pre` (the file, relative to the state dir); a `skip`
line, only in older logs, carries `entry`. Lines of a delete or an ignore have `legIds`, not `legId` and
`field`, and an `error` line has neither, so plan does not read them as edits.
A pre-image holds the action the write addresses. An action Summ pairs a leg into as a
result is not saved. An intent counts as the sync's own value even if its call failed,
since it may have landed.

A stop therefore leaves a pre-image with no line (no write made), an intent with no
result (the write may have been made), or a last line cut off. Every reader of the log
leaves out a cut-off last line (one with no newline that does not parse); a bad line
anywhere else stops the reader with a message. The next apply moves the fragment to a
`torn-line` line of its own before appending. All of a run's lines carry its `run`.
An intent counts as a write for the refusal in
Refusal and as the sync's own for drift: its value in Summ is not taken for the user's.
Prices count `intent` lines of the `price` field only, so each edit counts once.

A delete's pre-image also holds the row's exact line (`line`, `lineHeader`, `lineSource`:
`run:<file>` or `upload:<file>`), found by the ID the legs carry and then the row's,
in the run's wallet files and then the plan's upload files; all null when none has it,
which stops nothing. A remade row's line is the run's version, which can differ
from what Summ held; the pre-image's action is the record of that.

Logs and plans from before the journal keep working: their lines have no `entry`, `pre` or
`run`, and count as they did.

While the plan has uploads (for the years this apply covers), apply holds
back categorisation: Summ pairs a categorised leg with the other side of
its swap only when that side is already in Summ, so the user uploads first
and runs pull, plan and apply again.

An apply carries out the current years' entries, or with `--approve-filed`
only the filed years'. `--dry-run` classifies every entry with read tools only, reports all
it would stop at, and writes nothing.

Then `pull` and `plan` again: the plan should be empty, apart from what the
upload adds once done.

Summ may pause its automatic calculation after uploads and edits (Summ's
computation status is `requires-refresh`); until the user recalculates,
gains, cost bases and reports show the figures from before the change. The
sync compares the rows' fields and recorded prices, not value or gain, so its
plans are unaffected, but any tax figure is read only after a
recalculation (which is safe: it changes no transaction).

## Not done here

- Creating rows through the MCP (see above). Revisit if Summ's MCP accepts
  custom currencies, an ID and a description.
- Pairing legs. Summ's own matching pairs them; an unpaired leg shows as a
  report entry (Summ's `unmatchedTransfer` warning).
- Gains, and prices of categorised rows' legs other than a swap's (Summ's own imports).
