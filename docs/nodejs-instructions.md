# Run using NodeJS

## Prerequisites

- Git
- Node 24 (the version in [.nvmrc](../.nvmrc); with nvm: `nvm install` then `nvm use`)

## Steps

### 1. Clone the repo

`git clone git@github.com:skelethorfi/skeletax.git`

### 2. Install the node packages

`npm ci --ignore-scripts`

This installs exactly the versions in `package-lock.json`, without running any package's
install scripts.

### 3. Configure your wallets

Copy [wallets-config.toml](../wallets-config.toml) to a folder outside the repo, e.g.
`../my-tax/wallets-config.toml`, and edit the copy. That keeps your wallets out of the
repo.

Add your wallet addresses, they can be given names using the `name` property.
Which is helpful to identify the wallets when looking at the generated CSV filenames.

Set `fromDate`, `toDate`, and `frequency` ("monthly", "yearly", "none") for how to split up the CSV files.
Set `timezone` (e.g. "Europe/London") so the periods follow your tax year in local time; the default is UTC ([periods](specs/periods.md)).

Every row gets a USD reference price from Midgard where one exists, including the LP and savers position tokens
Summ cannot price (`referencePrices = "all"`, the default). The first run fetches those prices, at one request a
second, and later runs read them from the store. Set `referencePrices = "swaps"` to keep the rows as before October
2026 (only swaps, bRUNE sells and TCY distributions carry one, and no price is fetched), e.g. to replay an earlier run
with `--offline`. See [reference prices](specs/prices.md).

The `blockchain` property for each wallet is only used in creating the CSV filenames, so it can be anything.
e.g. "THOR", "BTC", "ETH"

### 4. Run the export

`node src/full-export.ts ../my-tax/wallets-config.toml`

This gets all the transactions for the wallets and writes the CSV files to
`output/{current_datetime}/csv` next to your config (relative `outputPath` and
`storePath` values are relative to the config file's folder).

See [Using the CSVs in Summ](summ.md) for importing them into Summ (Crypto Tax Calculator).

### API endpoints

The default endpoints are in `src/config/apiUrls.ts`. To use others, set these
environment variables before running:

- `THORNODE_API_URL`
- `THORNODE_API_ARCHIVE_URL` (THORChain v1: tx statuses up to its last block, 2024-09-04)
- `MIDGARD_API_URL`

### What a run writes

Each run writes a folder under `outputPath` named by its start time, holding `csv/`,
`snapshots.json`, `summary.md` (how it ran, counts, and every warning it printed;
`docs/specs/run-summary.md`) and, when there are any, `unsupported/` and `failures/`. Actions the
exporter can't map yet are saved in `unsupported/`, one file per action, named like its
store record: `<type>/<type>.<txid>[.<contract type>].json` (another protocol's under its
own folder, e.g. `maya/`). So the folder lists exactly what that run could not map.
`unsupportedActionsPath` is no longer used; a config that sets it gets a warning.

### Re-running from the cache

Downloaded data is kept in the store (`store/` next to your config, or the config's
`storePath`), one file per action or tx, and a
record that comes back different later is kept as a new copy next to the old one
(`docs/specs/snapshots.md`). Each run picks the right copy of each record, e.g. a
finalised one over a pending one, and the earlier full copy over one THORNode has
since pruned. It lists what it used in `snapshots.json` in its output folder.

- Default: download each wallet's history again (new activity, changed actions),
  anything still pending, and anything not stored yet. Changed records are kept as
  new copies, and the run lists what changed.
- `--offline`: no network requests. Anything not stored is an error.
- `--refetch-all`: download every action and tx again, e.g. before filing a year,
  to see what the sources have revised or pruned since.
- `--replay <run folder>`: use exactly the records that an earlier run used, e.g.
  the run you filed.

`node src/full-export.ts --replay ../my-tax/tax2026/2026-10-03_15-33-50 ../my-tax/wallets-config.toml`

To see what changed between two runs, e.g. a replay on new code against the run it
replays, compare their folders. Each differing row is shown with the source records
that explain it, or `no record change` when the code or config made it differ; the
command exits 1 when any CSV file's rows differ (`docs/specs/run-diff.md`):

`npm run diff -- ../my-tax/tax2026/2026-10-03_15-33-50 ../my-tax/tax2026/2026-10-04_09-12-05`

A cache from before the store (`cache/` with one file per wallet or tx) is not read
by a run; while the store is empty, a run warns and prints the import command. Import
it into the store first; for several old caches, oldest first:

`npm run store -- import ../my-tax/store ../my-tax/tax2025/cache ../my-tax/cache`
