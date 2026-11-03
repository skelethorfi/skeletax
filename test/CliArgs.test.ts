import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AxiosError } from "axios";
import { knownErrorMessage, parseExportArgs, printError, USAGE, UsageError } from "../src/cli/args.ts";
import { StoreMissError } from "../src/sources/store/RecordStore.ts";
import { FetchError } from "../src/sources/Retry.ts";
import { InputError } from "../src/utils/InputError.ts";
import { TaxConfig } from "../src/config/TaxConfig.ts";
import { SnapshotManifest } from "../src/sources/store/SnapshotManifest.ts";

describe("parseExportArgs", () => {
  test("reads the config file and the flags", () => {
    assert.deepEqual(parseExportArgs(["wallets.toml"]), {
      help: false,
      configFile: "wallets.toml",
      offline: false,
      fetch: undefined,
      replay: undefined,
    });
    assert.deepEqual(parseExportArgs(["--offline", "a/wallets.json"]), {
      help: false,
      configFile: "a/wallets.json",
      offline: true,
      fetch: undefined,
      replay: undefined,
    });
    assert.equal(parseExportArgs(["wallets.toml", "--refetch-all"]).fetch, "all");
    assert.equal(
      parseExportArgs(["--replay", "out/2026-10-03_15-33-50", "wallets.toml"]).replay,
      "out/2026-10-03_15-33-50",
    );
    assert.equal(parseExportArgs(["--replay=out/run", "wallets.toml"]).replay, "out/run");
  });

  test("--help and -h ask for the usage, with or without a config file", () => {
    assert.equal(parseExportArgs(["--help"]).help, true);
    assert.equal(parseExportArgs(["-h", "wallets.toml"]).help, true);
  });

  test("an unknown flag is an error, not ignored", () => {
    assert.throws(() => parseExportArgs(["--ofline", "wallets.toml"]), {
      name: "UsageError",
      message: "Unknown option '--ofline'",
    });
    assert.throws(() => parseExportArgs(["-x", "wallets.toml"]), { message: "Unknown option '-x'" });
    assert.throws(() => parseExportArgs(["--offline=yes", "wallets.toml"]), UsageError);
  });

  test("--replay needs a run folder", () => {
    for (const args of [
      ["wallets.toml", "--replay"],
      ["--replay", "--offline", "wallets.toml"],
      ["--replay=", "w.toml"],
    ]) {
      assert.throws(() => parseExportArgs(args), { name: "UsageError", message: "--replay needs a run folder" });
    }
  });

  test("an unknown option that starts with --replay is unknown, not a missing run folder", () => {
    assert.throws(() => parseExportArgs(["--replays", "run", "w.toml"]), { message: "Unknown option '--replays'" });
    assert.throws(() => parseExportArgs(["--replayx", "w.toml"]), { message: "Unknown option '--replayx'" });
  });

  test("exactly one .toml or .json config file", () => {
    assert.throws(() => parseExportArgs([]), { message: "must specify config file" });
    assert.throws(() => parseExportArgs(["--offline"]), { message: "must specify config file" });
    assert.throws(() => parseExportArgs(["a.toml", "b.toml"]), { message: /expected one config file, got 2/ });
    assert.throws(() => parseExportArgs(["wallets.yaml"]), { message: /must be \.toml or \.json/ });
  });

  test("--offline and --refetch-all contradict each other", () => {
    assert.throws(() => parseExportArgs(["--offline", "--refetch-all", "wallets.toml"]), UsageError);
  });
});

describe("knownErrorMessage", () => {
  test("errors the user can act on have a message", () => {
    assert.equal(knownErrorMessage(new UsageError("bad")), "bad");
    assert.equal(
      knownErrorMessage(new StoreMissError("midgard list thor1")),
      "Offline: nothing stored for midgard list thor1",
    );
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'w.toml'"), {
      code: "ENOENT",
      syscall: "open",
    });
    assert.equal(knownErrorMessage(enoent), enoent.message);
  });

  test("a network error names the status or code and the URL", () => {
    const http = new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", {
      url: "https://x/v2/a",
    } as any);
    (http as any).response = { status: 404 };
    assert.equal(knownErrorMessage(http), "Network error: HTTP 404 (https://x/v2/a)");
    const dns = new AxiosError("getaddrinfo ENOTFOUND x", "ENOTFOUND", { url: "https://x/v2/a" } as any);
    assert.equal(knownErrorMessage(dns), "Network error: ENOTFOUND (https://x/v2/a)");
    const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
    assert.equal(knownErrorMessage(fetchFailed), "Network error: fetch failed (ECONNRESET)");
    const page = new FetchError("[Midgard] actions of thor1w, page 0: ENOTFOUND");
    assert.equal(knownErrorMessage(page), "Network error: [Midgard] actions of thor1w, page 0: ENOTFOUND");
  });

  test("anything else is a bug", () => {
    assert.equal(knownErrorMessage(new Error("Cannot read properties of undefined")), undefined);
    assert.equal(knownErrorMessage(new TypeError("x is not a function")), undefined);
  });
});

describe("errors from the user's input", () => {
  const today = new Date("2026-10-30T00:00:00Z");
  const inTemp = (name: string, content: string, check: (file: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletax-input-"));

    try {
      fs.writeFileSync(path.join(dir, name), content);
      check(path.join(dir, name));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a config that does not parse is an InputError naming the file", () => {
    inTemp("w.json", "{ wallets: }", (file) => {
      assert.throws(
        () => TaxConfig.load(file, today),
        (error: any) => {
          assert.ok(error instanceof InputError);
          assert.ok(error.message.startsWith(`Config ${file}: `));
          assert.equal(knownErrorMessage(error), error.message);
          return true;
        },
      );
    });
    inTemp("w.toml", "wallets = [", (file) => {
      assert.throws(
        () => TaxConfig.load(file, today),
        (error: any) => error instanceof InputError,
      );
    });
  });

  test("a config value that is not valid is an InputError", () => {
    assert.throws(
      () => TaxConfig.applyDefaults({ referencePrices: "some" as any }, today),
      (error: any) => error instanceof InputError && /^Config: referencePrices/.test(error.message),
    );
    assert.throws(
      () => TaxConfig.applyDefaults({ timezone: "Nowhere/City" }, today),
      (error: any) => error instanceof InputError && /^Config: Unknown timezone/.test(error.message),
    );
  });

  test("a replayed run with no readable manifest is an InputError", () => {
    assert.throws(() => SnapshotManifest.load(path.join(os.tmpdir(), "no-such-run-folder")), InputError);
    inTemp("snapshots.json", "{", (file) => {
      assert.throws(() => SnapshotManifest.load(file), InputError);
    });
  });
});

describe("printError", () => {
  const print = (error: unknown) => {
    const lines: string[] = [];
    const code = printError(error, (text) => lines.push(text));
    return { code, text: lines.join("\n") };
  };

  test("a usage mistake is printed with the usage", () => {
    const { code, text } = print(new UsageError("Unknown option '--ofline'"));
    assert.equal(code, 1);
    assert.equal(text, `Error: Unknown option '--ofline'\n\n${USAGE}`);
  });

  test("a known error is one line, without the stack", () => {
    const { code, text } = print(new InputError("Config w.toml: Syntax error\nunexpected character"));
    assert.equal(code, 1);
    assert.equal(text, "Error: Config w.toml: Syntax error unexpected character");
  });

  test("a bug keeps its stack", () => {
    const { code, text } = print(new Error("boom"));
    assert.equal(code, 1);
    assert.match(text, /^Error: boom\n\s+at /);
  });

  // Nothing wraps the errors thrown while the config and store are set up, so a bug there keeps its stack too
  test("a TypeError is a bug, with its stack", () => {
    const { text } = print(new TypeError("Cannot read properties of undefined (reading 'map')"));
    assert.match(text, /^TypeError: Cannot read properties of undefined \(reading 'map'\)\n\s+at /);
  });
});

describe("full-export command", () => {
  const script = path.resolve(import.meta.dirname, "../src/full-export.ts");
  const run = (args: string[], cwd = os.tmpdir()) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

  test("--help prints the usage and exits 0", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), USAGE);
  });

  test("a typo in a flag exits 1 with the usage, before reading anything", () => {
    const result = run(["--ofline", "missing.toml"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: Unknown option '--ofline'\n\nUsage: /);
  });

  test("a bad config exits 1 with one line, no stack", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletax-cli-"));

    try {
      fs.writeFileSync(path.join(dir, "w.toml"), 'referencePrices = "some"\n');
      const result = run(["--offline", "w.toml"], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^Error: Config: referencePrices must be .* \(got "some"\)\n$/);

      // Checked when the config is read, before anything is fetched or exported
      fs.writeFileSync(path.join(dir, "dates.toml"), 'fromDate = "2025-02-30x"\nwallets = []\n');
      const dates = run(["--offline", "dates.toml"], dir);
      assert.equal(dates.status, 1);
      assert.equal(dates.stderr, 'Error: Config: fromDate must be a date written YYYY-MM-DD (got "2025-02-30x")\n');

      fs.writeFileSync(path.join(dir, "nowallets.toml"), 'fromDate = "2025-01-01"\n');
      const noWallets = run(["--offline", "nowallets.toml"], dir);
      assert.equal(noWallets.status, 1);
      assert.equal(noWallets.stderr, "Error: Config: wallets must be a list of wallets (got undefined)\n");

      const missing = run(["--offline", "nope.toml"], dir);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /^Error: ENOENT: no such file or directory, open 'nope.toml'\n$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
