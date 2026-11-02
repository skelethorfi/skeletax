# Rujira

Rujira is THORChain's app layer: CosmWasm contracts on THORChain. A call is a
`MsgExecuteContract` signed by a THORChain wallet. Midgard reports it as a
`contract` action whose `metadata.contract.contractType` is the contract's
event (e.g. `wasm-rujira-staking/liquid.bond`).

## Data

Midgard reports only the **sent** side: `funds` (e.g. `100000000x/ruji` for 1 RUJI) and
the contract event's attributes. `coins` is empty on `in` and `out`. It does
not say what the wallet received, the gas paid, or the fees taken inside the
contract.

A denom names its asset in Midgard notation: a bare name is THORChain's own
(`rune` is `THOR.RUNE`, `tcy` is `THOR.TCY`), and other denoms are upper-cased
(`x/ruji` is `X/RUJI`, `btc-btc` the secured `BTC-BTC`).

So every contract action is paired with its **Cosmos tx** from THORNode
(`/cosmos/tx/v1beta1/txs/{hash}`), trimmed to the txid, height, result code,
fee and events. The `transfer` events give what the wallet received, and
`auth_info.fee` gives the gas. The exporter caches it under `thornode-cosmos`,
and a golden case carries it as `cosmosTxs`.

Rujira's own GraphQL API (`api.rujira.network/api`) has the current staking
and merge positions and per-account FIN history. It is useful for checking a
run, but it is not a source of rows. The Rujira SDKs (`rujira.js`,
`@vultisig/rujira`) build txs and fetch quotes. They give no history.

## Fee

The fee is the Cosmos tx fee in RUNE (`auth_info.fee`). A wasm call does not
pay THORChain's 0.02 RUNE native fee: it pays gas, which is about 0.00003 RUNE
for a bond and about 0.2 RUNE for a FIN swap. Without a Cosmos tx the fee is
left blank.

Fees taken inside a contract (FIN's taker fee, Levana's trading fees) are
already netted from what the wallet receives. As for swaps (`fees.md`), they
are not exported as fees.

## Rows

A trade made inside one THORChain tx (a liquid bond, a FIN swap) is one `sell`
row. Summ values a trade from whichever side it has a price for, but it joins
a `bridge-trade-out` and a `bridge-trade-in` into one trade only when it can
price both: a pair with an unpriced side (bRUNE, sRUJI, ybRUNE) stays two
actions, and the received side is booked at zero, with no cost base. The pair
is for a THORChain swap, whose L1 side Summ imports itself. Merges still use
the pair; a merge position has no price, so set its prices in Summ.

| Contract event                                                | Rows                                                                                             | Amounts                                                                | Why                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `wasm-rujira-staking/liquid.bond`                             | one `sell` of the bonded asset (`RUJI`, `BRUNE`) for its receipt token (`SRUJI`, `YBRUNE`)       | sent: `funds`; receipt: the `shares` attribute                         | The asset goes into a shared pool and the wallet holds a different, transferable token instead (see Liquid and account bonds) |
| `wasm-rujira-staking/account.bond`                            | one `staking-deposit`                                                                            | `funds`                                                                | The asset stays the wallet's, recorded against its address; no token comes back                                               |
| `wasm-rujira-fin/trade` (a FIN market swap)                   | one `sell` of the asset sent for the asset received, from the swap's first fill (see FIN fills)  | sent: `funds`; received: the `transfer` to the wallet in the Cosmos tx | A trade: one asset disposed of for another                                                                                    |
| `wasm-rujira-merge/deposit`                                   | `bridge-trade-out` of `KUJI` and `bridge-trade-in` of the merge position `RujiraMerge.THOR.KUJI` | sent: `funds`; position: the `shares` attribute                        | Merging is one-way: the KUJI is gone at the deposit, and only RUJI can come out. The position carries the cost                |
| `wasm-rujira-merge/withdraw`                                  | `bridge-trade-out` of `RujiraMerge.THOR.KUJI` and `bridge-trade-in` of `RUJI`                    | shares: `shares`; RUJI: `amount`                                       | The position is disposed of for RUJI                                                                                          |
| Levana perps (`wasm-crank-fee` with `levana_protocol: perps`) | none                                                                                             | –                                                                      | Levana is discontinued. A position is entered by hand (see below)                                                             |

### FIN fills

A FIN swap that fills at several price levels gives a `wasm-rujira-fin/trade`
event per level, and Midgard an action per event, each carrying the whole
call's `funds` and `msg`. The `transfer` to the wallet is the whole swap's
too. So the swap is mapped once: from the action whose attributes match the
called contract's first trade event in the Cosmos tx. The other fills give no
rows (an `ignored` issue), and an action that matches none of those events
fails. Midgard does not list the fills in the Cosmos tx's order. Each fill is
its own store record (`snapshots.md`).

### Liquid and account bonds

The staking contract (`rujira-staking`) offers two separate ways in; a liquid
bond is not made from an account bond.

- **Account bond.** The contract records the bonded amount against the
  wallet's address and mints nothing. Revenue (`revenue_denom`: USDC for RUJI,
  RUNE for bRUNE) is paid out on `account.claim`, and `account.withdraw` returns
  the same asset.
- **Liquid bond.** The asset joins one shared pool and the contract mints pool
  shares to the wallet, a TokenFactory denom `staking-<bond denom>`: sRUJI
  (`x/staking-x/ruji`, "Auto-Compounding RUJI") and ybRUNE (`x/staking-x/brune`,
  "Yield-Bearing Staked BRUNE"; names from the on-chain denom metadata). The
  contract keeps no record of who bonded: whoever sends shares to
  `liquid.unbond` gets their pro-rata part of the pool. Revenue is swapped
  into the bond asset and added to the pool, so each share redeems for more
  over time (auto-compounding). The shares are an ordinary bank token, so
  they can be sent and traded.

Summ's guidance on staking deposits draws the same line: use Staking Deposit
when you deposit a token and receive nothing back; when you receive a
different token in return, Staking Deposit is not appropriate, and the deposit
is a Trade (or a non-taxable Swap)
([Summ help: staking deposits](https://help.summ.com/en/articles/5305471-staking-deposits)).
So an account bond is a `staking-deposit`, and a liquid bond is a trade. The
receipt amount is the bond event's `shares`, which equals the coin minted to
the wallet in the Cosmos tx.

The CSV names the receipt tokens `SRUJI` and `YBRUNE` (no Summ currency has
either symbol). Summ prices a trade from whichever side it knows: RUJI has a
market price, so `RUJI` → `SRUJI` is valued at the RUJI. Summ has no price for
`BRUNE` (its catalogue's `BRUNE` symbols are unrelated tokens) or `YBRUNE`, so
a `BRUNE` → `YBRUNE` sell carries a reference price: bRUNE is minted 1:1
for RUNE (the `rujira-brune` contract asks 1 RUNE per bRUNE), so its price is
taken as RUNE's USD price at the time. This is a deliberate approximation: the
price bRUNE trades at on FIN can sit a little under 1 RUNE (bids follow the
contract's liquid reserves). RUNE's price comes from Midgard's
`/v2/history/rune` (5-minute buckets, any past time). The exporter fetches it
for each liquid bond of bRUNE and stores it as a `midgard-rune-price` record
keyed by the bucket's start; a bucket still open when fetched is fetched again
on the next run. A golden case carries the price as `runePriceUsd`. Rujira's
API has only current prices, and FIN's candles are priced in RUNE.

Before October 2026 a liquid bond was exported as a `staking-deposit` of the
bonded asset, then briefly as a `bridge-trade-out`/`bridge-trade-in` pair, as a
FIN swap was. Re-exported years replace those rows with the `sell` row.

### bRUNE

bRUNE (`x/brune`, "Bonded RUNE") is bought on FIN's RUNE/bRUNE pair, where the
`rujira-brune` contract mints it at 1 RUNE (less FIN's fee) and bonds the RUNE
to whitelisted nodes. Holding bRUNE earns nothing by itself: after each churn
the contract streams the bond rewards, in RUNE, to the bRUNE staking contract.
There they go to bRUNE that is account-bonded (claimed as RUNE) or
liquid-bonded (swapped to bRUNE and added to the ybRUNE pool). The FIN swap is
a trade (row above).

The position token is `RujiraMerge.<chain>.<asset>` of the merged asset (one
per merge pool), the same shape as `ThorLP.BTC.BTC`. The asset names follow
`assets.md`: `x/ruji` → `RUJI`, `x/brune` → `BRUNE`,
`thor.kuji` → `KUJI` (the THORChain KUJI that a KUJI switch bridges in).

### Merge

Before October 2026 a merge deposit was exported as a `staking-deposit` of
`THOR.KUJI`. That name does not match the `KUJI` that the switch bridges in,
and with no position, the withdraw had nowhere to take the cost from. Years
filed with the old rows need an amendment.

### Levana

A Levana position closes in a crank tx that the wallet did not sign, so it is
not in Midgard. It is not worth a fetch: the protocol is discontinued. Enter
the open and the close by hand in Summ (`open-position` and `close-position`),
using the `wasm-position-close` event on THORNode for the collateral, PnL and
fees.

## Open

- **Staking yield.** A liquid bond's yield builds up in the receipt token's
  redemption rate and is realised when the receipt token is disposed of, e.g.
  on `liquid.unbond` (receipt token traded back for more of the asset). An
  account bond's revenue is paid when claimed. Neither the unbond nor the
  claim is mapped yet.

## Golden cases

`rujira/` in `test/cases`, from public transactions.
