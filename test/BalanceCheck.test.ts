import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import {
  balanceReport,
  computeHoldings,
  formatDecimal,
  fromBase,
  type Holdings,
  parseDecimal,
} from "../src/pipeline/balances.ts";
import { type SummRow, SummRowType } from "../src/export/summ/csv/index.ts";
import { readCaseExpected } from "../src/fixtures/GoldenCase.ts";
import { bankCurrency, BankBalanceService } from "../src/sources/thorchain/BankBalanceService.ts";
import { MAYA, THORCHAIN, withAssetNames } from "../src/domain/Protocol.ts";
import { RecordStore, StoreMissError } from "../src/sources/store/RecordStore.ts";
import { http } from "../src/sources/http.ts";
import { Exporter } from "../src/cli/Exporter.ts";
import { renderSummary } from "../src/cli/RunSummary.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-balances-"));
const caseRows = (name: string) => readCaseExpected(`test/cases/${name}`) as SummRow[];
// One wallet's holdings as decimal strings
const held = (holdings: Holdings, wallet: string) =>
  Object.fromEntries([...(holdings.get(wallet) ?? new Map()).entries()].map(([c, a]) => [c, formatDecimal(a)]));

const row = (fields: Partial<SummRow>): SummRow =>
  ({ timestamp: new Date("2025-01-01T00:00:00Z"), baseAmount: "1", baseCurrency: "RUNE", ...fields }) as SummRow;

describe("balance check: amounts", () => {
  test("decimal strings are summed exactly", () => {
    assert.equal(parseDecimal("0.02"), 2n * 10n ** 16n);
    assert.equal(formatDecimal(parseDecimal("13.5713431") + parseDecimal("0.02")), "13.5913431");
    assert.equal(formatDecimal(parseDecimal("-1")), "-1");
    assert.equal(formatDecimal(fromBase("44199202190031", 10)), "4419.9202190031");
    assert.throws(() => parseDecimal(""), /Invalid amount/);
    assert.throws(() => parseDecimal("1e5"), /Invalid amount/);
  });
});

describe("balance check: holdings from rows", () => {
  test("a symmetric add: the RUNE and its fee leave the THORChain wallet, the LP units arrive; the price helper moves nothing", () => {
    const holdings = computeHoldings(caseRows("liquidity/add-btc-rune-symmetric"));

    assert.deepEqual(held(holdings, "thor1svp82fwx0lh80cakfg5gglgdkrnkh4yx3atcpn"), {
      RUNE: "-13.5913431",
      "ThorLP.BTC.BTC": "9.04731548",
    });
    assert.deepEqual(held(holdings, "bc1q3t9a9cefynlf5emcmv6dm253p3en9st7nne7j3"), { BTC: "-0.0002818" });
  });

  test("a withdrawal: the LP units go back, the assets come in", () => {
    const holdings = computeHoldings(caseRows("liquidity/withdraw-btc-rune-symmetric"));

    assert.deepEqual(held(holdings, "thor1ef95h5r7xcvahpw480pacslhutw6t6770phu0z"), {
      "ThorLP.BTC.BTC": "-4517.87555095",
      RUNE: "5271.36655272",
    });
  });

  test("a refund: the failed-out row moves only its fee; what was kept is a fee row", () => {
    const holdings = computeHoldings(caseRows("refund/btc-price-limit"));

    assert.deepEqual(held(holdings, "bc1qkk788zfqyh7pgjke63xpg5zrlf27q359ke3x5p"), { BTC: "-0.00005395" });
  });

  test("a sell moves the base out and the quote in; an EVM wallet is one wallet in any case", () => {
    const holdings = computeHoldings([
      row({
        type: SummRowType.Sell,
        wallet: "thor1w",
        from: "thor1w",
        to: "thor1w",
        baseCurrency: "RUNE",
        baseAmount: "10",
        quoteCurrency: "BRUNE",
        quoteAmount: "9.5",
        feeCurrency: "RUNE",
        feeAmount: "0.02",
      }),
      row({ type: SummRowType.Receive, wallet: "0xAbC0000000000000000000000000000000000001", from: "x" }),
      row({
        type: SummRowType.BridgeTradeIn,
        wallet: "0xabc0000000000000000000000000000000000001",
        to: "0xABC0000000000000000000000000000000000001",
        baseCurrency: "ETH",
        baseAmount: "2",
      }),
    ]);

    assert.deepEqual(held(holdings, "thor1w"), { RUNE: "-10.02", BRUNE: "9.5" });
    assert.deepEqual(held(holdings, "0xabc0000000000000000000000000000000000001"), { ETH: "2" });
  });
});

describe("balance check: report", () => {
  const holdings: Holdings = new Map([
    [
      "thor1w",
      new Map([
        ["RUNE", parseDecimal("100")],
        ["TCY", parseDecimal("-5")],
        ["ThorLP.BTC.BTC", parseDecimal("9")],
        ["ThorSynth.BTC.BTC", parseDecimal("0.0000000001")],
      ]),
    ],
    [
      "bc1w",
      new Map([
        ["BTC", parseDecimal("-1")],
        ["ThorSavers.BTC.BTC", parseDecimal("-0.5")],
      ]),
    ],
  ]);

  test("flags holdings below zero, and each bank balance that differs from the rows by more than dust", () => {
    const report = balanceReport(holdings, [
      {
        address: "thor1w",
        name: "main",
        native: true,
        source: "THORNode",
        onChain: new Map([
          ["RUNE", parseDecimal("98.5")],
          ["RUJI", parseDecimal("3")],
        ]),
      },
      { address: "bc1w", name: "btc", native: false },
    ]);

    assert.deepEqual(report.lines, [
      "main (thor1w) TCY: rows give -5, below zero (a row with the wrong sign, or a missing acquisition)",
      "main (thor1w) RUJI: rows give 0, THORNode balance 3 (difference +3)",
      "main (thor1w) RUNE: rows give 100, THORNode balance 98.5 (difference -1.5)",
      "main (thor1w) TCY: rows give -5, THORNode balance 0 (difference +5)",
      // BTC below zero is expected of an L1 wallet: it is funded outside THORChain. A savers position is not.
      "btc (bc1w) ThorSavers.BTC.BTC: rows give -0.5, below zero (a row with the wrong sign, or a missing acquisition)",
    ]);
    assert.deepEqual([report.checked, report.differences, report.negatives], [1, 3, 2]);
  });

  test("a wallet whose balance could not be read says why", () => {
    const report = balanceReport(new Map(), [
      { address: "thor1x", name: "x", native: true, notChecked: "Offline: nothing stored for thornode-balance thor1x" },
    ]);

    assert.deepEqual(report.lines, [
      "x (thor1x): bank balance not checked: Offline: nothing stored for thornode-balance thor1x",
    ]);
    assert.equal(report.checked, 0);
  });
});

describe("balance check: bank denoms", () => {
  test("each denom gets the currency name its rows use", () => {
    const name = (denom: string, protocol = THORCHAIN) => bankCurrency(denom, protocol);

    assert.deepEqual(name("rune"), { currency: "RUNE", decimals: 8 });
    assert.deepEqual(name("tcy"), { currency: "TCY", decimals: 8 });
    assert.deepEqual(name("btc/btc"), { currency: "ThorSynth.BTC.BTC", decimals: 8 });
    assert.deepEqual(name("btc-btc"), { currency: "BTC", decimals: 8 });
    assert.deepEqual(name("eth-usdc-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), { currency: "USDC", decimals: 8 });
    assert.deepEqual(name("btc-btc", withAssetNames(THORCHAIN, { prefixSecuredAssets: true })), {
      currency: "ThorSecured.BTC.BTC",
      decimals: 8,
    });
    assert.deepEqual(name("x/ruji"), { currency: "RUJI", decimals: 8 });
    assert.deepEqual(name("x/staking-x/ruji"), { currency: "SRUJI", decimals: 8 });
    assert.equal(name("ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2").decimals, 8);
    assert.deepEqual(name("cacao", MAYA), { currency: "CACAO", decimals: 10 });
    assert.deepEqual(name("maya", MAYA), { currency: "MAYA", decimals: 4 });
  });
});

describe("balance check: run", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test("the balance is stored, fetched again on the next run, and read from the store offline", async () => {
    const dir = tempDir();
    let rune = "100000000";
    const get = mock.method(http, "get", async (url: string) => ({
      data: { balances: [{ denom: "rune", amount: rune }], pagination: { next_key: null, total: "1" } },
      url,
    }));
    const service = (offline = false) =>
      new BankBalanceService(new RecordStore(dir, { offline }), "https://node", "thornode-balance");

    assert.deepEqual(await service().balances("thor1w"), { balances: [{ denom: "rune", amount: "100000000" }] });
    rune = "50000000";
    assert.deepEqual(await service().balances("thor1w"), { balances: [{ denom: "rune", amount: "50000000" }] });
    assert.deepEqual(await service(true).balances("thor1w"), { balances: [{ denom: "rune", amount: "50000000" }] });
    await assert.rejects(service(true).balances("thor1other"), StoreMissError);
    assert.deepEqual(
      get.mock.calls.map((call) => call.arguments[0]),
      [
        "https://node/cosmos/bank/v1beta1/balances/thor1w?pagination.limit=1000",
        "https://node/cosmos/bank/v1beta1/balances/thor1w?pagination.limit=1000",
      ],
    );
  });

  test("a run compares its THORChain wallets with THORNode and writes the findings to summary.md", async () => {
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    const dir = tempDir();
    const config = path.join(dir, "config.toml");
    fs.writeFileSync(
      config,
      [
        'fromDate = "2025-01-01"',
        'toDate = "2025-12-31"',
        'frequency = "yearly"',
        'wallets = [{ name = "main", address = "thor1svp82fwx0lh80cakfg5gglgdkrnkh4yx3atcpn", blockchain = "THOR" },',
        '  { name = "btc", address = "bc1q3t9a9cefynlf5emcmv6dm253p3en9st7nne7j3", blockchain = "BTC" }]',
        "",
      ].join("\n"),
    );
    const get = mock.method(http, "get", async (url: string) => ({
      data: { balances: [{ denom: "rune", amount: "1000000000" }] },
      url,
    }));
    const exporter = new Exporter(config, { today: new Date("2026-10-30T00:00:00Z") });

    await exporter.checkBalances(caseRows("liquidity/add-btc-rune-symmetric"));

    // Only the THORChain wallet has a bank balance
    assert.equal(get.mock.calls.length, 1);
    assert.match(String(get.mock.calls[0].arguments[0]), /balances\/thor1svp82/);
    assert.deepEqual(exporter.report.balances, [
      "main (thor1svp82fwx0lh80cakfg5gglgdkrnkh4yx3atcpn) RUNE: rows give -13.5913431, below zero (a row with the wrong sign, or a missing acquisition)",
      "main (thor1svp82fwx0lh80cakfg5gglgdkrnkh4yx3atcpn) RUNE: rows give -13.5913431, THORNode balance 10 (difference +23.5913431)",
    ]);
    assert.match(
      exporter.report.counts.join("\n"),
      /Balance check: 1 THORChain and Maya wallets compared with their bank balance; 1 differences, 1 holdings below zero/,
    );
    assert.match(renderSummary(exporter.report), /## Balance check \(2\)/);

    // A row the check can't read skips the check with a warning
    await exporter.checkBalances([row({ type: SummRowType.Receive, wallet: "thor1w", to: "thor1w", baseAmount: "x" })]);
    assert.match(exporter.report.warnings.join("\n"), /Balance check skipped: Invalid amount: x/);

    // Offline, a wallet with no stored balance is listed as not checked
    fs.removeSync(path.join(dir, "store"));
    const offline = new Exporter(config, { offline: true, today: new Date("2026-10-30T00:00:00Z") });
    await offline.checkBalances([]);
    assert.deepEqual(offline.report.balances, [
      "main (thor1svp82fwx0lh80cakfg5gglgdkrnkh4yx3atcpn): bank balance not checked: Offline: nothing stored for thornode-balance thor1svp82fwx0lh80cakfg5gglgdkrnkh4yx3atcpn (run without --offline to fetch it)",
    ]);
  });
});
