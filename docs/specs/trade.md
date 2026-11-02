# Trade accounts

A trade account holds L1 assets on THORChain as trade assets (`BTC~BTC`),
1:1 with the L1 asset in THORChain's vaults (`assets.md`). Midgard lists
moving an asset in or out as an action of type `trade`, with empty
`metadata`, under both addresses:

| Action     | Memo       | `in`                                                             | `out`                                                                           |
| ---------- | ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Deposit    | `trade+:…` | the L1 address, the L1 asset (`BCH.BCH`), the L1 txid            | the THORChain address, the trade asset (`BCH~BCH`), the same amount and txid    |
| Withdrawal | `trade-:…` | the THORChain address, the trade asset, a THORChain `MsgDeposit` | the L1 address, the L1 asset, less the outbound fee, in the vault's own L1 txid |

Nothing is bought or sold: the wallet holds the same asset, on THORChain
instead of its own chain, and both addresses are normally the wallet's
own. So each is exported as a **bridge**, like a switch (`activity.md`):
Summ moves the cost basis and the acquisition date across, and no gain is
realised. (A deposit credited to, or a withdrawal paid to, someone else's
address is a gift or payment, not a bridge: the rows have to be
recategorised by hand, as for a swap paid to another person.)

## Activity

Kinds `trade.deposit` and `trade.withdraw` (`src/interpret/midgard/trade.ts`).

| Legs                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- |
| out: principal, the coin sent (observed), followed by its gas leg; in: principal, the coin paid out (observed) |

The direction comes from the asset sent: a trade asset is a withdrawal,
anything else a deposit. An action that is neither (no trade asset on
either side, or one on both), that does not have exactly one coin in and
one out, or that pays out more than it was sent, fails rather than export
a guess.

The gas is the inbound fee (`fees.md`):

- a deposit is sent on its L1 chain, so its tx is looked up like a swap's
  (THORNode's gas, Viewblock's observation, or an EVM receipt). Only the L1
  inbound is looked up: `getInboundTxs` in `src/sources/Source.ts`.
- a withdrawal is sent on THORChain: the 0.02 RUNE native fee (default).

A withdrawal Midgard still lists as `pending` (not paid out yet) is not
exported, as for any action that is not final (`pending.md`).

## Rows

| Row                                     | Wallet    | Type         | Base                                     | Fee         | Blockchain | Description                                                                                            |
| --------------------------------------- | --------- | ------------ | ---------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| Deposit, the L1 send                    | L1        | `bridge-out` | the L1 coin sent                         | inbound fee | the L1's   | `1/2 - Trade account deposit: send <amount> BCH.BCH; <txid>`                                           |
| Deposit, credited (+10 s)               | THORChain | `bridge-in`  | the trade asset credited                 | —           | THORChain  | `2/2 - Trade account deposit: receive <amount> BCH~BCH; <txid>`                                        |
| Withdrawal, the send                    | THORChain | `bridge-out` | the trade asset, **the amount paid out** | 0.02 RUNE   | THORChain  | `1/2 - Trade account withdrawal: send <paid out> BTC~BTC; <txid>`                                      |
| Withdrawal, paid out (+10 s)            | L1        | `bridge-in`  | the L1 coin received                     | —           | the L1's   | `2/2 - Trade account withdrawal: receive <amount> BTC.BTC; <txid>; paid out in <L1 txid>`              |
| Withdrawal, the outbound fee (when any) | THORChain | `fee`        | sent − paid out, in the trade asset      | —           | THORChain  | `Fee: trade account withdrawal outbound fee, <sent> BTC~BTC sent, <paid out> BTC.BTC paid out; <txid>` |

`<txid>` is the inbound txid (the one Midgard names the action by); the
L1 payout's own txid is added as `paid out in`, as on every L1 payout row
(`fees.md`, Txids in descriptions). Currencies and blockchains follow
`assets.md`: by default the trade asset is named as its L1 asset (`BCH`),
so both sides of the bridge are one currency.

**The outbound fee.** A withdrawal pays out the trade asset less the
outbound fee, which THORChain keeps to pay the vault's gas. Elsewhere that
fee is just a smaller amount received (`fees.md`), but a bridge moves a
holding without disposing of it, so its two sides should carry the same
amount. The bridge-out therefore carries what was paid out, and what was
kept is a `fee` row of its own on the THORChain wallet, in the trade
asset: the wallet's balance falls by what it sent, and the fee is
disposed of as a cost, the same shape as a refund's kept amount
(`fees.md`, Refunds). The fee column stays the gas the wallet paid (0.02
RUNE).

**With `prefixTradeAssets`** the trade asset side is `ThorTrade.BCH.BCH`,
so the bridge joins two currencies; the row IDs are the same either way
(`periods.md`).

**Only one side configured.** Each row goes in its wallet's file. When
only one of the two addresses is in the config, its file still holds its
side of the bridge, and the other side's rows land in a file for an
address the config does not name (with the usual warning).

Swaps into or out of a trade asset (a `swap` whose memo names `BTC~BTC`)
are swaps, not trade account actions, and are unchanged (`fees.md`).

## Not covered

- Secured asset deposits and withdrawals (Midgard type `secure`,
  `ETH-USDC-0X…`): the ones sampled list no outputs, so they need their
  own review. They stay under `unsupported/`.

## Tests

- Golden cases: `trade/bch-deposit` (L1 gas from THORNode),
  `trade/btc-withdraw` (outbound fee row).
- `test/Trade.test.ts`: no fee row when nothing was kept; the prefixed
  names keep the row IDs; the shapes that fail; which inbound is looked up
  for gas.
