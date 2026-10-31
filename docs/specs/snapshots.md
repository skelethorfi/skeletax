# Source data snapshots

A tax return rests on what Midgard, THORNode, Viewblock, the TCY endpoint and
the EVM chains' RPC endpoints returned when the data was fetched. That changes after the fact:

- THORNode prunes old txs, so a later fetch can come back without the tx or
  its gas.
- Pending actions and txs (an unfinished loan repayment, a refund, an
  outbound not yet sent) are later finalised.
- Midgard instances and revisions change old actions (the loan-open amount
  fix), and history gets archived (the 2022-03-22 `genesisTx` migration).

So the tool keeps every version of every record it has fetched. Each run
picks the right version of each record, and lists what it used.

## The store

`src/sources/store/RecordStore.ts`, under the config's `storePath` (default `store/`
next to the config, ignored by git in this repo). Several configs, e.g. one
per tax year, can share one store, because copies are only ever added:

```
records/midgard/2025/07/swap.192D…296D.0.json      an action's first copy, in its month (UTC)
records/midgard/2025/07/swap.192D…296D.1.json      a later copy that differs
records/viewblock/2025/07/192D…296D.0.json         a Viewblock tx, in its month
records/tcy/2025/05/<wallet>.1746566872.0.json     a TCY distribution, in its month
records/thornode/2025/07/192D…296D.0.json          a THORNode tx status, in its action's month
records/thornode-cosmos/2026/05/E703…6721.0.json   a Cosmos tx, in its block time's month
lists/midgard/<wallet>.0.json                      the record keys one fetch of a wallet returned
```

- The file name is the record's key, then `.<n>` (0, 1, …) for each copy: the
  copy number is always the last number, so a key may end in one (TCY's
  `<wallet>.<date>.0.json`). Copies beyond `.9` list out of order (`.10` before
  `.2`); that is cosmetic, as copies are ordered by fetch time.
  Letters, digits and `. _ + -` are kept; anything else is `%XX`, so the name
  decodes back to the key (a contract's `/` is `%2F`).
- A copy is `{source, key, fetchedAt, url, importedFrom, sha256, data}`; a list
  is `{source, wallet, fetchedAt, url, importedFrom, keys}`.
- The month comes from the record's own date (action date, tx timestamp,
  distribution date, Cosmos block time). A THORNode tx status has none, so it
  takes the date of the action it was fetched for; the importer dates old
  files by the stored Midgard action with that inbound txid. With no date at
  all, a record goes in `undated/`.
- A record's later copies stay in its first copy's folder, even if a revision
  changes its date, so a path never moves once a manifest points at it. The
  date only decides where a record is first filed: lookups use the name scan.
- A run finds every copy with one scan of the file names, so it doesn't need a
  record's date to find it. The scan refuses two keys that differ only in case,
  which macOS and Windows can't keep apart.
- Copies are ordered by `fetchedAt` (unknown, for copies imported from old
  caches, first, in import order), then by number. The number is only unique:
  an old copy imported after a newer fetch still counts as older.
- A new copy takes the next free number with an exclusive create, so two runs
  sharing a store never overwrite each other.

| Source                                          | Record                                                                                                                                      | Key                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `midgard`, `maya-midgard`                       | an action                                                                                                                                   | `<type>.<first txid>`; a contract action adds its event (one wasm call gives several); `<type>.date-<date>` with no txid; an action one tx gave to several members adds their addresses (`<type>.<txid>.<addresses>` for Maya's `donate:` adds, `<type>.genesisTx.<pool>.<addresses>` for old Midgard's placeholders) |
| `thornode`                                      | a tx status                                                                                                                                 | txid                                                                                                                                                                                                                                                                                                                  |
| `thornode-cosmos`                               | a Cosmos tx (contract calls)                                                                                                                | txid                                                                                                                                                                                                                                                                                                                  |
| `midgard-rune-price`                            | RUNE's USD price over a Midgard 5-minute bucket (liquid bonds of bRUNE, `rujira.md`; reference prices, `prices.md`)                         | the bucket's start (Unix seconds)                                                                                                                                                                                                                                                                                     |
| `maya-midgard-cacao-price`                      | CACAO's USD price over a Maya Midgard 5-minute bucket (reference prices, `prices.md`)                                                       | the bucket's start (Unix seconds)                                                                                                                                                                                                                                                                                     |
| `midgard-pool-price`, `maya-midgard-pool-price` | a pool's `assetPriceUSD` over a 5-minute bucket, or none (reference prices, `prices.md`)                                                    | `<pool>.<bucket start>`                                                                                                                                                                                                                                                                                               |
| `midgard-pool-swaps`, `maya-midgard-pool-swaps` | a pool's swap counts in the 24 hours before and after a 5-minute bucket (frozen pools, `prices.md`)                                         | `<pool>.<bucket start>`                                                                                                                                                                                                                                                                                               |
| `viewblock`                                     | a tx                                                                                                                                        | its hash                                                                                                                                                                                                                                                                                                              |
| `viewblock-tx`                                  | the gas THORNode observed for an inbound, from Viewblock's single-tx endpoint (`fees.md`)                                                   | txid                                                                                                                                                                                                                                                                                                                  |
| `evm-receipt`                                   | an EVM inbound's receipt, its fee fields (`fees.md`)                                                                                        | `<chain>.<0x hash>`                                                                                                                                                                                                                                                                                                   |
| `evm-payout`                                    | what an aggregator outbound delivered, or no token (`activity.md`, Aggregator payouts)                                                      | `<chain>.<0x hash>`                                                                                                                                                                                                                                                                                                   |
| `tcy-claim`                                     | what a TCY claim was for: the claiming address's claim-list entries, and its savers positions and loans from Midgard (`thorfi-collapse.md`) | `<claiming address>.<claim height>`                                                                                                                                                                                                                                                                                   |
| `tcy`                                           | a distribution                                                                                                                              | `<wallet>.<date>` (one a day; several wallets are paid on the same day)                                                                                                                                                                                                                                               |

An action or tx is shared: a swap between two wallets is stored once, and
both wallets' lists point at it. A TCY distribution belongs to one wallet, so
its key includes the wallet. One txid can have more than one action (e.g. a
send and a swap); type and txid tell them apart, and only
contract actions need their event. If two records of one wallet fetch ever
share a key, the run stops rather than merge them.

Type and txid are unique within one wallet's actions, but not across wallets:
one tx can give each of many members an action (Maya made LP positions for
many members in one `donate:` tx). Their keys add the members' addresses.
For a shape not known yet, the store checks a fetched action against the
stored copy: if they have no address in common, it is another member's
record under the same key, so the run stops with an error instead of storing
it as a new version (which a run would then use in place of the first).

- A fetched record is stored only if it differs from its latest copy. Nothing
  is overwritten or deleted.
- Before the comparison, each source drops fields that change on every fetch
  but are not source data: Viewblock's `usdNew` (value at today's price; `usd`,
  the value at the time of the tx, is kept), TCY's `apr` and `total`, and
  THORNode's `blocks_since_scheduled` for an outbound never signed (a switch).
- `npm run store -- import <store> <old cache or store>...` copies every version
  into a store, oldest first (a copy from an old cache has no fetch time, so
  the import order is the order of its copies). It reads old caches
  (`<source>/<key>.json` with a whole response), stores in the earlier
  folder-per-record layout (re-keyed), and stores in this layout. Each copy
  from an old cache has `importedFrom`, the file it came from. Identical
  copies are skipped. Old Midgard's `genesisTx` placeholder adds (positions
  that existed at its 2022-03-22 store migration) are left out: Midgard's
  archive has the real adds, and keeping both would count those positions
  twice. An old cache is not read unless imported: while the store is empty,
  a run that finds one (in the store folder, for a config whose `cachePath`
  still points at it, or `cache/` next to the config) warns and prints the
  import command.

## Which copy a run uses

Copies are compared oldest first. Each later copy becomes the one used, unless
it has less in it:

| Case                                                                  | Stored                | Used                                   | Manifest `choice`  |
| --------------------------------------------------------------------- | --------------------- | -------------------------------------- | ------------------ |
| One copy                                                              | –                     | it                                     | `only`             |
| Pending, then finalised                                               | new copy              | the finalised copy                     | `finalised`        |
| Pruned (THORNode lost the tx or its gas; a Cosmos tx lost its events) | new copy, as evidence | **the earlier, fuller copy**           | `kept-over-pruned` |
| Changed otherwise (a revision)                                        | new copy              | the new copy, and the run lists it     | `revised`          |
| In an earlier fetch of the wallet, but not the latest                 | –                     | the earlier copy, and the run lists it | `missing: true`    |

Revisions use the new copy (decided 2026-10-03): those seen so far are
corrections. A filed year is not affected, because it replays its own manifest.

## Run modes

| Run              | Fetches                                                                                                                     | Uses                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| default          | every wallet list again (new activity, changed or missing records), every record still pending, and anything not stored yet | the chosen copy of each record, with this run's fetches included                                                                                                               |
| `--refetch-all`  | also every finalised record again, THORNode and Cosmos txs included                                                         | the same                                                                                                                                                                       |
| `--offline`      | nothing; anything not stored is an error                                                                                    | the chosen copy                                                                                                                                                                |
| `--replay <run>` | nothing                                                                                                                     | exactly the copies in that run's `snapshots.json`, checked against their hashes; a source that run read nothing from (one added since, e.g. `maya-distribution`) gives nothing |

A finalised record (a THORNode tx, a Cosmos tx) can only come back revised or
pruned, and the store keeps the earlier copy either way, so a default run
leaves it alone. `--refetch-all` checks every record, e.g. before filing a
year, to see what the sources have changed since. A pending one (a stage not
completed) is fetched again on every run, until a finalised copy is stored or it
is stuck.

A THORNode or Cosmos tx is stuck when it is still pending `pendingStuckDays`
(config, default 30) after the date of the action it belongs to. A default run
stops fetching it again; `--refetch-all` still does. THORChain finalises in
minutes to hours (a streaming swap runs at most 14,400 blocks, about a day, and
an outbound waits at most 17,280 blocks), so a month still pending means it
never will: THORNode reports a tx it has pruned as not yet observed, and an
outbound that is minted rather than signed (a switch) is never marked signed.
Without the cut-off these were fetched again on every run, forever.

A wallet list is the wallet's whole history, because the sources page from
the first action, so a run sees new activity and changes to old actions in
one pass. A record shared by several wallets is fetched once per
run.

Midgard matches the `address` of `/v2/actions` exactly. EVM senders are
lowercase (THORNode observes them that way), and Midgard lowercases the other
EVM addresses of an event on a chain it treats as case-insensitive (ETH on
THORChain; ETH and ARB on Maya). Otherwise, e.g. an outbound on AVAX, BSC or
BASE for a swap from BTC, the address keeps the case of the memo that asked
for it, which is usually lowercase or the checksum (EIP-55) spelling. So an
EVM wallet (`0x` and 40 hex digits) is queried in its lowercase and checksum
spellings and as configured, `address=<lowercase>,<checksum>[,<as
configured>]` (Midgard returns an action that matches any; the checksum comes
from Keccak-256, `src/utils/Keccak.ts`). Queried as configured only, a
checksummed wallet got back just the actions spelled that way, and missed, for
example, its savers deposits and withdrawals on ETH. Other address formats
(base58 BTC, DOGE and LTC addresses) are case-sensitive and are queried as
given. What is fetched no longer depends on whether the config uses lowercase
or the checksum spelling, but the store keys a wallet's list by its address as
configured, and a period file's name includes the last five characters of that
address as configured. So to change a wallet's spelling anyway, change it in
every config that uses the store and move its old lists
(`lists/midgard/<address>.*.json`, and `lists/maya-midgard/…` if Maya is
exported) out of the store: two list keys that differ only in case stop the
run after the respelling. Replay an earlier run with the config it used. The
wallet then starts a list with no earlier copies (its records are kept), and
its file names can change. When the added spellings find actions a wallet
missed, the next run stores a new copy of its list, and its rows change: the
actions it missed are exported.

The rows of one EVM wallet can therefore carry either spelling. They are
grouped into the wallet's period files by the lowercase address, so both go
to one file (`src/export/summ/files.ts`).

Each fetch is retried after a transient error (HTTP 5xx or 429, a connection
reset, a timeout, a DNS failure), waiting 5 s, 20 s and then 60 s
(`src/sources/Retry.ts`). Requests to Midgard, THORNode and the TCY API go
through one client (`src/sources/http.ts`): at most one per second, and one
that hangs fails after 60 s. A run that
still fails keeps what it stored so far, and can be run again.

### Config names

- `storePath` (default `store/` next to the config) was `cachePath`. The old
  name still works, with a warning.
- `cacheDataSources` is no longer used, and a run warns if it is set. `true`
  used to reuse the cache, and `false` deleted it before each run; now every
  run fetches the latest data and keeps what was stored. Use `--offline` (or
  `--replay`) to fetch nothing, e.g. to re-run a filed year.

## The manifest (snapshot)

Each run writes `snapshots.json` to its output folder, with `layout: 3` (a
manifest from an earlier layout is refused, as its paths no longer exist):

- `records`: for each record used, the source, key, copy file (relative to
  `storePath`), `fetchedAt`, `url`, `sha256`, `choice`, the number of copies
  stored, `missing` if it was kept from an earlier fetch, and `fetched` if
  this run fetched it (`new`, `changed`, `unchanged`).
- `lists`: for each wallet and source, the record keys used, in order, and
  which of them were missing from the latest fetch.

The run prints a summary: records fetched (new, changed, unchanged), and
records finalised, revised, kept over a pruned copy, or missing. It lists the
records this run found changed, and those the sources no longer return; the
choices made on earlier runs are in the manifest. A manifest is the snapshot: it points only at copies that never
change, so `--replay` reproduces the run exactly.

## Filing a year (separate work)

To be designed on top of this: when a year is filed, keep its manifest as the
year's record (e.g. `filed.json`) and commit it with the store, so the filed
output can always be replayed. Several years' configs may share one store,
because copies are only ever added.

## Comparing two runs

`npm run diff -- <old run> <new run>` compares their rows and tags each
differing row with the record changes that explain it (`run-diff.md`).
