# Sends

A send moves a coin from one THORChain (or Maya) address to another with a
`MsgSend`, outside any protocol action. It gives one row per configured wallet it
touches: a `send` on the sending wallet, with the fee, and a `receive` on
the receiving wallet. Nothing is swapped, so a send between two configured
wallets is a transfer, and Summ pairs the two rows.

## Sources

Sends come from Midgard (`send` actions on THORChain). Midgard's history of
sends is incomplete before the chain upgrade of March 2022, and THORNode no
longer serves those txs, so Viewblock fills the gap:

| Sends             | Source                                                              |
| ----------------- | ------------------------------------------------------------------- |
| From 2022-04-01   | Midgard                                                             |
| Before 2022-04-01 | Midgard, plus each Viewblock send with a txid Midgard does not list |

Viewblock is called only when a run exports a period that starts before
2022-04-01. Its address listing gives every tx of the wallet; only sends
dated before the cutoff are kept, and a send Midgard also lists is dropped,
so the overlap gives no second row. A run for a later period never calls
Viewblock, so if its unofficial API changes, only such runs are affected.

### Viewblock is best-effort

Viewblock's API is unofficial, its quota is small, and a 429 can lock a
client out for days (the answer's `value`, in ms; about 7 days was seen). So
nothing Viewblock does ends a run; each case is a warning in the run summary
(`run-summary.md`, Warnings):

| Case                                                          | The run                                                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A wallet's complete list is stored                            | uses it and does not fetch it again: the sends before 2022-04 do not change. `--refetch-all` fetches it again                                                                             |
| The listing ends short of the `total` it reports              | keeps what was listed, marked short (`incomplete` in the stored list and the manifest), and warns that a send may be missing                                                              |
| A wallet's stored list is short                               | fetches it again on the next default run, keeping the stored list if that fails or comes back as short; every run that uses a short list (offline and `--replay` too) repeats the warning |
| A 429                                                         | is not retried; Viewblock is asked nothing more in the run (lists and inbound gas, `fees.md`), and the summary says until when it is locked out                                           |
| A list cannot be fetched (429, or an error after the retries) | uses the list stored by an earlier run; with none, the wallet's Viewblock sends are missing, and the summary says so                                                                      |
| `--offline` with no list stored                               | an error, as for every source                                                                                                                                                             |

The listing is paged until a page comes back empty or adds no new tx, or the
`total` is reached: the `pages` it reports has been seen to stop short of its
`total` (25 listed of 39, 200 of 220).

Maya sends (Maya's Midgard `send`, e.g. of `CACAO` or the MAYA token) are
mapped the same way, from Maya's Midgard, with Maya's native fee (below).

## Which sends give rows

A `MsgSend` with a memo can be another action's inbound:

- on THORChain, a swap paid by `MsgSend` with an `=` memo, or a TCY unstake
  request (`tcy-` memo, no coins): THORChain's Midgard lists the same txid as
  a `send` and as the action (`swap`, `tcy_unstake`);
- on Maya, RUNE sent to Maya's vault on THORChain with a Maya memo (e.g. a
  swap of RUNE to another chain): THORChain's Midgard lists only a `send`,
  and Maya's Midgard lists the action, with the same txid as its inbound.

The action gives the rows; **a send whose txid is also the inbound of
another listed action, on any protocol, gives none**.

A `MsgSend` can also be another action's **outbound**: Maya pays RUNE out on
THORChain by `MsgSend` from its vault, so a Maya swap to RUNE, a withdrawal
of a RUNE side or a refund of RUNE shows on THORChain's Midgard as a `send`
to the wallet, besides the Maya action that already gives the received RUNE.
**A send is an outbound, and gives no row, when its txid is in another
listed action's outbounds, or its memo is `REFUND:<txid>` or `OUT:<txid>`
naming another listed action's inbound txid.** Otherwise the same RUNE
would be received twice.

Maya's Midgard can leave a refund it paid this way `pending` with no
outbound. When a send's memo names such a refund, the send is its outbound:
the refund is exported as paid (a `FailedOut`, and a `Fee` for what it did
not return, `fees.md`), not as a stuck refund's `Lost` (`pending.md`). The
run summary still lists the refund under Not final, as Midgard's status is
unchanged.

A send whose memo asks for an action (`=`, `+`, `-`, `swap`, `trade+`,
`loan+`, `~` and so on) and that no listed action matches still gives a
`send` row, as the coin left the wallet, with a warning: most likely a
protocol received it whose actions the run does not list, e.g. a Maya swap
in a config whose `protocols` leaves out `maya`. The run ends with one warning line
counting these sends; when `maya` is not in `protocols`, it says to add it.

A send **to itself** with such a memo reached no protocol, so it did nothing
but pay its fee (most likely a failed attempt at the action, e.g. a TCY claim
sent to the claiming wallet rather than to THORChain; the TCY claims page had
faults in May 2025). Like any send to itself (Rows, below), it gives one
`fee` row for its gas, as only the fee was paid, with a warning that says so,
and is not counted in that end-of-run line.

A send with no coins (only a memo) moves nothing and gives no row.

A failed send (Midgard status `failed`; Viewblock `code` other than 0, e.g.
5 for an insufficient balance) moved no coin and nothing came back. Whether
it paid the native fee depends on when it was sent:

- **From THORChain block 11,637,012 (2023-07-10)**, the first on version
  1.115.0, the fee is taken in the ante handler, before the message runs,
  and kept when the message fails (thornode commit `335fda2ce`, "deduct
  native tx fees during ante"). THORNode shows such a tx with its code and a
  single transfer of 0.02 RUNE from the sender to the Reserve. It gives one
  `fee` row for the gas on the sender's side (Rows, below), with or without
  coins, and nothing on the receiver's. Its activity has status `failed` and
  the gas leg only. Golden case: `send/midgard-rune-failed`.
- **Before that**, the send handler checked the balance before charging the
  fee, and a failed message's changes were rolled back, fee included: it
  paid nothing and gives no row. Every Viewblock send (before 2022-04) is in
  this period. Midgard reports 0.2 RUNE `networkFees` on such sends, which
  is not what was paid, so it is not used.
- **On Maya**, a failed send never pays the native fee, so it gives no row.
  Mayanode charges the fee in the send handler (`handleV127` in
  `x/mayachain/handler_send.go`), and a failed message's changes are rolled
  back, fee included. Its ante handler, active from version 1.133.0 (first
  block 18,613,349, 2026-09-30; mayanode commit `f86ed80df`, "custom ante
  handler port from THORNode"), only checks that the sender can cover the
  amount and the fee; it charges nothing ("the actual fee deduction stays
  in the delivery handler"). Mayanode shows a failed send before that
  height (halted chain, transfers disabled, insufficient funds) with its
  code and no transfer to the Reserve. From that height an underfunded
  send is turned away before it reaches a block, and Maya's Midgard lists
  no failed send after it. A few failed sends carry a Cosmos SDK fee that
  the wallet set in the tx (`auth_info.fee`, e.g. 7,500 base units, under
  0.000001 CACAO), which goes to the fee collector even though the message
  failed. It is dust and is not exported.

The block is `failedTxFeeFromHeight` in `src/domain/Protocol.ts`; MAYA has
none.

## Activity

Kind `send`, from the side of the wallet whose listing gave it (as TCY
distributions): a send between two configured wallets is mapped twice, once
for each.

| Wallet                                            | Legs                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Sender                                            | out: principal, the coin sent (observed); out: gas, 0.02 RUNE (default) |
| Receiver                                          | in: principal, the coin received (observed)                             |
| Both (a send to itself, e.g. an Arkeo delegation) | as the sender                                                           |

`details.purpose` is `delegate-arkeo` for a memo starting `delegate:arkeo:`.
`details.failedAction` names the action a send to itself with an action memo
attempted (Rows).

## Fee

The fee is THORChain's native fee, 0.02 RUNE, paid in RUNE whatever coin is
sent, and only by the sender. Neither source states it per tx in what the
exporter reads:

- Midgard's `networkFees` on a send is 0.2 RUNE on every send in every year,
  and names the sent coin as its asset when the coin is not RUNE. THORNode
  shows 0.02 RUNE paid to the Reserve for the same txs, so Midgard's value is
  not used.
- Viewblock's address listing has no fee; its single-tx endpoint shows 0.02
  RUNE on sends from 2021 to 2026.

So the gas leg is the 0.02 RUNE default. On Maya it is Maya's native fee as
set at the send's height, which has changed over time (`maya.md`, Fees);
Maya's Midgard reports 0.2 CACAO for every send, so it is not used either.

## Rows

| Row                                                       | Type      | Base                | Fee       | From, to           | Description                                                                                                                        |
| --------------------------------------------------------- | --------- | ------------------- | --------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Sender                                                    | `send`    | the coin and amount | 0.02 RUNE | sender, receiver   | `Send <amount> <coin>; <txid>`                                                                                                     |
| Receiver                                                  | `receive` | the coin and amount | —         | sender, receiver   | `Receive <amount> <coin>; <txid>`                                                                                                  |
| Receiver, sender in `incomeFrom`                          | `income`  | the coin and amount | —         | sender, receiver   | `Income: receive <amount> <coin>; <txid>`                                                                                          |
| Send to itself                                            | `fee`     | the gas, 0.02 RUNE  | —         | the wallet, itself | `Fee: send <amount> <coin> to itself; <txid>`                                                                                      |
| Send to itself with an action memo (a failed attempt)     | `fee`     | the gas, 0.02 RUNE  | —         | the wallet, itself | `Fee: failed <action> sent to itself; <txid>`, e.g. `TCY claim` for `tcy:`, `TCY stake` for `tcy+:`, else `'<memo prefix>' action` |
| Failed send from THORChain block 11,637,012 (sender only) | `fee`     | the gas, 0.02 RUNE  | —         | sender, receiver   | `Fee: failed send; <txid>`                                                                                                         |
| Arkeo delegation (a send to itself)                       | `fee`     | the gas, 0.02 RUNE  | —         | the wallet, itself | `1/1 - DelegateArkeoWallet; <txid>`                                                                                                |

A send to itself moves nothing out of the wallet: the coin sent comes straight
back, so it is neither a disposal nor a transfer, and only the gas is a cost.
It is exported as one `fee` row for the gas. A `send` row of the coin would
let Summ pair it, as an outgoing transfer, with an unrelated receive of the
same amount. The amount sent is whatever the wallet chose (an Arkeo
delegation works with 0.00000001 RUNE or 1 RUNE alike) and only appears in
the description of a plain send to itself.

`<coin>` is `Synth DOGE` for a synth and `Trade BTC` for a trade asset;
otherwise the ticker. The blockchain is THORChain, or Mayachain for a Maya
send. The base currency is the
coin's name as every other row names it (`assets.md`), so a synth received
from a swap and later sent is one currency in Summ. A bare coin name is the
protocol's own chain's: Midgard and Viewblock write TCY as `TCY`, which is
`THOR.TCY`, and Maya's Midgard writes the MAYA token as `MAYA`, which is
`MAYA.MAYA` (4 decimals).

**Income.** Whether a transfer received is income depends on who sent it,
which the chain does not say: a project's reward distribution is an ordinary
wallet, not a protocol module, and neither Midgard nor the node lists them.

- **Known distribution wallets** (`KNOWN_DISTRIBUTORS` in
  `src/export/summ/send.ts`), identified by what they do (2026-10-08): on
  Maya, a MAYA distribution wallet (2,147 of its 2,150 sends are MAYA, to 868
  recipients, no memo) and the treasury that funds it (3,635 of its 3,860
  sends are MAYA, to 2,549 recipients; it also trades, takes funds in from
  many senders and sends CACAO and other tokens). Their **MAYA** transfers are
  income; anything else they send is a `receive`, and the run warns of it, as
  it may be a refund, a return or a trade.
- **`incomeFrom = ["<address>", …]`** in the config replaces that list: a
  transfer received from a listed sender is `income`, whatever the coin, and
  every other is a `receive`; `incomeFrom = []` turns income off.

The run summary counts the receipts that are income by default. A row's ID
is that of the received coin either way (`periods.md`), so changing the list
changes the row's type, not its ID.
