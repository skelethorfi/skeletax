# Fees

## Summary

Every exported row follows one rule:

- **Amount** is the amount sent in (or received), as the wallet saw it.
- **Fee** is the gas the wallet paid to send that transaction in, and nothing else.

THORChain and Maya deduct other fees (liquidity, affiliate, outbound network,
slip) from the inbound amount before paying out. They are already reflected in
what comes out, so they are not exported as fees. Listing them as fees as well
would count them twice, and the wallet balances in Summ would not add up.

From the earlier restructure (fetch-tx), which follows the same rule:

> So if we have a 100 RUNE input to BTC, there would be 0.02 RUNE gas on the
> input. Meaning, it is a decrease of 100.02 RUNE from the source wallet. There
> are liquidity and affiliate fees applied, but these are subtracted from the
> inbound amount and you get what is left after the fees are applied in the
> output. Therefore, we don't need to export these fees.

## Inbound and outbound: THORChain's words against Summ's

The two systems name directions from opposite sides, so the same transaction
is "inbound" in one and "out" in the other.

- **THORChain and Maya** (Midgard, THORNode, and these specs) speak from the
  **protocol's** side.
- **Summ** (its categories and the CSV types) speaks from the **wallet's**
  side.

| The transaction                        | THORChain calls it                               | Summ sees it as                   | CSV types                                                            | Who pays its gas                                                                |
| -------------------------------------- | ------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The wallet sends funds to the protocol | **inbound** (Midgard `in`, THORNode `tx`)        | an **outgoing** leg of the wallet | the `…Out` types: `BridgeTradeOut`, `BridgeOut`, `FailedOut`, a send | **The wallet.** This is the _inbound fee_, and the only thing in the fee column |
| The protocol pays funds to a wallet    | **outbound** (Midgard `out`, THORNode `out_txs`) | an **incoming** leg of the wallet | the `…In` types: `BridgeTradeIn`, `BridgeIn`, a receive              | **The protocol's vault.** The wallet pays no gas here                           |

So in these specs:

- **Inbound fee** (or inbound gas) means the gas the wallet paid on the
  transaction it sent. From the wallet's side, and in Summ, it is the fee on
  an outgoing transaction.
- **Outbound fee** (Midgard `networkFees`) means what the protocol charges to
  cover its vault's gas on the payout. The wallet never pays it as gas: the
  protocol deducts it before paying out, so it appears only as a smaller
  amount received. It is never put in the fee column.

One more trap: Summ's `FailedIn` and `FailedOut` follow Summ's direction, not
THORChain's. A refunded THORChain _inbound_ is a `FailedOut`, because the
wallet sent it.

### Txids in descriptions

A row's description names the inbound txid (most end with `; <txid>`): the
transaction the wallet sent, which names the action on Midgard and
THORNode.

A row on an **L1 wallet** (any chain but THORChain and Maya) that records a
payout from the protocol also names the **outbound** txid, the payout's own
transaction on that chain (Midgard `out[].txID` for that wallet). That is
the transaction a wallet import of the chain (Summ's, or a block explorer)
lists, and the inbound txid is nowhere in it. The label is `paid out in`,
which reads the same from the protocol's side (its outbound) and the
wallet's (a receive):

```text
2/2 - Swap 0.001 BTC to 0.032 ETH; <inbound txid>; paid out in <outbound txid>
```

The inbound txid stays first: it is the one txid all rows of the action
share, the key of the action's source records (run-diff explains a row by
it), and the only link to THORChain from a row in Summ, whose own import
already carries the outbound txid.

The L1 side of a **symmetric add** is the same case the other way: the
wallet sent its own transaction on that chain, while the action's first
txid is the RUNE (or CACAO) deposit. Its `AddLiquidity` row keeps that
shared txid first and adds its own as `sent in`:

```text
2/4 - Add liquidity BTC to ThorLP.BTC.BTC (symmetric); <RUNE txid>; sent in <BTC txid>
```

An asymmetric or savers add has one deposit, whose txid is the first, so
nothing is added.

| Kind                         | Row on the L1 wallet                   | Outbound                                  |
| ---------------------------- | -------------------------------------- | ----------------------------------------- |
| swap                         | `BridgeTradeIn` (the `2/2` row)        | the output paid to the memo's destination |
| lp.withdraw, savers.withdraw | `RemoveLiquidity` of the L1 asset      | that asset's payout                       |
| loan.open                    | `Loan` (the `2/2` row)                 | the loan paid out                         |
| loan.repay                   | `CollateralWithdrawal` (the `2/2` row) | the collateral paid back                  |

- Only that row changes. The other rows of the action (on THORChain, Maya,
  or the L1 rows the wallet sent) keep their descriptions, so their
  uploaded copies in Summ stay as they are.
- A row on THORChain or Maya gets no outbound txid: THORChain's own payouts
  have none, and a payout from one protocol to the other is a row in an
  uploaded file, matched by its ID.
- A payout Midgard lists without a txid (still pending), or with an all-zero
  one, adds nothing. Once it is paid out, a later run adds the txid, so
  run-diff shows that row's description changing.
- Refunds keep their own wording: the `Fee` row already says
  `<amount> <coin> returned in <outbound txid>`. The part of a streaming swap
  returned unfilled is not a row (it is netted off the trade-out), so its
  outbound txid is in no description.

## The inbound fee

`getInboundFee` (`src/export/summ/ThorchainUtils.ts`) gives the fee
for an inbound transaction:

1. **An EVM chain's receipt**, for an inbound sent on ETH, AVAX, BSC or BASE:
   `gasUsed × effectiveGasPrice`, plus `l1Fee` on BASE (the L1 data fee an
   OP-stack chain charges), in wei of the chain's gas coin (ETH, AVAX, BNB,
   ETH). This is what the wallet paid; it is the fee a wallet import shows,
   to all 18 decimals (`swap/eth-to-btc`).
2. **THORNode gas**, when the matching THORNode transaction (by inbound txid)
   has gas: `thornodeTx.tx.gas[0]`, in that gas asset, in 1e8 units.
3. **Viewblock's observation**, when THORNode has no gas: `observation.gas[0]`
   of Viewblock's record of the inbound, in 1e8 units (its `decimals` field
   says `0` and is ignored). It is THORNode's own observation, kept by
   Viewblock after THORNode pruned it; it equals the chain's fee on UTXO and
   Cosmos chains (`swap/btc-to-synth`, `swap/doge-to-rune`).
4. **Otherwise, a default for native transactions**:
   - an asset on THORChain (`THOR.*`, e.g. RUNE, TCY, KUJI on THORChain), or a
     synth, trade or secured asset: **0.02 RUNE**, THORChain's native
     transaction fee
   - on Maya, CACAO: **Maya's native fee at the action's height** (0.2 CACAO now; it has changed, see `maya.md`, Fees)
5. **Otherwise blank**: an L1 inbound that neither THORNode nor Viewblock
   has, or one in a Maya action (neither is queried for Maya).

THORNode, Viewblock and the receipts are fetched (`getInboundTxs`,
`src/sources/Source.ts`) for THORChain actions only:

- swaps and switches (including loan opens and repayments, which are swaps):
  the inbound transaction
- add liquidity and withdraw liquidity: each inbound transaction sent on an
  L1 chain, a coin or a token (`ETH.USDC-0X…`); a savers deposit from an L1
  wallet counts, although Midgard names its coin as the synth (`BTC/BTC`).
  Ones sent on THORChain use the default above.
- refunds: the inbound transaction, for its gas and to see what the wallet
  sent (see Refunds of an affiliate's cut).

Of those, Viewblock is fetched only for an inbound sent on an L1 chain other
than an EVM one whose THORNode status has no gas, and a receipt for every
inbound sent on an EVM chain.

### Why not THORNode's gas on EVM chains

On an EVM chain THORNode's `tx.gas` is not what the wallet paid. For an
EIP-1559 tx (every ETH, AVAX and BASE inbound since 2021–22) it is
`maxFeePerGas × gasUsed`, rounded up to 1e-8: the most the wallet allowed,
1.1 to several times the fee charged. On BASE it also leaves out the L1
data fee. Viewblock's observation is the same value. So an EVM inbound's fee
comes from its receipt, and no other value is used: a receipt the RPC does
not return stops the run with an error, rather than falling back to the
upper bound.

### Endpoints and the store

Receipts come from `eth_getTransactionReceipt` on a public JSON-RPC
endpoint per chain. The defaults serve receipts from the chain's start;
many public endpoints prune old ones (an ETH receipt from 2021 is missing
on most). Each can be replaced by an environment variable:

| Chain | Default                                 | Variable       |
| ----- | --------------------------------------- | -------------- |
| ETH   | `https://eth.drpc.org`                  | `ETH_RPC_URL`  |
| AVAX  | `https://api.avax.network/ext/bc/C/rpc` | `AVAX_RPC_URL` |
| BSC   | `https://bsc-dataseed.bnbchain.org`     | `BSC_RPC_URL`  |
| BASE  | `https://mainnet.base.org`              | `BASE_RPC_URL` |

The endpoint learns the inbound txids it is asked for, as Midgard and
THORNode do.

Viewblock's record comes from its single-tx endpoint
(`api.viewblock.io/thorchain/txs/<hash>`), the unofficial API that already
serves the old sends (`sends.md`). A hash it does not know (404) is stored
as not found, and the fee stays blank. It is asked again on later runs only
while its action is newer than `pendingStuckDays` (`snapshots.md`); an older
miss, the usual case for a tx THORNode has pruned, is asked again only by
`--refetch-all`.

Both are records in the store, like THORNode's statuses (`snapshots.md`):
`evm-receipt/<chain>.<hash>` (trimmed to the fee fields) and
`viewblock-tx/<hash>` (trimmed to `observation.gas`). A receipt is final,
so it is fetched once; `--offline` reads the stored copy, and a missing one
is an error, as for every other record. `--replay` of a run made before
these sources were read gives none, so it maps as that run did.

Never use Midgard `networkFees` (outbound), `liquidityFee`, `affiliateFee` or
affiliate outputs as a fee.

The fee goes on the row for the wallet that paid it: the row for the inbound
transaction. Rows for what comes out have no fee.

## Per action

| Action                                                           | Row with the fee                                                                          | Fee                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swap                                                             | `BridgeTradeOut`                                                                          | inbound fee                                                                                                                                                                                                                                          |
| Switch                                                           | `BridgeOut`                                                                               | inbound fee                                                                                                                                                                                                                                          |
| Loan open                                                        | `CollateralDeposit`                                                                       | inbound fee; the `Loan` row has none                                                                                                                                                                                                                 |
| Loan repayment                                                   | `LoanRepayment`                                                                           | inbound fee; the `CollateralWithdrawal` row has none                                                                                                                                                                                                 |
| Refund                                                           | `FailedOut`                                                                               | inbound fee; what the protocol kept is a separate `Fee` row (see Refunds)                                                                                                                                                                            |
| Add liquidity                                                    | each `AddLiquidity` row                                                                   | inbound fee of that deposit. A savers deposit sent from an L1 wallet uses that chain's gas, although Midgard reports the coin as the synth (`BTC/BTC`); its amount is the L1 coin sent, the swap's fee into the synth being netted off (`savers.md`) |
| Withdraw liquidity                                               | `ReturnLpToken`                                                                           | inbound fee of the withdrawal request (e.g. 0.02 RUNE, or Maya's native fee in CACAO); `RemoveLiquidity` rows have none                                                                                                                              |
| RUNEPool deposit                                                 | `AddLiquidity`                                                                            | 0.02 RUNE                                                                                                                                                                                                                                            |
| RUNEPool withdraw                                                | `ReturnLpToken`                                                                           | 0.02 RUNE                                                                                                                                                                                                                                            |
| TCY stake / unstake                                              | the single row                                                                            | 0.02 RUNE                                                                                                                                                                                                                                            |
| TCY claim                                                        | `Receive`                                                                                 | 0.02 RUNE when the claim was sent from the receiving THORChain wallet; otherwise none (it was paid on another chain)                                                                                                                                 |
| Rujira contract calls (staking, FIN, merge)                      | the `StakingDeposit` or `BridgeTradeOut` row                                              | the Cosmos tx's gas in RUNE (`auth_info.fee`), blank when none; not the 0.02 RUNE native fee (`rujira.md`)                                                                                                                                           |
| Bond, unbond, Thorname                                           | the single row                                                                            | 0.02 RUNE; a Thorname update that pays nothing else is a `Fee` row of its own, 0.02 RUNE (Summ drops a row with no base amount)                                                                                                                      |
| Send                                                             | the send                                                                                  | 0.02 RUNE, also when another coin is sent; never on the receive (`sends.md`)                                                                                                                                                                         |
| Failed deposit (a native swap, add, THORName… THORNode rejected) | a `Fee` row of its own, 0.02 RUNE; nothing for the coins, which never moved (`failed.md`) |
| Send to itself, Arkeo delegation                                 | a `Fee` row of its own, 0.02 RUNE; no `send` row (`sends.md`)                             |
| TCY distribution                                                 | —                                                                                         | none (nothing sent in)                                                                                                                                                                                                                               |

### Refunds

**What the sources return.** A refund is two transactions, and both Midgard
and THORNode return both:

|                                   | Midgard `refund` action                                         | THORNode tx status                                |
| --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Inbound: the wallet sends in      | `in[0]` (amount, txid)                                          | `tx` (amount, and `gas` the wallet paid on an L1) |
| Outbound: the protocol returns it | `out[0]` (amount; on an L1, its own txid on the original chain) | `out_txs` (amount, and the gas the vault paid)    |
| What the protocol kept            | `metadata.refund.networkFees`                                   | —                                                 |

On an L1 the outbound is a real transaction on the original chain back to the
wallet. On THORChain the outbound has no txid of its own.

**What the wallet loses.** The gas to send the inbound, plus whatever the
protocol kept: the amount sent minus the amount returned. A modern THORChain
refund returns the full amount; an L1 refund returns less, because the
outbound fee is deducted.

**What is exported.** The outbound is not a row.

| Row                                                                                | Type                                                | Amount                             | Fee                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- | ------------------------------ |
| The send                                                                           | `FailedOut`, on the sending wallet, to the protocol | amount sent                        | inbound fee (the one fee rule) |
| What the protocol kept, only when the amount returned is less than the amount sent | `Fee`, same wallet and time                         | sent − returned, in the asset sent | none                           |

- `FailedOut`, not `FailedIn`: the wallet sent this transaction.
- The `Fee` row is separate, not added to the `FailedOut` fee: the gas and the
  asset sent can be different currencies (a token refund pays gas in ETH), and
  the fee column stays the gas the wallet paid, as everywhere else.
- sent − returned comes from the two amounts, not from `networkFees`. Midgard
  can list a network fee that differs from what was actually kept.
- The `Fee` row's description gives the amount returned and, on an L1, the
  txid of the outbound, so the two transactions can be found in a wallet
  import.

| Case                                 | Sent               | Inbound gas                                   | Returned           | Rows                                                               |
| ------------------------------------ | ------------------ | --------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| L1, `refund/btc-price-limit`         | 0.0120779 BTC      | 0.0000166 BTC                                 | 0.01204055 BTC     | `FailedOut` 0.0120779 BTC, fee 0.0000166 BTC; `Fee` 0.00003735 BTC |
| THORChain, `refund/rune-price-limit` | 1840.58501519 RUNE | 0.02 RUNE (native fee; THORNode lists no gas) | 1840.58501519 RUNE | `FailedOut` 1840.58501519 RUNE, fee 0.02 RUNE                      |

**Why this shape (checked in Summ, October 2026).**

- Summ ignores the amount of a failed transaction for tax and for the balance,
  and disposes only its fee. So a refund on a THORChain or Maya wallet, where
  this CSV is the only record, needs exactly one `FailedOut` row carrying the
  gas, and nothing for the amount coming back.
- On an L1, a wallet imported into Summ already has both transactions. Summ
  does not pair them: transfer, bridge and cross-chain trade categories were
  tried on a real refund and none grouped the send with the return. The
  treatment that balances is the same shape as these rows: the send as Failed
  Out, the return ignored, and a fee for what was lost. One difference when
  applying it to an imported wallet: on Bitcoin-style chains Summ's import
  holds the gas inside the amount sent, so the fee to add there is this
  `FailedOut` row's fee plus the `Fee` row; on EVM chains the import has the
  gas as a separate fee and only the `Fee` row is added.

**Not exported.**

- A refund Midgard still reports as `pending` (nothing has been returned) is
  not exported while it may still be paid out. Once stuck (`pending.md`), it
  is exported with what was not returned as `Lost` instead of `Fee`.
- A partially filled swap's refund (see Partially filled swaps).
- Old L1 refunds for which neither THORNode nor Viewblock has a record of
  the inbound: the `FailedOut` fee is blank, per the inbound fee rule.

### Refunds of an affiliate's cut

When a swap has an affiliate, THORChain swaps the affiliate's cut to RUNE as a
swap of its own, which carries the user's txid and address. If that swap fails,
Midgard reports a `refund` action whose input is the cut (e.g. secured USDC),
next to the successful swap with the same txid.

No row is exported for it:

- the wallet never sent that amount, and
- no transaction returns it to the wallet. The cut simply stays in the swap's
  single payout, which is the swap output less the outbound fee only, and the
  swap's `BridgeTradeIn` row already carries that full amount.

The refund interpreter (`src/interpret/midgard/refund.ts`) detects it by the THORNode inbound transaction listing a
different asset from the refund's input (`refund/affiliate-fee-swap`). Without
THORNode data the row is kept.

### Partially filled swaps

A streaming swap can fill only partly and return the unfilled input to the
sender. That part was never swapped, so it is not a fee: the `BridgeTradeOut`
amount is what was sent minus what was returned (`maya.md`). The fee is still
the inbound fee.

What was sent is the deposit. Midgard (both THORChain's and Maya's) lists only
the part swapped (`streamingSwapMeta.inCoin`) as the swap's input, so netting
the return off the input understated the trade, or made it negative when more
was returned than swapped (#113). The deposit is, in order:

1. `streamingSwapMeta.depositedCoin`, when it is in the input's asset and larger
   than the input (seen on every partial fill sampled back to 2024-07; on a full
   fill it equals the input);
2. THORNode's inbound coin, when the bundle has it and it is larger than the
   input;
3. where Midgard leaves the meta blank (all zero, seen on Maya): the input plus
   the return plus the return's outbound fee (`networkFees` in the input
   asset), which is what the refund's input equals;
4. otherwise the input, with a warning when the meta is blank: the return is
   then netted off the input, as for an action listed with no meta at all.

A swap whose return is the whole of what was sent fails rather than export
nothing or less.

Midgard also reports a `refund` action for the unfilled part, with the same
txid, whose input is that part (deposit − part swapped) and whose outputs
include the swap's output in another asset. No row is exported for it: the
swap's rows already account for everything sent and returned, including the
outbound fee on the returned part, and its `BridgeTradeOut` carries the
inbound fee.

The return goes back to the sender, so a swap to the sender's own address
(e.g. TRON.USDT to TRON.TRX, or between trade assets) pays that address twice:
the swap's output is the one in another asset than the input, whichever Midgard
lists first.

**A trade or secured asset sent from a THORChain or Maya address** is not
returned: its unfilled part is credited back to the sender on the chain, and
its refund stays `pending` with no outputs. The swap exports the part swapped,
which is all that left the wallet, with no warning.

**An L1 return not paid yet.** The swap lists no return output, so it exports
only the part swapped, with a warning. Once paid, the swap's next export nets
the return off the deposit (the row keeps its ID). The pending refund is
covered by the successful swap of its txid (`pending.md`), and its outputs
list the swap's output, so it is never exported: a return that is never paid
gives no row, and the warning asks for its loss to be entered by hand.

## Tests

- Unit tests for `getInboundFee` and each mapper's fee, including:
  - THORNode gas is preferred over any default
  - a missing THORNode tx gives the native default, or blank for L1 inputs
  - THORNode with no gas falls back to Viewblock's observation (non-EVM L1)
  - an EVM inbound takes its receipt's fee (plus `l1Fee` on BASE), never
    THORNode's or Viewblock's, and a missing receipt is an error
  - L1 liquidity deposits use the THORNode gas
    (`liquidity/add-btc-rune-symmetric`)
  - a refund is one `FailedIn` row with the outbound network fee
    (`refund/btc-price-limit`), or no fee when Midgard lists none
    (`refund/rune-price-limit`); the outbound is not exported
  - a refund of an affiliate's cut has no row (`refund/affiliate-fee-swap`)
  - a partially filled swap trades out the deposit less the return, whichever
    way Midgard lists the deposit (`swap/btc-to-wbtc-partial-fill-more-returned`,
    `swap/btc-to-wbtc-partial-fill-mostly-returned`,
    `maya/swap-btc-to-eth-partial-fill`, `maya/swap-rune-partial-fill-blank-meta`),
    to the sender's own address (`swap/tron-usdt-to-trx-partial-fill-to-sender`)
    or credited back as a trade asset (`swap/trade-partial-fill-credited`); its
    refund has no row (`refund/btc-partial-fill`)
  - `networkFees` (except for refunds), `liquidityFee` and affiliate outputs are
    never used as fees
- Golden cases in `test/cases/` carry the expected fee in each row.
