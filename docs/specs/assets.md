# Asset names

Midgard writes assets as `CHAIN<separator>ASSET`. The separator tells where
the asset lives:

| Midgard                   | Kind                                                                                       | Lives on                | Exported currency                   | Blockchain column |
| ------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------- | ----------------- |
| `BTC.BTC`                 | L1 asset                                                                                   | its own chain (Bitcoin) | `BTC`                               | `BTC`             |
| `THOR.RUNE`, `THOR.RUJI`  | native THORChain token                                                                     | THORChain               | `RUNE`, `RUJI`                      | `THORChain`       |
| `BTC/BTC`                 | synth                                                                                      | THORChain               | `ThorSynth.BTC.BTC`                 | `THORChain`       |
| `BTC~BTC`                 | trade asset                                                                                | THORChain               | `BTC` (the L1 asset's name)         | `THORChain`       |
| `BTC-BTC`, `ETH-USDC-0X…` | secured asset                                                                              | THORChain               | `BTC`, `USDC` (the L1 asset's name) | `THORChain`       |
| `X/RUJI`                  | Cosmos denom on THORChain (`x/ruji`), not a synth                                          | THORChain               | `RUJI`                              | `THORChain`       |
| `X/SRUJI`, `X/YBRUNE`     | Rujira liquid staking receipt token (`x/staking-x/ruji`, `x/staking-x/brune`; `rujira.md`) | THORChain               | `SRUJI`, `YBRUNE`                   | `THORChain`       |

On Maya Protocol the synth prefix is `Maya` (`MayaSynth.BTC.BTC`) and the
blockchain is Maya Protocol's (`maya.md`).

Every row follows the Blockchain column above, whatever its type: swaps, fees,
liquidity deposits and withdrawals, and sends alike. A protocol's own chain is
always Summ's name for it (`THORChain`, `Mayachain`), never Midgard's chain id
(`THOR`, `MAYA`); an L1 chain keeps Midgard's id (`BTC`, `KUJI`).

Why:

- Summ lists THORChain as `THORChain` (integration id `thorchain`). A test
  upload of four otherwise identical rows into a THORChain wallet attached
  `THORChain`, `thorchain` and a blank column to the `thorchain` chain (a
  blank one is inferred from the wallet), and gave the `THOR` row no chain
  at all. So `THOR` is worse than leaving the column blank. The row's
  amounts and prices are unaffected; the chain is what Summ's transfer
  matching and per-chain views use.
- A synth is pool-backed exposure to another chain's asset, a different
  holding from that asset and held on a different chain. If both export as
  `BTC`, Summ mixes their balances and cost bases. The prefix says where it
  lives; `<chain>.<asset>` says what it gives exposure to. It is the same
  `<prefix>.<chain>.<asset>` shape as liquidity tokens (`ThorLP.BTC.BTC`) and
  savers tokens (`ThorSavers.BTC.BTC`, `savers.md`). No `/`: a slash in a
  currency breaks Summ's ledger view.
- Trade and secured assets are the L1 asset held 1:1 on THORChain, like a
  bridged token on another chain, so they keep the L1 asset's name with
  THORChain as the blockchain. Moving an asset into or out of them is still
  exported as a swap today; exporting it as a bridge (not a disposal) is an
  open item.
- Native THORChain tokens use their ticker, as Summ prices them: `RUNE`,
  `TCY`, `RUJI`. `x/ruji` in contract actions is the same token as
  `THOR.RUJI`.
- Descriptions keep Midgard's notation (`BTC/BTC`, `BTC~BTC`, `ETH-USDC`).

## Config

Trade and secured assets can be prefixed instead, per kind, in the config:

```toml
[assets]
prefixSecuredAssets = true   # ETH-USDC → ThorSecured.ETH.USDC (default false: USDC)
prefixTradeAssets = true     # BTC~BTC  → ThorTrade.BTC.BTC   (default false: BTC)
```

Both are optional; a config without `[assets]` exports L1 names. Synths are
always prefixed. On Maya the prefix is `Maya` (`MayaSecured.BTC.BTC`).

Summ does not recognise the synth names, so their value comes from the CSV's
reference price columns: every row Midgard prices carries one (`prices.md`).

## History

- Before April 2026 a synth was exported as its ticker (`BTC`).
- April 2026 to October 2026: a synth was `BTC.BTC`, which reads like L1 BTC;
  trade and secured assets had the L1 chain as their blockchain; `x/ruji` was
  `X.RUJI`.
- Before April 2026 every THORChain row had `THOR` as its blockchain.
- April 2026 to October 2026: most rows had `THORChain`, but liquidity
  deposit and withdrawal rows and sends kept Midgard's chain id
  (`THOR`, `MAYA`) for a protocol-native asset, so Summ gave them no chain.
  Maya Protocol's other rows had `MayaProtocol`; all now have `Mayachain`
  (`maya.md`).

A holding open when its name changes splits into two balances in Summ (the
old name goes negative). Check positions open across a re-export.

## Tests

`test/MidgardUtils.assets.test.ts`.
