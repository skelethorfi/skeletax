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
   before you read gains or reports (see the steps by hand above).

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

Every row whose asset Midgard prices carries Midgard's USD price as a
reference price, which Summ uses instead of its own market price (swaps: each
side's own price). That covers what Summ cannot price itself:

- **Tokens it doesn't know**, e.g. VTHOR received in a swap from RUNE: the
  swap's own price for each side.
- **Liquidity and savers positions.** The position token has no market price,
  so the **Receive LP Token** and **Return LP Token** rows carry the value of
  what went in or came out, per unit. Each add or withdrawal also comes with a
  `Spam` price-helper row holding the same assets, which Summ prices itself,
  so its value can be compared with the token's.

Rows already in Summ keep the price they were uploaded with. Summ sync sets the
reference price on those it manages, listed apart in its plan
([specs/summ-sync.md](specs/summ-sync.md#prices)).

Copy a value by hand only where a row has no reference price: a token row
left blank (a Maya liquidity-auction position, one holding an asset Midgard
has no price for or a pool that was frozen, an action that is not `success`,
or a row of `all.csv` more than a day outside the run's periods) takes the
price helper's fiat value, and an unknown token outside a swap takes the
value of what it was exchanged for. With `referencePrices = "swaps"` in the
config only swaps (and bRUNE sells and TCY distributions) carry one, as before
October 2026, and every LP token needs the helper's value
([specs/prices.md](specs/prices.md)). The old CoinMarketCap price lookup and the `addReferencePrices`
wallet setting were removed; a config that still sets it gets a warning.
