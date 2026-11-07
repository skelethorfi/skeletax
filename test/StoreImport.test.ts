import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { importCache } from "../src/cli/store.ts";
import { MidgardService } from "../src/sources/thorchain/MidgardService.ts";
import { ThornodeService } from "../src/sources/thorchain/ThornodeService.ts";
import { MayanodeService } from "../src/sources/maya/MayanodeService.ts";
import { http } from "../src/sources/http.ts";
import { SOURCES } from "../src/sources/store/Sources.ts";

const action = (txID: string, extra: any = {}) => ({
  type: "addLiquidity",
  status: "success",
  date: "1",
  height: "1",
  in: [{ txID, address: "w", coins: [] }],
  out: [],
  pools: [],
  metadata: {},
  ...extra,
});

describe("store import", () => {
  test("keeps every version from old caches; runs use the good copy; genesisTx placeholders are left out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-import-"));
    const tax2025 = path.join(dir, "tax2025", "cache");
    const history = path.join(dir, "history", "cache");

    // An older year's cache (older Midgard): a genesis placeholder and a full THORNode tx
    fs.outputJsonSync(path.join(tax2025, "midgard", "w.json"), [action("genesisTx"), action("A")]);
    fs.outputJsonSync(path.join(tax2025, "thornode", "A.json"), { tx: { gas: [{ asset: "BTC.BTC", amount: "1" }] } });
    // A year later: the real old add from the archive, and THORNode has pruned the tx
    fs.outputJsonSync(path.join(history, "midgard", "w.json"), [action("A"), action("OLD")]);
    fs.outputJsonSync(path.join(history, "thornode", "A.json"), {});

    const store = new RecordStore(path.join(dir, "store"));
    const tax2025Counts = importCache(store, tax2025);
    importCache(store, history);

    assert.equal(tax2025Counts.midgard.skipped, 1);
    // THORNode files have no date of their own: they are filed by the Midgard action with that txid
    assert.equal(
      path.relative(
        path.join(dir, "store", "records", "thornode"),
        path.dirname(store.copies("thornode", "A")[0].file),
      ),
      "1970/01",
    );
    assert.deepEqual(
      store.copies("thornode", "A").map((copy) => copy.importedFrom),
      ["tax2025/cache/thornode/A.json", "history/cache/thornode/A.json"],
    );

    const offline = new RecordStore(path.join(dir, "store"), { offline: true });
    mock.method(console, "log", () => {});
    assert.deepEqual(
      (await new MidgardService(offline).getActions("w")).map((a) => a.in[0].txID),
      ["A", "OLD"],
    );
    assert.deepEqual(await new ThornodeService(offline).getTxStatus("A"), {
      tx: { gas: [{ asset: "BTC.BTC", amount: "1" }] },
    });
  });

  test("importing the same cache again adds nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-import-"));
    fs.outputJsonSync(path.join(dir, "cache", "thornode", "A.json"), { tx: {} });
    const store = new RecordStore(path.join(dir, "store"));

    importCache(store, path.join(dir, "cache"));
    const again = importCache(store, path.join(dir, "cache"));

    assert.deepEqual(again.thornode, { copies: 0, existing: 1, lists: 0, skipped: 0 });
  });
});

describe("TCY records", () => {
  test("two wallets paid on the same day keep their own distributions", async () => {
    const { TcyDistributionService } = await import("../src/sources/tcy/TcyDistributionService.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-tcy-"));
    fs.outputJsonSync(path.join(dir, "cache", "tcy", "tcy_distribution_w1.json"), {
      distributions: [{ date: "1", amount: "10", price: "1" }],
    });
    fs.outputJsonSync(path.join(dir, "cache", "tcy", "tcy_distribution_w2.json"), {
      distributions: [{ date: "1", amount: "99", price: "1" }],
    });
    importCache(new RecordStore(path.join(dir, "store")), path.join(dir, "cache"));

    const tcy = new TcyDistributionService(new RecordStore(path.join(dir, "store"), { offline: true }));
    assert.deepEqual((await tcy.getTcyDistribution("w1")).distributions, [{ date: "1", amount: "10", price: "1" }]);
    assert.deepEqual((await tcy.getTcyDistribution("w2")).distributions, [{ date: "1", amount: "99", price: "1" }]);
  });
});

describe("midgardActionKey", () => {
  test("tells genesisTx placeholders apart by pool and depositing addresses", async () => {
    const { midgardActionKey } = await import("../src/sources/store/Sources.ts");
    const genesis = (pool: string, addresses: string[]) =>
      ({
        ...action("genesisTx"),
        pools: [pool],
        in: addresses.map((address) => ({ address, txID: "genesisTx", coins: [] })),
      }) as any;

    const keys = [
      genesis("BNB.BUSD", ["thor1a", "bnb1a"]),
      genesis("BNB.BUSD", ["", "bnb1a"]),
      genesis("BTC.BTC", ["thor1a", "bc1a"]),
    ].map(midgardActionKey);

    assert.equal(new Set(keys).size, 3);
    assert.equal(keys[1], "addLiquidity.genesisTx.BNB.BUSD.-+bnb1a");
  });

  test("tells Maya's donate adds apart by member: one tx gave each member a position", async () => {
    const { midgardActionKey } = await import("../src/sources/store/Sources.ts");
    const donate = (addresses: string[]) =>
      ({
        ...action("T"),
        metadata: { addLiquidity: { memo: "donate:thor.rune" } },
        in: addresses.map((address, i) => ({ address, txID: i === 0 ? "T" : "", coins: [] })),
      }) as any;

    assert.equal(midgardActionKey(donate(["maya1a", "thor1a"])), "addLiquidity.T.maya1a+thor1a");
    assert.equal(midgardActionKey(donate(["maya1b", "thor1b"])), "addLiquidity.T.maya1b+thor1b");
    assert.equal(midgardActionKey(action("T") as any), "addLiquidity.T");
  });
});

describe("store import from the folder-per-record layout", () => {
  test("re-keys records with today's keys, and translates the lists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-v1-"));
    const v1 = path.join(dir, "old-store");
    const swap = {
      ...action("A"),
      type: "swap",
      metadata: { swap: { txType: "swap" } },
      date: String(Date.UTC(2025, 6, 15) * 1e6),
    };
    fs.outputJsonSync(path.join(v1, "records", "midgard", "swap.A.swap", "0000-imported-0000.json"), {
      fetchedAt: null,
      importedFrom: "FY/cache/midgard/w.json",
      sha256: "x",
      data: swap,
    });
    fs.outputJsonSync(path.join(v1, "lists", "midgard", "w", "0000-imported-0000.json"), {
      fetchedAt: null,
      keys: ["swap.A.swap"],
    });

    const store = new RecordStore(path.join(dir, "store"));
    importCache(store, v1);

    assert.deepEqual(fs.readdirSync(path.join(dir, "store", "records", "midgard", "2025", "07")), ["swap.A.0.json"]);
    assert.equal(store.copies("midgard", "swap.A")[0].importedFrom, "FY/cache/midgard/w.json");
    mock.method(console, "log", () => {});
    const offline = new RecordStore(path.join(dir, "store"), { offline: true });
    assert.deepEqual(
      (await new MidgardService(offline).getActions("w")).map((a) => a.type),
      ["swap"],
    );
  });
});

describe("store import of every source", () => {
  test("copies Maya native fees, so an offline run on the copy has them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-import-fee-"));
    const get = mock.method(http, "get", async () => ({ data: { NATIVETRANSACTIONFEE: 2000000000 } }) as any);
    await new MayanodeService(new RecordStore(path.join(dir, "a")), "https://node").nativeFee(1000);
    get.mock.restore();

    const counts = importCache(new RecordStore(path.join(dir, "b")), path.join(dir, "a"));

    assert.equal(counts["mayanode-fee"]?.copies, 1);
    const offline = new RecordStore(path.join(dir, "b"), { offline: true });
    assert.deepEqual(await new MayanodeService(offline, "https://node").nativeFee(1000), {
      height: 1000,
      amount: "2000000000",
      from: "mimir",
    });
  });

  test("every source the services write to is in SOURCES", () => {
    const srcDir = path.join(import.meta.dirname, "..", "src");
    const code = fs
      .readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => fs.readFileSync(path.join(srcDir, file), "utf8"))
      .join("\n");
    // A service's default source, and a source named where a record or list is stored
    const named = [
      ...code.matchAll(/source: string = "([a-z-]+)"/g),
      ...code.matchAll(/\.(?:record|list|addedSinceReplay)(?:<[^>]*>)?\(\s*"([a-z-]+)"/g),
    ].map((match) => match[1]);
    // Sources derived from a Midgard's, e.g. `${this.source}-rune-price`
    const suffixes = [...code.matchAll(/`\$\{this\.source\}(-[a-z-]+)`/g)].map((match) => match[1]);

    assert.ok(named.includes("mayanode-fee") && named.includes("thornode") && suffixes.includes("-rune-price"));
    assert.deepEqual(
      named.filter((source) => !(source in SOURCES)),
      [],
    );
    assert.deepEqual(
      suffixes.filter((suffix) => !Object.keys(SOURCES).some((source) => source.endsWith(suffix))),
      [],
    );
  });
});

describe("oldCacheHint", () => {
  test("suggests importing an old cache next to the config, or in the store folder, while the store is empty", async () => {
    const { oldCacheHint } = await import("../src/cli/store.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-hint-"));
    fs.outputJsonSync(path.join(dir, "cache", "midgard", "w.json"), []);

    assert.match(oldCacheHint(path.join(dir, "store"), dir)!, /npm run store -- import .*store .*cache$/);
    // A config whose cachePath still points at the old cache
    assert.match(oldCacheHint(path.join(dir, "cache"), dir)!, /import .*cache .*cache$/);

    fs.outputJsonSync(path.join(dir, "store", "records", "thornode", "undated", "A.0.json"), {});
    assert.equal(oldCacheHint(path.join(dir, "store"), dir), undefined);
  });
});
