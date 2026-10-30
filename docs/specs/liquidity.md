# Liquidity

Midgard `addLiquidity` and `withdraw` actions, on THORChain and Maya. A
position is held as an LP token, so its cost base stays with the position
until it is withdrawn.

## Rows

| Action   | Rows                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add      | one `AddLiquidity` row per asset sent in (with its inbound fee, `fees.md`), a `ReceiveLpToken` row for the position 10 s later, and a `Spam` price-helper row 20 s later |
| Withdraw | a `ReturnLpToken` row for the position, the `Spam` price-helper row, and one `RemoveLiquidity` row per asset paid out, the native asset first                            |

- The LP token is `ThorLP.<chain>.<asset>` of the pool, e.g. `ThorLP.BTC.BTC`
  (`MayaLP.…` on Maya), with the asset named as in `assets.md`.
- Its amount is the `liquidityUnits` Midgard reports for the action.
- The request that triggers a withdrawal, usually dust, is not exported; its
  gas is the fee on the `ReturnLpToken` row (`fees.md`).
- Descriptions say whether the add or withdrawal is symmetric (two assets),
  asymmetric (one) or savers.

Savers use the same rows with their own position token (`savers.md`); Maya's
liquidity auction adds rows of its own (`maya.md`).

## Price helper

Summ has no market price for an LP token, so the `ReceiveLpToken` and
`ReturnLpToken` rows come without a value. The `Spam` row holds the value of
what went in or came out, in an asset Summ does price: the first asset's
amount times the number of assets (twice the first asset for a symmetric add,
a copy of the one asset for an asymmetric add). Summ prices it and ignores it;
the user copies its fiat value onto the LP token row by hand (`../summ.md`).

With `referencePrices = "all"` (the default) the LP token rows carry a reference price
instead: the USD value of the same assets at Midgard's pool prices, per unit
(`prices.md`). The price helper stays, unpriced, so Summ's own value can be
compared with it.

The liquidity-auction position's helper is the deposited asset's side, twice
(`maya.md`).

## Golden cases

`liquidity/` and `maya/` in `test/cases`, from public transactions.
