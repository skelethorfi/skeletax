# Maya Protocol

## Summary

Maya Protocol is a THORChain fork with its own Midgard
(`https://midgard.mayachain.info`), native asset CACAO and pools that include
`THOR.RUNE`. Maya's Midgard returns actions in the same format as THORChain's,
so swaps and liquidity actions on Maya are exported by the same mappers, with a
protocol setting that supplies the differences.

This spec covers swaps, add liquidity, withdraw liquidity and refunds on Maya.
It does not cover Maya bonding.

## Enabling Maya

Maya is off by default, so existing configs export exactly what they did before.
Enable it per config:

```toml
protocols = ["thorchain", "maya"]
```

When enabled, every wallet in the config is also queried on Maya's Midgard, not
only `maya1` wallets: swaps and liquidity adds are often started from a `thor1`,
`0x` or other address. Maya responses are cached in `<storePath>/records/maya-midgard/`.

## Protocol differences

|                                               | THORChain                 | Maya                                                                                                                                                                               |
| --------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native asset                                  | `THOR.RUNE`               | `MAYA.CACAO`                                                                                                                                                                       |
| Native asset decimals                         | 8                         | **10**                                                                                                                                                                             |
| Other asset decimals                          | 8                         | 8, except the MAYA token (`MAYA.MAYA` / `MAYA`), which is **4**                                                                                                                    |
| Counterparty in `from` / `to`                 | `thorchain`               | `mayaprotocol`                                                                                                                                                                     |
| Blockchain value for the native chain         | `THORChain`               | `Mayachain` (Summ's name; Summ has no Maya Protocol chain to attach rows to; see below)                                                                                            |
| LP token                                      | `ThorLP.<pool>`           | `MayaLP.<pool>`                                                                                                                                                                    |
| Native address prefix                         | `thor1`                   | `maya1`                                                                                                                                                                            |
| Default inbound gas when node data is missing | 0.02 RUNE (see `fees.md`) | Maya's native fee at the action's height for CACAO inputs (Fees, below); 0.02 RUNE for RUNE inputs (sent on THORChain); none for other inputs, as Maya node tx data is not fetched |

Decimals were checked on 2026-10-01 against live pool depths: Midgard's
`assetPriceUSD` only matches `cacaoDepth / assetDepth` when CACAO is read as
1e10 and pool assets as 1e8, and the MAYA pool only matches when MAYA is read
as 1e4.

The blockchain value: Summ lists Maya Protocol as `Mayachain` (integration id
`mayachain`, CSV and API import only). Its blockchains, the chains a row can
be attached to, include `thorchain` and `kujira` but not Maya Protocol, so a
Maya Protocol row gets no chain whatever the column says: a test upload with
`Mayachain`, `mayachain`, `MayaProtocol` and a blank value gave no chain on
any row. Rows are still identified by their import source (Mayachain). The
exporter writes `Mayachain`, Summ's own name, which is the likeliest to match
if Summ adds the chain. It is set in one place (`src/domain/Protocol.ts`).

## Required behaviour

### Swaps

As THORChain swaps (`BridgeTradeOut` from the sender, `BridgeTradeIn` to the
memo's destination), using the Maya counterparty and decimals. Row ids use the
protocol id (`<date>.maya.bridge-trade-out`).

**Affiliate fees.** Swaps through an interface with an affiliate can have an
extra output, usually in CACAO, to the affiliate's address. It is not the
user's, so it is ignored: the `BridgeTradeOut` keeps the full input, and the
fee is part of what the input bought.

**Partially filled swaps.** A streaming swap that fills only partly returns the
unfilled part of the input to the sender. Midgard reports this as two actions
with the same txid: a `swap` whose input is the part swapped, with the deposit
in `streamingSwapMeta.depositedCoin`, and whose outputs include the returned
part (to the sender, in the input asset); and a `refund` for that part.
That output is netted off the deposit for the `BridgeTradeOut` amount: the row
shows what was actually swapped (with the return's outbound fee), and its
description notes the amount returned. For example, 1000 CACAO deposited, 975
swapped, 24.9 CACAO returned and 200 RUNE out becomes a trade-out of 975.1
CACAO for 200 RUNE (`maya/swap-btc-to-eth-partial-fill`). The `refund` action
has no rows: the swap's rows already account for what was sent and returned
(`fees.md`, Partially filled swaps).

### Add liquidity

As THORChain: one `AddLiquidity` row per deposited asset, a
`ReceiveLpToken` row for `MayaLP.<pool>` and the `Spam` price-helper row. With
two assets, the first must be the native asset (CACAO on Maya).

### Liquidity auction (2023)

Maya opened with a liquidity auction (March to April 2023) for five pools:
`THOR.RUNE` (1,444 participants), `BTC.BTC` (285), `ETH.ETH` (271),
`ETH.USDT` (83) and `ETH.USDC` (50). A participant deposited the pool's
asset, one or more times, to Maya's vault on that asset's chain, with the
memo `+:<pool>:<maya address>:…`. At the end (2023-04-16/17) Maya created
every participant's LP position, one `donate:` tx per pool: Maya's Midgard
lists one `addLiquidity` per participant, with memo `donate:<pool>`, a CACAO
side the auction supplied (carrying the donate txid, from the participant's
maya address) and a side of the deposited asset with **no txid**. No Midgard
links the deposits to the add.

**Deposits.** RUNE deposits are THORChain sends, which THORChain's Midgard
lists: a deposit is a successful THORChain `send` from the add's RUNE-side
address whose memo starts with `+:THOR.RUNE:<the add's CACAO-side address>`
(case ignored), before the add. Deposits are attached to the add's bundle as
its `inbounds` and give no send rows. A deposit that was refunded is already
the inbound of its refund (`sends.md`), so it is not attached. BTC, ETH, USDT
and USDC deposits were sent on Bitcoin or Ethereum, which no source read here
lists (they are in that wallet's own import in Summ).

**Rows**, RUNE with its deposits found:

| When              | Row                                                                                                   | Amount                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| each deposit      | `AddLiquidity` RUNE, with the deposit's 0.02 RUNE fee                                                 | the deposit                                       |
| the auction's end | CACAO the auction supplied (below)                                                                    | the add's CACAO side                              |
| the auction's end | RUNE the auction supplied (below)                                                                     | the add's RUNE side − the deposits, when positive |
| the auction's end | `ReceiveLpToken` `MayaLP.<pool>`, and the `Spam` price-helper row (the deposited asset's side, twice) | the add's liquidity units                         |

Another asset, or RUNE whose deposits were not found: the side is an
`AddLiquidity` row at the auction's end, in that wallet's file, with no fee,
and the action gets an enter-by-hand note giving the side's amount and the
file: not to upload that row, but to categorise that wallet's own deposits to
Maya's vault (in its own import in Summ) as the add, as their total can
differ from the side. Summ push-back (backlog) can do that categorising. The CACAO side, LP token and
price-helper rows are as above.

When the RUNE side is **less** than the deposits found (an auction
withdrawal, or a tier rule), the run cannot tell what happened to the rest:
no RUNE row is added at the end, and the action gets an enter-by-hand note.

**What the auction supplied** (the CACAO side, and RUNE above the deposits)
came from the auction, not the wallet. How to treat it is a tax choice, set
by the config key `mayaLiquidityAuction`:

- `"income"`: it is income at the auction's end (an `Income` row), then
  added to the pool (an `AddLiquidity` row 1 s later), so the position's
  cost includes it.
- `"pool-units"`: no rows for it; the participant received only the pool
  units, their cost is what was deposited, and any gain shows when the
  position is withdrawn. (`"deposit"`, its earlier name, is still read as
  `"pool-units"`.)

No CACAO ever reached the participant's wallet: the auction added it straight
to the position. Participants chose a tier (Mayanode `handler_donate.go`,
`withdraw_current.go`): tiers 2 and 3 gave up 10% and 33% of their CACAO
share to tier 1, and for 200, 90 or 30 days after the auction (tiers 1, 2, 3)
a position could withdraw at most 0.5%, 1.5% or 4.5% of itself per 24 hours.
That reads either way: only pool units were received (`"pool-units"`), or
the bonus is a reward for accepting the limit (`"income"`).

The key has no default: a run that finds an auction position stops, before
writing anything, until it is set. `"pool-units"` defers the tax and makes it
a capital gain, so a default would make that choice, worth an income year's
timing, for the user. Configs without an auction position
never need it. The rows both choices share (the deposits, the LP token and
the price-helper) have the same IDs under either, so switching changes
exactly the `Income` and `AddLiquidity` rows of what the auction supplied.

Golden cases: `maya/liquidity-auction-rune` (RUNE, deposits found),
`maya/liquidity-auction-btc` and `maya/liquidity-auction-eth` (public
participants).

### Sends

As THORChain sends (`sends.md`), from Maya's Midgard: `send` with Maya's
native fee at its height (Fees, below), `receive`, or `income` when the sender is in `incomeFrom` (e.g. the
MAYA token distributions after the liquidity auction). A Maya send that is
another listed action's inbound or outbound gives no row. Golden cases:
`maya/send-cacao`, `maya/send-maya-income`.

### CACAO to MAYA holders

Maya pays a share of its revenue in CACAO to every MAYA holder, pro rata, at
each height divisible by 14400 (about once a day). It is an end-block event,
`distribute_maya_fund` (`cacao_address`, `cacao_amount`), with a transfer from
the `maya_fund` module account: there is no tx, so Midgard's actions never
list it. The public node's
`block_search` is disabled, and a whole block (`/mayachain/block?height=`) is
several MB, too much to read once a day.

Maya's Midgard has listed the payouts since release 2.20.0
(`/v2/maya/<address>/dividends`: height, date in seconds and CACAO amount,
paged by 400, only payouts of more than 0), but only from height 14947200
(2026-01-26) onwards, for every holder: what it indexed, not when they first
held MAYA. The source uses it from that height on: one call per 400 payouts.
A Midgard without it (404, e.g. an older one set in `MAYA_MIDGARD_API_URL`)
gets a warning, and every height is read as below; any other error fails the
run after the usual retries. A payout listed twice (one made between two
pages) is kept once.

For payouts before that height, the source reads the wallet's balance on Maya's Midgard just before and at
each payout height (`/v2/balance/<address>?height=h−1` and `?height=h`): the
CACAO paid is the step between them, and the MAYA held at `h−1` is kept with
it (Midgard's shared client sends one request a second, so this is about 2 s
a payout). Where both have a payout, its height, amount and date (to the
second) equal the dividends list's. That step is exact only when nothing else moved the wallet's CACAO in
block `h`. When one of the wallet's Midgard actions was sent or paid out at
`h` (its own height or an outbound's: a streaming swap pays out blocks after
it starts), or the step is below 0, the source reads the payout from that
block's `distribute_maya_fund` event instead, with a warning when the wallet
held MAYA but the block pays it nothing. A CACAO transfer into the wallet at
`h` that no Midgard action lists would still be counted; none is known.

Each payout read from balances is stored as soon as it is read, so a run that
fails part way through a long history (about 2 s a payout) resumes there.

Which heights: every payout height from the first one after the wallet first
received MAYA (a MAYA receipt in its Midgard actions) up to the chain's tip.
A wallet that never received MAYA has none. Each payout is a record
(`maya-distribution`, keyed `<wallet>.<height>`, one list per wallet). A run fetches
only the heights after the last one stored; a past payout does not change.
A wallet whose first MAYA came with no Midgard action (e.g. at genesis) is
not covered. Replaying a run made before this source existed gives no
payouts, as that run had none (`snapshots.md`).

Each payout keeps the method that read it (`from`: `dividends`, `balance` or
`event`) and is never read again. The dividends list's time is to the second,
the balance step's to the millisecond, so the same payout read by the other
method would get another row time and row ID.

Activity `maya.distribution`: in: reward, the CACAO paid (observed); details: the
height, and the MAYA held when the balance step gives it. A payout of 0 (no
MAYA held at `h−1`) is not an activity.

| Row    | Type     | Base                   | Fee | From, to                   | Description                                                         |
| ------ | -------- | ---------------------- | --- | -------------------------- | ------------------------------------------------------------------- |
| Payout | `income` | CACAO, the amount paid | —   | `mayaprotocol`, the wallet | `1/1 - Received <amount> CACAO reward for holding MAYA; height <h>` |

It is income when paid: the value is Summ's CACAO price at that time (the
source gives none). It is `income`, not `staking`: MAYA is held, not staked.
Golden cases: `maya/maya-distribution-payout` (balance step) and
`maya/maya-distribution-dividend` (dividends list), the same payout to a public holder.

### Withdraw liquidity

As THORChain: `ReturnLpToken`, the `Spam` price-helper row and one
`RemoveLiquidity` row per asset returned, with the native-asset output first.
The dust inbound used to trigger the withdrawal (e.g. 1e-10 CACAO) is ignored,
as on THORChain.

### Refunds

As THORChain (`fees.md` → Refunds), with Maya decimals and `mayaprotocol` as
the counterparty: a `FailedOut` row with the inbound fee, and a `Fee` row for
what Maya kept when less came back than was sent. Refunds still `pending` are
skipped, as on THORChain.

### Fees

Maya's native transaction fee, paid in CACAO by a send or an action sent
from a Maya wallet, has changed over time. Mimir `NATIVETRANSACTIONFEE`
overrides the constant (0.2 CACAO), and its value at a height is the fee:

| Maya height (about)                       | Fee          |
| ----------------------------------------- | ------------ |
| up to at least 1,500,000 (2023)           | 0.0002 CACAO |
| around 3,600,000 (late 2023)              | 1 CACAO      |
| around 4,400,000 to 5,000,000 (2023-2024) | 0.5 CACAO    |
| from around 9,900,000 (2025)              | 0.2 CACAO    |

The 0.2 CACAO now was checked on a 2026 send's events (0.178 to the reserve,
0.02 to `maya_fund` and 0.002 to a third account). Maya's Midgard reports
0.2 CACAO as the fee of old sends too, so it is not used, as on THORChain.
Mayanode has pruned old txs but serves its state at a past height, so the
source reads the setting at each Maya action's height
(`/mayachain/mimir?height=`, else `/mayachain/constants?height=`), stores it
(`mayanode-fee` records, one per height) and puts it in the bundle
(`nativeFee`); it replaces the 0.2 CACAO default for every CACAO fee of that
action. Golden cases carry it too.

### Blockchain values

As on THORChain, every row uses the protocol's blockchain name for its native
chain (`Mayachain`, and `THORChain` for RUNE), and Midgard's chain id for
an L1 chain (`KUJI`, `BTC`, …). See `assets.md`.

## Golden cases

Public Maya transactions in `test/cases/maya/`: CACAO → ETH.USDC swap, CACAO →
RUNE and RUNE → KUJI swaps with affiliate outputs, a partially filled BTC →
ETH swap and its refund (which has no rows), a symmetric KUJI add, liquidity auction positions (RUNE with its deposits, BTC, ETH), and a symmetric RUNE-pool
withdrawal.

## Not covered yet

- Fees paid on Maya inbound transactions
