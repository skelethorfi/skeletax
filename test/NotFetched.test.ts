import { beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { Exporter, NOT_FETCHED_FILE } from "../src/cli/Exporter.ts";
import { renderSummary } from "../src/cli/RunSummary.ts";
import type { Source } from "../src/sources/Source.ts";
import type { RawBundle } from "../src/sources/RawBundle.ts";
import type { NotFinal } from "../src/sources/Pending.ts";
import { StoreMissError } from "../src/sources/store/RecordStore.ts";

// A public send of the wallet 'Main' (test/cases/send/midgard-rune)
const input = fs.readJsonSync(path.join(import.meta.dirname, "cases/send/midgard-rune/input.json"));
const MAIN = input.wallet as string;
const OTHER = "thor1t60f02r8jvzjrhtnjgfj4ne6rs5wjnejwmj7fh";
const send: RawBundle = {
  source: "midgard",
  protocol: "thorchain",
  wallet: MAIN,
  data: input.data,
  thornodeTxs: [],
  cosmosTxs: [],
};

function exporter(): { exporter: Exporter; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tct-not-fetched-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(
    file,
    [
      'fromDate = "2026-01-01"',
      'toDate = "2026-12-31"',
      'frequency = "yearly"',
      'referencePrices = "swaps"',
      "",
      "[[wallets]]",
      'name = "Main"',
      `address = "${MAIN}"`,
      'blockchain = "THOR"',
      "",
      "[[wallets]]",
      'name = "Other"',
      `address = "${OTHER}"`,
      'blockchain = "THOR"',
    ].join("\n"),
  );
  return { exporter: new Exporter(file, { offline: true, today: new Date("2026-11-01") }), dir };
}

// A source that lists the send for Main and fails for Other, after reporting one of Other's actions as not final
function sources(target: Exporter, error: Error): Source[] {
  return [
    {
      name: "midgard",
      bundlesFor: async (wallet) => {
        if (wallet === OTHER) {
          target.notFinal.push({ key: "midgard/swap.OTHER", action: {} } as unknown as NotFinal);
        }
        return wallet === MAIN ? [send] : [];
      },
    },
    {
      name: "tcy",
      bundlesFor: async (wallet) => {
        if (wallet === OTHER) {
          throw error;
        }
        return [];
      },
    },
  ];
}

describe("a wallet a source fails for", () => {
  beforeEach(() => {
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
  });

  test("is skipped whole, with its error in the summary, and the other wallets go on", async () => {
    const { exporter: target } = exporter();
    target.sources = () => sources(target, new Error("Request failed with status code 503"));

    const bundles = await target.collectBundles();

    assert.deepEqual(bundles, [send]);
    assert.deepEqual(target.notFinal, []);
    assert.deepEqual(
      target.notFetched.map(({ wallet, source, error }) => [wallet.name, source, error]),
      [["Other", "tcy", "Request failed with status code 503"]],
    );
    assert.match(
      renderSummary(target.report),
      new RegExp(
        `## Not fetched \\(no rows or CSV files for these wallets\\) \\(1\\)\n\n- Other \\(${OTHER}\\): tcy: Request failed with status code 503\n`,
      ),
    );
  });

  test("gets no CSV file, and the run lists it for summ-sync", async () => {
    const { exporter: target, dir } = exporter();
    target.sources = () => sources(target, new StoreMissError("tcy distribution " + OTHER));
    const output = path.join(dir, "run");

    const bundles = await target.collectBundles();
    target.writeNotFetched(output);
    target.saveToCsv(target.getRows(bundles, output), path.join(output, "csv"));

    assert.deepEqual(fs.readJsonSync(path.join(output, NOT_FETCHED_FILE)), {
      version: 1,
      wallets: [
        {
          name: "Other",
          address: OTHER,
          source: "tcy",
          error: `Offline: nothing stored for tcy distribution ${OTHER}`,
        },
      ],
    });
    const files = fs.readdirSync(path.join(output, "csv")).filter((name) => name.startsWith("2026"));
    assert.deepEqual(files, ["2026-01-01_2026-12-31_THOR_g0e7k_Main.csv"]);
  });

  test("gets no rows even from another wallet's action", async () => {
    const { exporter: target, dir } = exporter();
    target.notFetched.push({ wallet: target.config.wallets[0], source: "midgard", error: "x" });

    assert.deepEqual(target.getRows([send], path.join(dir, "run")), []);
    assert.ok(target.report.counts.includes("Skipped 1 rows of wallets not fetched"));
  });

  test("a run that fetched every wallet writes no list", async () => {
    const { exporter: target, dir } = exporter();
    target.sources = () => [{ name: "midgard", bundlesFor: async (wallet) => (wallet === MAIN ? [send] : []) }];

    assert.deepEqual(await target.collectBundles(), [send]);
    target.writeNotFetched(path.join(dir, "run"));

    assert.equal(fs.existsSync(path.join(dir, "run", NOT_FETCHED_FILE)), false);
    assert.doesNotMatch(renderSummary(target.report), /Not fetched/);
  });

  test("a run that skipped a wallet cannot be replayed", () => {
    const { dir } = exporter();
    const run = path.join(dir, "run");
    fs.outputJsonSync(path.join(run, NOT_FETCHED_FILE), { version: 1, wallets: [] });
    assert.throws(
      () => new Exporter(path.join(dir, "config.toml"), { replay: run, today: new Date("2026-11-01") }),
      /that run skipped a wallet \(not-fetched\.json\), so it cannot be replayed/,
    );
    // Named by its manifest file too
    fs.outputJsonSync(path.join(run, "snapshots.json"), {});
    assert.throws(
      () =>
        new Exporter(path.join(dir, "config.toml"), {
          replay: path.join(run, "snapshots.json"),
          today: new Date("2026-11-01"),
        }),
      /cannot be replayed/,
    );
  });
});
