# Reference prices

Summ's advanced CSV has two optional columns, `Reference Price Per Unit` and
`Reference Price Currency` (`src/export/summ/csv/SummRow.ts`). When they are
filled, Summ values the row's base currency at that price instead of its own
market price. Only fiat currencies count (the exporter writes `USD`); a
crypto symbol is ignored.

A reference price moves every figure the row feeds: the proceeds of a
disposal, the cost base of an acquisition, and the value of income. So the
rule is the same as for amounts (`activity.md`): a price is either observed
by a source or derived from observed prices by a stated rule. When there is
neither, the columns stay blank and Summ uses its own market price, or none.
The exporter never guesses a price.

## The option

`referencePrices` in the config:

| Value               | Rows that carry a reference price                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"swaps"` (default) | as before this option: swaps (each side at Midgard's `inPriceUSD` / `outPriceUSD`), a bRUNE sell (RUNE's price, `rujira.md`) and a TCY distribution (the RUNE price the TCY API gives). No other price is fetched |
| `"all"`             | those, and every other row whose asset has a price below. A run fetches the prices it needs                                                                                                                       |

The default keeps every row of an existing export as it was, and a run with
the default fetches nothing new, so `--offline` replays of an existing store
still work. Row IDs are the same under either value (`periods.md`): the
price is not part of the ID.

## Prices by asset

Every price is USD at the 5-minute Midgard bucket holding the activity's time:
the value Midgard records for the end of that bucket, so at most five minutes
after the action.

| Asset                                                                                  | Price                                                                                                                                                                                                                                           | Basis                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A swap's sent and received asset                                                       | Midgard's `inPriceUSD` / `outPriceUSD` of the swap (unchanged)                                                                                                                                                                                  | observed at the swap                                                                                                                   |
| RUNE (`THOR.RUNE`), on THORChain and Maya                                              | THORChain Midgard `/v2/history/rune`, `runePriceUSD`                                                                                                                                                                                            | observed                                                                                                                               |
| CACAO (`MAYA.CACAO`)                                                                   | Maya Midgard `/v2/history/cacao`, `cacaoPriceUSD`                                                                                                                                                                                               | observed                                                                                                                               |
| A pool asset: an L1 coin or token (`BTC.BTC`, `ETH.USDC-0X…`), `THOR.TCY`, `MAYA.MAYA` | the protocol's own Midgard `/v2/history/depths/{pool}`, `assetPriceUSD`: the pool's price from its depths at the end of the bucket, in USD by the deepest USD pools. Maya's `assetPriceUSD` is already in USD (the decimals check in `maya.md`) | observed                                                                                                                               |
| Synth (`BTC/BTC`), trade asset (`BTC~BTC`), secured asset (`BTC-BTC`)                  | the pool price of the L1 asset (`BTC.BTC`)                                                                                                                                                                                                      | assumed: each is a claim on the pool's asset (a synth is priced by its pool; trade and secured assets redeem 1:1), so it has its price |
| A Rujira denom `x/<name>`                                                              | the pool `THOR.<NAME>` when Midgard has one (`x/ruji` → `THOR.RUJI`)                                                                                                                                                                            | observed                                                                                                                               |
| bRUNE (`x/brune`)                                                                      | none of its own. A bRUNE sell already carries RUNE's price (`rujira.md`)                                                                                                                                                                        | assumed 1 RUNE, as before                                                                                                              |
| Any other asset (no pool, e.g. sRUJI, yBRUNE)                                          | none: blank                                                                                                                                                                                                                                     | —                                                                                                                                      |
| A position token (`ThorLP.*`, `ThorSavers.*`, `MayaLP.*`, RUNEPool, merge shares)      | derived per unit, below                                                                                                                                                                                                                         | derived from observed prices                                                                                                           |

A pool that did not exist yet at that time gives `assetPriceUSD` `0`, and a
pool Midgard does not know gives `400 Unknown pool`; both mean no price.

### Position tokens

A position token's value is what went into the position or came out of it,
the same assets the price-helper row holds (`liquidity.md`), each at its price
at that time:

- **Receive LP token** (an add): the deposits, Σ amount × price, divided by
  the position units received.
- **Return LP token** (a withdrawal): the assets paid out, Σ amount × price,
  divided by the position units given up.
- **TCY claim of a savers position** (`thorfi-collapse.md`): the TCY
  received, at `THOR.TCY`'s pool price, divided by the units given up.
- RUNEPool and Rujira merge positions follow the same rule (RUNE, or the coin
  merged).

If any of those assets has no price, the token row has none. The price
helper approximates a symmetric add as twice the first asset; the derived
price values each side at its own price.

A Maya liquidity-auction position (`maya.md`) has no reference price: its
cost depends on `mayaLiquidityAuction`, and its deposits are separate
actions at other times. Its deposit rows (`lp.auction.deposit`) have none
either, since their time is not the bucket of the auction's action.

### Rows without a price

- **Price-helper (`Spam`) rows never get one.** Summ prices them from its own
  market data, which is what they are for: the user can compare a position
  token's reference value with the helper's value, and fall back to the
  helper's value where the two differ.
- Rows whose asset has no price (above) stay blank.
- A row that already has a price keeps it (a swap's own price is used over
  the pool's).

## Fetching and the store

With `referencePrices = "all"`, a run interprets each bundle before export,
collects the assets of its legs, and fetches each asset's price once per
bucket. The bundle carries them as `usdPrices` (key: `THOR.RUNE`,
`MAYA.CACAO`, or the pool, e.g. `BTC.BTC`; value: the USD price); only keys
that have a price are kept. The interpreter's activity gets them as `prices`
(`activity.md`), with their source: `midgard:history.rune`,
`maya-midgard:history.cacao` or `<midgard>:history.depths`.

Each price is a store record (`snapshots.md`):

| Record                                          | Key                               |
| ----------------------------------------------- | --------------------------------- |
| `midgard-rune-price` (exists)                   | the bucket's start (Unix seconds) |
| `maya-midgard-cacao-price`                      | the bucket's start                |
| `midgard-pool-price`, `maya-midgard-pool-price` | `<pool>.<bucket start>`           |

A bucket still open when fetched has a partial price: it is stored as not
final and fetched again on the next run. A pool with no price (`0`, or
unknown) is stored too, so a replay does not ask again. With `--offline`, a
price not in the store is an error, like any other cache miss. Midgard's
history endpoints take times, not heights.

A golden case carries the prices in `input.json` as `usdPrices`, and its
`treatment` sets `referencePrices: "all"` (`fixtures.md`). The fixture tool
fetches them for every case it adds.

## Summ sync

Summ sync does not compare prices (`summ-sync.md`, Compared fields). A row
already in Summ keeps the price it was uploaded with: turning `"all"` on
changes no plan, so those rows keep Summ's market price until they are
deleted and uploaded again, or their price is edited. Setting the price of
rows already in Summ is a follow-up, decided after comparing the reference
prices with Summ's own (below).

## Open

- Compare the reference prices with Summ's market prices before choosing the
  default: per asset, how far they differ and the value at stake. For LP and
  savers tokens, compare the token's reference value with the price helper's
  value in Summ.
- Then decide how rows already in Summ get their prices (a price edit by
  Summ sync, or delete and re-upload), and whether a position token should
  instead take the helper's value in Summ.

## Tests

- `test/cases/prices/`: a symmetric and an asymmetric LP add, a savers add
  and withdrawal, and a swap, from public transactions, mapped with
  `referencePrices = "all"`.
- `test/Prices.test.ts`: which pool or index an asset is priced from, the
  stored records (open bucket fetched again, unknown pool stored as no
  price, offline miss), the derived position price, and that the default
  fills nothing new.
