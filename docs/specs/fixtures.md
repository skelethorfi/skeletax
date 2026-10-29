# Test fixtures (golden cases)

## Summary

Every supported transaction type is covered by golden cases: real Midgard,
Viewblock or TCY distribution data, with the CSV rows the exporter must produce.
Cases must never contain a contributor's own wallets or transactions.

## Layout

```
test/cases/<group>/<name>/
  input.json      raw source data (a raw bundle)
  activity.yaml   reviewed activities (activity.md); none when the action gives none
  expected.yaml   reviewed CSV rows
```

`input.json`:

| Field         | Meaning                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `description` | What the case covers                                                                                                        |
| `source`      | `midgard`, `viewblock` or `tcy`                                                                                             |
| `wallet`      | The wallet being exported (used by the viewblock and tcy mappers)                                                           |
| `data`        | The Midgard action, Viewblock tx or TCY distribution item, as returned by the API                                           |
| `protocol`    | Optional, `maya` for a Maya case (default `thorchain`)                                                                      |
| `thornodeTxs` | Optional related THORNode `tx/status` responses (swaps and switches)                                                        |
| `cosmosTxs`   | Optional Cosmos txs of a contract action                                                                                    |
| `usdPrices`   | Optional USD prices at the action's time, by `THOR.RUNE`, `MAYA.CACAO` or pool (`prices.md`); the fixture tool fetches them |
| `treatment`   | Optional config choices the case is mapped with, e.g. `{"referencePrices": "all"}`                                          |

`test/GoldenCases.test.ts` runs every case through `runBundle`, the same path the
exporter uses, and compares the result with `expected.yaml`. It also compares the activities
with `activity.yaml` (none means no activities), so an interpreter bug and an
exporter bug fail different checks. `npm run fixture -- show` prints both, and `--write` saves
both after review. A case without
`expected.yaml` is reported as a todo: its input is in, but its mapper or review is
not.

## Required behaviour

### Source of a case

1. Prefer a public transaction from someone else with the same shape as the
   transaction being supported. The shape is the action type, its subtype
   (swap `txType` or contract `contractType`), status, input and output assets,
   and contract funds denoms.
2. Only if no such transaction exists, anonymise one with `npm run fixture --
anonymise`. It replaces every address, txid, signature and other base64
   blob, and every name in a memo (THORNames, affiliates, aggregator codes),
   with a placeholder; sets every date, time and block height to one fixed
   value (2020-12-31 13:00 UTC, height 10000000, as in the hand-made cases)
   and every USD price to 1; blanks a refund's `reason`; and replaces every
   number (including those in coin strings, memos and JSON inside strings) by
   its rank among the case's amounts (the smallest becomes 10, the next 20,
   …). An EVM receipt's fee (gas used × price, plus any L1 fee) is ranked
   as one amount and written back as 1 gas at that price. Each original value can identify a transaction on-chain on its own,
   but the mappers depend on amounts only through equality and order, which
   ranks keep: every golden case and the owner's private fixtures give the
   same rows once anonymised.

   It then refuses to write the case if any token (4+ letters or digits) of
   the original survives that is not already in the public repo (`src/`,
   `docs/`, `test/`). That catches what the rules miss.

   It also writes `TO-REVIEW.md` next to the case, with a checklist. A fresh
   reviewer checks the case and deletes the file. Until then, the owner's
   pre-commit hook blocks committing anything in the case's folder, and CI
   fails if one is pushed. The review matters because the case's shape
   (action type, asset pair, contract type) remains.

### Expected output

`expected.yaml` is written only after a person has checked the rows against the
spec for that transaction type. Saving the mapper's current output without
review would turn a bug into the expected result.

`expected.yaml` holds one YAML document per CSV row, separated by `---`, in
output order. A case that produces no rows contains only `[]`.

YAML is used so the rows are easy to review and can carry `#` comments
explaining why a value is what it is. Amounts and other number-like strings
must stay quoted (`"0.02"`), because the exporter outputs strings; `show --write`
quotes them automatically, and an unquoted number fails the test rather than
passing silently.

### Private data

Keep your own configs, caches and outputs in a folder outside the repo, and set
`TCT_PRIVATE_DIR` to it. The fixture tool then refuses to write a case
containing any address from that folder's `*.toml` configs, any 64-hex txid
found in it, or any entry in its `private-denylist.txt`. It prints only an
8-character prefix of each match.

Without `TCT_PRIVATE_DIR` there is nothing to check against, so the tool
warns, and `fetch` needs an explicit `--out` file.

## Workflow

```
npm run fixture -- fetch <txid>                       # saves to $TCT_PRIVATE_DIR/fixtures (or --out)
npm run fixture -- similar <private input.json>       # public txs of the same shape
npm run fixture -- add <public txid> <group/name>     # writes test/cases/<group/name>/input.json
npm run fixture -- anonymise <input.json> <group/name>  # fallback
npm run fixture -- show test/cases/<group/name>       # print rows; add --write after review
```

Notes:

- Midgard contract actions carry their amounts in `metadata.contract.funds`, not in `coins`.
- `similar` pages back by block `height` from the original transaction, because
  `timestamp` queries time out on the Liquify gateway.
