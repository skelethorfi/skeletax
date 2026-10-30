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

| Asset                                                                                    | Price                                                                                                                                                                                                                                           | Basis                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A swap's sent and received asset                                                         | Midgard's `inPriceUSD` / `outPriceUSD` of the swap (unchanged)                                                                                                                                                                                  | observed at the swap                                                                                                                   |
| RUNE (`THOR.RUNE`), on THORChain and Maya                                                | THORChain Midgard `/v2/history/rune`, `runePriceUSD`                                                                                                                                                                                            | observed                                                                                                                               |
| CACAO (`MAYA.CACAO`)                                                                     | Maya Midgard `/v2/history/cacao`, `cacaoPriceUSD`                                                                                                                                                                                               | observed                                                                                                                               |
| A pool asset: an L1 coin or token (`BTC.BTC`, `ETH.USDC-0X…`), `THOR.TCY`, `MAYA.MAYA`   | the protocol's own Midgard `/v2/history/depths/{pool}`, `assetPriceUSD`: the pool's price from its depths at the end of the bucket, in USD by the deepest USD pools. Maya's `assetPriceUSD` is already in USD (the decimals check in `maya.md`) | observed                                                                                                                               |
| Synth (`BTC/BTC`), trade asset (`BTC~BTC`), secured asset (`BTC-BTC`)                    | the pool price of the L1 asset (`BTC.BTC`)                                                                                                                                                                                                      | assumed: each is a claim on the pool's asset (a synth is priced by its pool; trade and secured assets redeem 1:1), so it has its price |
| A Rujira denom `x/<name>`                                                                | the pool `THOR.<NAME>` when Midgard has one (`x/ruji` → `THOR.RUJI`); a denom with a path of its own (`x/staking-x/ruji`) is no pool                                                                                                            | observed                                                                                                                               |
| bRUNE (`x/brune`)                                                                        | none of its own (Midgard has no `THOR.BRUNE` pool). A bRUNE sell already carries RUNE's price (`rujira.md`), matched to the bRUNE leg only                                                                                                      | assumed 1 RUNE, as before                                                                                                              |
| Any other asset with no pool (e.g. sRUJI, yBRUNE, BEP2 RUNE `BNB.RUNE-B1A`, `GAIA.KUJI`) | none: blank. Midgard is still asked once per bucket, and its `Unknown pool` answer is stored                                                                                                                                                    | —                                                                                                                                      |
| A position token (`ThorLP.*`, `ThorSavers.*`, `MayaLP.*`, RUNEPool, merge shares)        | derived per unit, below                                                                                                                                                                                                                         | derived from observed prices                                                                                                           |

A pool that did not exist yet at that time gives `assetPriceUSD` `0`, a bucket
before Midgard's history starts gives `NaN`, and a pool Midgard does not know
gives `400 Unknown pool`; each means no price. Any other error (a 5xx, a
timeout) stops the run as for any source, and nothing is stored.

### Frozen pools

A pool's price moves only when it is swapped. While its chain is halted, or
trading is halted, nothing swaps it, and Midgard keeps reporting the last
price in RUNE at RUNE's current USD price. After THORChain halted Terra in May
2022, the LUNA pool kept its pre-crash price while LUNA itself had fallen to
almost nothing: a withdrawal from that pool would have been valued at its
pre-crash value.

So a pool price counts only if the pool was swapped at least once in the 24
hours before the bucket and at least once in the 24 hours after it (Midgard
`/v2/history/swaps?pool=<pool>`, each window's `totalCount`, which counts
every swap that moves the pool's price: to and from RUNE, synth mints and
burns, trade and secured assets). A pool with none on either side has no
price: its rows, and the position tokens valued from it, stay blank. RUNE's
and CACAO's prices come from the deepest USD pools and are not checked.

Both sides are needed. Once a halt starts nothing swaps the pool, so the day
after is empty from the first bucket of the halt on; late in a long halt the
day before is empty too. A window of the day before alone would keep the
stale price for the whole first day of a halt (for LUNA, the day it fell
most). A halt shorter than a day, with swaps on both sides, is not caught:
the price is stale for those hours.

The trade-off: a pool swapped less than once a day on either side loses its
price too, although its price still follows RUNE's. Summ then uses its own
market price for the row, or values it at zero when it has none (a thin
Maya pool, a THORChain-native token). Midgard counts swaps per hour, so the
windows are whole days, not exact to the bucket.

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

If any of those assets has no price, or the action is not `success`, the
token row has none. The price
helper approximates a symmetric add as twice the first asset; the derived
price values each side at its own price.

A Maya liquidity-auction position token (`maya.md`) has no reference price:
its cost depends on `mayaLiquidityAuction`, and its deposits are separate
actions at other times. The deposit rows (`lp.auction.deposit`) have none
either, since their time is not the bucket of the auction's action. The
auction's own rows at its end (the income of what the auction supplied, and
its add-liquidity rows) are priced like any other row: CACAO income at
CACAO's price.

### Rows without a price

- **Price-helper (`Spam`) rows never get one.** Summ prices them from its own
  market data, which is what they are for: the user can compare a position
  token's reference value with the helper's value, and fall back to the
  helper's value where the two differ.
- Rows whose asset has no price (above), or whose pool was frozen (no swap in
  the day before the bucket or the day after), stay blank.
- A row that already has a price keeps it (a swap's own price is used over
  the pool's).
- The default (`"swaps"`) never takes a price from `usdPrices`, even when a
  bundle carries them (a golden case fetched by the fixture tool does).

## Fetching and the store

With `referencePrices = "all"`, a run interprets each bundle before export,
collects the assets of its legs, and fetches each asset's price once per
bucket. Only bundles that can give rows are priced: one listing of each
action (the first wallet's, as `dedupeBundles` keeps), dated inside the run's
`fromDate`–`toDate` with a day's margin either side for the time zone.
So in a run's `all.csv`, which holds every row whatever its date
(`periods.md`), a row more than a day outside the periods has no price under `"all"`, and
two runs over different periods can differ in those rows (`run-diff.md`
reports it). The period files, the ones uploaded, are not affected.
Requests are throttled to one a second, so a first run over several years
takes a while; later runs read the store. The bundle carries them as `usdPrices` (key: `THOR.RUNE`,
`MAYA.CACAO`, or the pool, e.g. `BTC.BTC`; value: the USD price); only keys
that have a price are kept. The interpreter's activity gets them as `prices`
(`activity.md`), with their source: `midgard:history.rune`,
`maya-midgard:history.cacao` or `<midgard>:history.depths`.

Each price is a store record (`snapshots.md`):

| Record                                          | Key                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `midgard-rune-price` (exists)                   | the bucket's start (Unix seconds)                                                                                                      |
| `maya-midgard-cacao-price`                      | the bucket's start                                                                                                                     |
| `midgard-pool-price`, `maya-midgard-pool-price` | `<pool>.<bucket start>`                                                                                                                |
| `midgard-pool-swaps`, `maya-midgard-pool-swaps` | `<pool>.<bucket start>`: the pool's swaps in the 24 hours before the bucket and after it (fetched again until the day after has ended) |

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

- Reference prices on every row are the chosen treatment. Still to do: the
  default value, and Summ sync setting the price of rows already in Summ.

## Tests

- `test/cases/prices/`: a symmetric and an asymmetric LP add, a savers add
  and withdrawal, a swap, and a Rujira liquid bond (a RUJI sell: RUJI's
  price, not RUNE's), from public transactions, mapped with
  `referencePrices = "all"`.
- `test/Prices.test.ts`: which pool or index an asset is priced from (a
  denom with a path, `x/…/…`, `ibc/…`, is none); no token price for an action
  that is not `success`; the
  frozen-pool check (no swap in the day before or after: no price; only a priced pool is
  checked); the stored records (open bucket fetched again, unknown pool stored as no
  price, offline read and miss, CACAO from Maya's history); a bundle's prices
  without the zero ones; an unpriced position and the unpriced helper; that
  a run prices only bundles inside its periods, once per action; and that the
  default fills nothing new, even for a bundle that carries prices.
