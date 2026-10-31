# skeletax

Formerly called "thorchain-cryptotax".

Exports the activity of your THORChain and Maya Protocol wallets as CSV files
for [Summ](https://cryptotaxcalculator.io/?via=glaj5hf5) (formerly Crypto Tax
Calculator), in its advanced CSV format.

It maps source data (Midgard, THORNode, Viewblock, EVM receipts) to rows: what each wallet
sent, received, deposited and withdrew, and the fee it paid. It does not
price rows or compute gains: Summ does. Where a treatment is a tax choice
(e.g. the Maya liquidity auction), the config makes it, and each spec says
which values are observed on-chain and which are assumed.

## What's supported

- **THORChain swaps** (including streaming swaps with an unfilled part
  returned) and **refunds**: [fees.md](docs/specs/fees.md)
- **Swaps paid out through an aggregator** on Ethereum, Avalanche, BSC or Base
  (RUNE to ETH to a token): the row names the token that reached the wallet, at
  the value of what was sent ([activity.md](docs/specs/activity.md#aggregator-payouts)).
- **Liquidity** (add and withdraw): [liquidity.md](docs/specs/liquidity.md)
- **Savers**: [savers.md](docs/specs/savers.md)
- **Lending** (loan open and repayment): [loans.md](docs/specs/loans.md)
- **Sends and receives**, including income from configured senders and sends
  from before April 2022 via Viewblock: [sends.md](docs/specs/sends.md)
- **Bond and unbond, RUNEPool, TCY** (claim, stake, unstake, distributions),
  **THORNames**, and **switches** (BEP2 RUNE upgrade, KUJI):
  [activity.md](docs/specs/activity.md)
- **Synths, trade and secured assets**, and how every asset is named:
  [assets.md](docs/specs/assets.md)
- **Fees**: which fee goes on which row: [fees.md](docs/specs/fees.md)
- **Maya Protocol** (swaps, liquidity, refunds, sends), including the
  [2023 liquidity auction](docs/specs/maya.md#liquidity-auction-2023):
  [maya.md](docs/specs/maya.md)
- **Rujira**: staking (bond), FIN market swaps, merge deposit and withdraw:
  [rujira.md](docs/specs/rujira.md)
- **Periods and row IDs**: one CSV per wallet per period, in your time zone,
  with stable row IDs: [periods.md](docs/specs/periods.md)
- **Actions that are not final** (pending, stuck refunds):
  [pending.md](docs/specs/pending.md)
- **Run summaries** and comparing two runs:
  [run-summary.md](docs/specs/run-summary.md), [run-diff.md](docs/specs/run-diff.md)
- **Snapshots and offline replay**: every downloaded record is stored, so a
  run can be replayed without network access:
  [snapshots.md](docs/specs/snapshots.md)
- **Summ sync** (experimental): plans and applies the changes that make Summ
  match a run, through Summ's MCP server:
  [summ-sync.md](docs/specs/summ-sync.md),
  [packages/summ-sync](packages/summ-sync/README.md)

## Not supported yet

- Failed actions (only their fee moved): listed, not exported.
- Bond rewards; Maya bonding; CACAO yield paid to MAYA token holders.
- Fees paid on Maya inbound transactions.
- Rujira unbonding, staking revenue claims, FIN orders, BOW, GHOST and other
  Rujira contracts. Levana perps are discontinued: enter positions by hand
  ([rujira.md](docs/specs/rujira.md#levana)).
- The conversion of open savers positions to TCY in January 2025.
- Swaps sent in through an aggregator (a token swapped on a DEX, then into
  THORChain): THORChain only sees the pool asset arrive, so the row names that
  asset, not the token the wallet spent. Enter these by hand. Same for any
  aggregator swap on Maya.

Otherwise a run never drops what it can't map: each such action is saved under
`unsupported/` (or `failures/`) in the run's output folder and listed in its
`summary.md`.

## Run it

You don't have to run the commands yourself. You can ask a coding agent (e.g.
[Claude Code](https://claude.com/claude-code)) to clone this repo, set up a
config with your wallets, run the export and explain the output. Keep the
config and the output in a private folder outside the clone, so your wallets
never end up in the repo.

By hand:

1. Install Node at the version in [`.nvmrc`](.nvmrc) (`nvm install && nvm use`).
2. `npm ci --ignore-scripts`
3. Copy [`wallets-config.toml`](wallets-config.toml) to a folder outside the
   repo, e.g. `../my-tax/wallets-config.toml`, and add your wallets and dates.
4. `node src/full-export.ts ../my-tax/wallets-config.toml`

Output, cache and summary are written next to the config. Add `--offline` to
re-run from the cache without network access. Details:
[docs/nodejs-instructions.md](docs/nodejs-instructions.md).

## More

- [Using the CSVs in Summ](docs/summ.md): the two workflows (by hand, or with
  summ-sync), import, categorising other chains' transactions, missing prices
- [Contributing and support](docs/contributing.md): adding a transaction type,
  reporting issues, donations, references
- [Specs](docs/specs/README.md): the behaviour of every supported action
