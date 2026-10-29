# Using the CSVs in Summ

Summ (formerly Crypto Tax Calculator) imports the exporter's CSV files. Summ
prices the rows and computes the gains; the CSVs give the transactions.

## Two ways to work with Summ

**1. By hand** (the usual way):

1. Make a config for the year (a copy of [`wallets-config.toml`](../wallets-config.toml)
   with the year's dates and your wallets).
2. Run the export (`node src/full-export.ts <config>`, see the
   [NodeJS instructions](nodejs-instructions.md)).
3. Upload your THORChain (and Maya) wallet CSV files ([Import](#import)).
4. Categorise the related transactions of your other chains (BTC, ETH, ...) by
   hand ([Categorising transactions](#categorising-transactions)), and add the
   [missing market prices](#missing-market-prices).
5. Recalculate in Summ before you read gains or reports. Summ may pause its
   automatic calculation after uploads and edits, and until it runs, the
   figures are the old ones.

**2. With summ-sync (experimental).** Syncing with Summ is new: review every
plan, and expect changes. [`packages/summ-sync`](../packages/summ-sync/README.md)
compares a run with what Summ holds, through Summ's MCP server, and makes the
changes for you: it deletes and edits the rows Summ holds, writes upload files
with only the rows Summ lacks, and categorises the other chains' transactions.
The steps of a year's sync are in its README; the design is
[specs/summ-sync.md](specs/summ-sync.md).

## Import

1. Log in to Summ and go to **Integrations**.
2. Click **Add integrations**, search for **THORChain** and click it.
3. Click **Upload** and select the files.
4. Click **Import THORChain CSV**.
5. Once you have also categorised the related transactions, recalculate
   before you read gains or reports (step 5 above).

Import only your THORChain wallet CSV files
(`YYYY-MM-DD_YYYY-MM-DD_THOR_xxxxx_Sample.csv`), not the files of your other
wallets: those wallets are added to Summ through their own integrations.

This imports every transaction of your THORChain wallets: sends and receives,
swaps, liquidity, savers and lending. Upload Maya wallet files the same way,
under Summ's Maya integration (`mayachain`).

## Categorising transactions

THORChain is cross-chain, so most transactions span more than one blockchain,
and a THORChain wallet's file may hold only one side of an action. Adding RUNE
to a pool can come with a BTC add to the same pool from a BTC wallet; a swap
from BTC to ETH may not appear in any THORChain wallet at all.

Summ imports those other chains (BTC, ETH, ...) itself once you add their
wallet addresses under **Integrations**. Its imports don't know about
THORChain, so you categorise their transactions. The exporter writes a CSV
file for each of your other wallets too, and `all.csv`, with a description on
each transaction, e.g. `1/2 - Swap 1 BTC to 20 ETH; tx12345`: use them to find
what each transaction was.

Swaps are categorised in Summ as **Cross Chain Sell** (from your wallet to
THORChain) and **Cross Chain Buy** (from THORChain into your wallet). The CSV
files list them as `bridge-trade-out` and `bridge-trade-in`. Other actions are
categorised the same way, e.g. **Add Liquidity** and **Remove Liquidity**.

## Missing market prices

Summ cannot price everything:

- **Tokens it doesn't know**, e.g. a swap of RUNE to VTHOR. Copy the fiat value
  of the RUNE side (Cross Chain Sell) onto the VTHOR side (Cross Chain Buy).
- **Liquidity and savers positions.** The position token has no market price.
  Each add or withdrawal comes with a `Spam` price-helper row that holds the
  value of what went in or came out: copy its fiat value onto the **Receive LP
  Token** row (or **Return LP Token** for a withdrawal). The rows are described
  in [specs/liquidity.md](specs/liquidity.md).

Swap rows carry Midgard's USD price of each side as a reference price. Other
rows have none. The old CoinMarketCap price lookup and the `addReferencePrices`
wallet setting were removed; a config that still sets it gets a warning.
