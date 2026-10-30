# Savers

THORChain Savers (2022 until the ThorFi collapse in January 2025,
`thorfi-collapse.md`) took a single L1 asset, held it as the synth inside
the pool, and paid yield in that asset.

## What Midgard reports

- Deposit: an `addLiquidity` action whose pool is the synth (`BTC/BTC`), and
  whose input coin is also reported as the synth, even when the wallet sent
  L1 BTC from a `bc1…` address. Its amount is the synth minted, after the
  swap's liquidity fee, so for an L1 deposit it is less than the wallet sent.
  THORNode's status of the inbound tx holds the L1 coin sent (`BTC.BTC`).
- Older deposits also list a `swap` with `metadata.swap.txType: add` for the
  same txid (the L1 coin in, no output), left `pending`. It is not exported:
  the `addLiquidity` of its txid covers it (`pending.md`).
- Withdrawal: a `withdraw` action for the same pool. The request is a dust
  send from the wallet; the output is the L1 asset (`BTC.BTC`).

## Rows

Savers are exported like a liquidity position (`liquidity.md`): an
`AddLiquidity` or `RemoveLiquidity` row for the asset, a `ReceiveLpToken` or
`ReturnLpToken` row for the position, and the `Spam` price-helper row. The
position token's amount is the `liquidityUnits` Midgard reports, which for
savers is close to the synth minted.

Savers is a liquidity position, not staking:

- the asset ends up in the pool, whose other side the protocol provides;
- what the depositor holds is a right to a share of the pool (savers units
  allocated to their address), not the asset itself;
- the yield is not paid out apart from the capital: it is only realised by
  redeeming the units, as part of what is withdrawn.

Staking, by contrast, pays rewards apart from the asset staked: TCY staking
(a `StakingDeposit`, with distributions paid as `Staking` rows) and a Rujira
account bond (`rujira.md`). A Rujira liquid bond, whose shares each redeem for
more as revenue is added to the pool, is a disposal like savers (`rujira.md`).

Summ's staking-deposit test (`rujira.md`: nothing back is a staking deposit, a
different token back is a trade or a non-taxable swap) would, taken alone,
make savers a staking deposit like an account bond, since savers units are
recorded against the address and no token is minted. The difference is in
the bullets above and `rujira.md`: an account bond records the wallet's own
asset, returns the same amount and pays revenue separately, while savers units
are a claim on a share of the pool whose yield arrives only through
redemption. The export represents that claim as the `ThorSavers.*` position
token, which carries the deposit's cost to the withdrawal.

The rows record the mechanism: at deposit the asset is disposed of for the
position token, and at withdrawal the token is disposed of for what comes
back. Summ's guide treats adding and removing liquidity as a taxable exchange
for the position token
([Liquidity pools](https://summ.com/guides/liquidity-pools)). Whether it is
taxable is the tax tool's setting, not the rows': where adding liquidity is
not a disposal, Summ's tax toggle for liquidity adds and removals makes them
non-taxable without changing the rows.

| Field                                                   | Value                                                                                                                                                                                | Why                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset currency, deposit sent from an L1 wallet          | the L1 asset, e.g. `BTC`                                                                                                                                                             | the wallet sent real BTC, not the synth (`assets.md`)                                                                                                                                              |
| Asset currency, synth deposited from a THORChain wallet | the synth, e.g. `ThorSynth.BTC.BTC`                                                                                                                                                  | the wallet sent the synth                                                                                                                                                                          |
| Asset amount, deposit sent from an L1 wallet            | the L1 amount sent: THORNode's inbound coin; Midgard's coin (the synth minted), with a warning, when THORNode has no inbound for the tx or its inbound has no coin of the sent asset | the wallet disposed of what it sent; the swap's fee into the synth is netted off inside the protocol, as every protocol fee is (`fees.md`), so it lowers the position's units, not the amount sent |
| Asset amount, synth deposited from a THORChain wallet   | Midgard's coin                                                                                                                                                                       | the synth sent is the synth deposited                                                                                                                                                              |
| Position token                                          | `ThorSavers.<chain>.<asset>`, e.g. `ThorSavers.BTC.BTC`, `ThorSavers.ETH.USDC`                                                                                                       | savers units are not pool LP units, so it must differ from `ThorLP.BTC.BTC`; no `/`, which breaks Summ's ledger view; the same `<prefix>.<chain>.<asset>` shape as LP tokens                       |
| Fee on the deposit                                      | the deposit's inbound fee: L1 gas for an L1 wallet (blank when neither THORNode nor Viewblock has it), 0.02 RUNE for a synth from a THORChain wallet                                 | `fees.md`                                                                                                                                                                                          |

The price-helper row has the asset amount, so it values the position at what
was sent: the position's cost base. With `referencePrices = "all"` (the default) the
position token rows carry the value of what went in or came out as a reference
price (`prices.md`).

Before October 2026 the token was `ThorLP.BTC/BTC`, a deposit sent from an L1
wallet was exported as `BTC.BTC` (then the synth's name) and, briefly, with a
0.02 RUNE fee; until late October 2026 its amount (and the price helper's) was
the synth minted.

An affiliate named in the deposit's memo gets its share as an add of its own,
in the affiliate's name (THORNode's add-liquidity handler). That add is not the
wallet's, so the wallet has one row for the whole amount sent, and the share
leaves inside the protocol, like any protocol fee. An affiliate given as a
THORChain address cannot take an add of the asset, which needs an address on
the asset's own chain; before THORNode 1.128 neither could a bare THORName,
which was looked up on THORChain. Such a deposit failed: Midgard reports a
refund, not an add.

Maya has the same fields with `MayaSavers` as the prefix. Its inbounds are not
looked up on a node, so a Maya savers deposit from an L1 wallet keeps Midgard's
coin, with a warning.

## Open

- The ThorFi collapse: savers positions still open in January 2025 were
  frozen, and their owners claimed TCY for them. The claim is the disposal
  of the position (`thorfi-collapse.md`); not exported yet.

## Golden cases

`liquidity/add-btc-savers` and `liquidity/withdraw-btc-savers` (public
transactions).
