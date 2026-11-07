import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import {
  chooseCopy,
  type Copy,
  type RecordRules,
  RecordStore,
  sha256,
  StoreMissError,
} from "../src/sources/store/RecordStore.ts";
import { SnapshotManifest } from "../src/sources/store/SnapshotManifest.ts";
import { THORNODE_RULES } from "../src/sources/store/Sources.ts";

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-store-"));
const fetching = <T>(data: T) => mock.fn(async () => ({ data, url: "https://source/x" }));

interface Tx {
  id: string;
  status?: string;
  gas?: string;
}

const RULES: RecordRules<Tx> = {
  isPending: (tx) => tx.status === "pending",
  completeness: (tx) => (tx.gas ? 1 : 0),
};
const LIST = { keyOf: (tx: Tx) => tx.id, rules: RULES };

describe("RecordStore records", () => {
  test("fetches a record once and stores it with its URL and hash", async () => {
    const root = makeDir();
    const fetch = fetching({ id: "a", gas: "1" });

    assert.deepEqual(await new RecordStore(root).record("thornode", "a", fetch), { id: "a", gas: "1" });
    assert.deepEqual(await new RecordStore(root).record("thornode", "a", fetch), { id: "a", gas: "1" });
    assert.equal(fetch.mock.callCount(), 1);

    const [copy] = new RecordStore(root).copies("thornode", "a");
    assert.equal(typeof copy.fetchedAt, "string");
    assert.partialDeepStrictEqual(copy, { url: "https://source/x", sha256: sha256({ id: "a", gas: "1" }) });
  });

  test("offline, a record not stored is an error", async () => {
    await assert.rejects(
      new RecordStore(makeDir(), { offline: true }).record("thornode", "a", fetching({ id: "a" })),
      StoreMissError,
    );
  });

  test("refetching stores a changed copy next to the old one; an unchanged one adds nothing", async () => {
    const root = makeDir();
    await new RecordStore(root).record("thornode", "a", fetching({ id: "a", gas: "1" }));
    await new RecordStore(root, { fetch: "all" }).record("thornode", "a", fetching({ id: "a", gas: "1" }));
    assert.equal(new RecordStore(root).copies("thornode", "a").length, 1);

    const used = await new RecordStore(root, { fetch: "all" }).record(
      "thornode",
      "a",
      fetching<Tx>({ id: "a", gas: "2" }),
      RULES,
    );
    assert.deepEqual(used, { id: "a", gas: "2" });
    assert.equal(new RecordStore(root).copies("thornode", "a").length, 2);
  });

  test("a pruned copy is stored, but the earlier good copy is used", async () => {
    const root = makeDir();
    mock.method(console, "log", () => {});
    await new RecordStore(root).record("thornode", "a", fetching<Tx>({ id: "a", gas: "1" }), RULES);

    const used = await new RecordStore(root, { fetch: "all" }).record(
      "thornode",
      "a",
      fetching<Tx>({ id: "a" }),
      RULES,
    );

    assert.deepEqual(used, { id: "a", gas: "1" });
    assert.equal(new RecordStore(root).copies("thornode", "a").length, 2);
  });

  test("a finalised copy is used over the pending one, which is kept", async () => {
    const root = makeDir();
    await new RecordStore(root).record("thornode", "a", fetching<Tx>({ id: "a", status: "pending" }), RULES);

    const used = await new RecordStore(root, {}).record(
      "thornode",
      "a",
      fetching<Tx>({ id: "a", status: "done" }),
      RULES,
    );

    assert.deepEqual(used, { id: "a", status: "done" });
    assert.deepEqual(
      new RecordStore(root).copies<Tx>("thornode", "a").map((c) => c.data.status),
      ["pending", "done"],
    );
  });
});

describe("fetch modes", () => {
  test("by default a pending record is fetched again and a finalised one is not; --refetch-all fetches both", async () => {
    const root = makeDir();
    await new RecordStore(root).record(
      "thornode",
      "pending",
      fetching<Tx>({ id: "pending", status: "pending" }),
      RULES,
    );
    await new RecordStore(root).record("thornode", "final", fetching<Tx>({ id: "final", gas: "1" }), RULES);

    const pending = fetching<Tx>({ id: "pending", status: "done" });
    const final = fetching<Tx>({ id: "final", gas: "2" });
    assert.deepEqual(await new RecordStore(root).record("thornode", "pending", pending, RULES), {
      id: "pending",
      status: "done",
    });
    assert.deepEqual(await new RecordStore(root).record("thornode", "final", final, RULES), { id: "final", gas: "1" });
    assert.equal(final.mock.callCount(), 0);

    assert.deepEqual(await new RecordStore(root, { fetch: "all" }).record("thornode", "final", final, RULES), {
      id: "final",
      gas: "2",
    });
  });

  test("wallet lists are fetched again on every run, except offline", async () => {
    const root = makeDir();
    await new RecordStore(root).list("midgard", "w", fetching([{ id: "a" }]), LIST);
    const again = fetching([{ id: "a" }, { id: "b" }]);

    assert.deepEqual(await new RecordStore(root, { offline: true }).list("midgard", "w", again, LIST), [{ id: "a" }]);
    assert.equal(again.mock.callCount(), 0);
    assert.deepEqual(await new RecordStore(root).list("midgard", "w", again, LIST), [{ id: "a" }, { id: "b" }]);
  });

  test("a record still pending past the cut-off is stuck: fetched again only by --refetch-all", async () => {
    const root = makeDir();
    const today = new Date(Date.UTC(2026, 6, 31));
    const options = { pendingStuckDays: 30, today };
    const old = new Date(Date.UTC(2026, 5, 30));
    const recent = new Date(Date.UTC(2026, 6, 2));
    await new RecordStore(root, options).record(
      "thornode",
      "old",
      fetching<Tx>({ id: "old", status: "pending" }),
      RULES,
      old,
    );
    await new RecordStore(root, options).record(
      "thornode",
      "recent",
      fetching<Tx>({ id: "recent", status: "pending" }),
      RULES,
      recent,
    );

    const fetchOld = fetching<Tx>({ id: "old", status: "done" });
    const fetchRecent = fetching<Tx>({ id: "recent", status: "done" });
    assert.deepEqual(await new RecordStore(root, options).record("thornode", "old", fetchOld, RULES, old), {
      id: "old",
      status: "pending",
    });
    assert.deepEqual(await new RecordStore(root, options).record("thornode", "recent", fetchRecent, RULES, recent), {
      id: "recent",
      status: "done",
    });
    assert.equal(fetchOld.mock.callCount(), 0);

    assert.deepEqual(
      await new RecordStore(root, { ...options, fetch: "all" }).record("thornode", "old", fetchOld, RULES, old),
      { id: "old", status: "done" },
    );
  });

  test("with no date or no cut-off, a pending record is always fetched again", async () => {
    const root = makeDir();
    const old = new Date(Date.UTC(2020, 0, 1));
    await new RecordStore(root).record("thornode", "a", fetching<Tx>({ id: "a", status: "pending" }), RULES, old);
    await new RecordStore(root).record("thornode", "b", fetching<Tx>({ id: "b", status: "pending" }), RULES);

    const fetchA = fetching<Tx>({ id: "a", status: "pending" });
    const fetchB = fetching<Tx>({ id: "b", status: "pending" });
    await new RecordStore(root).record("thornode", "a", fetchA, RULES, old);
    await new RecordStore(root, { pendingStuckDays: 30 }).record("thornode", "b", fetchB, RULES);

    assert.equal(fetchA.mock.callCount(), 1);
    assert.equal(fetchB.mock.callCount(), 1);
  });

  test("a record stored under a key it no longer gets is not missing once the latest list has its new key", async () => {
    const root = makeDir();
    const fetch = (items: Tx[], keyOf: (tx: Tx) => string) =>
      new RecordStore(root).list("midgard", "w", fetching(items), { keyOf, rules: RULES });
    await fetch([{ id: "a" }, { id: "b" }], (tx) => tx.id);

    const used = await fetch([{ id: "a" }, { id: "b" }], (tx) => (tx.id === "b" ? "b.member" : tx.id));
    assert.deepEqual(used, [{ id: "a" }, { id: "b" }]);
  });

  test("a fetched record of other members under a stored key is an error, not a new copy", async () => {
    const root = makeDir();
    const rules: RecordRules<{ id: string; in: string[]; n?: number }> = { membersOf: (tx) => tx.in };
    const list = (items: any[]) =>
      new RecordStore(root).list("midgard", "w", fetching(items), { keyOf: (tx) => tx.id, rules });
    await list([{ id: "k", in: ["maya1a", "thor1a"] }]);

    await assert.rejects(
      list([{ id: "k", in: ["maya1b", "thor1b"] }]),
      /belongs to other addresses than the stored copy/,
    );
    assert.equal(new RecordStore(root).copies("midgard", "k").length, 1);
    // A revision of the same member's record is a new copy, whatever the case of its addresses
    await list([{ id: "k", in: ["MAYA1A", "thor1a"], n: 2 }]);
    assert.equal(new RecordStore(root).copies("midgard", "k").length, 2);
  });

  test("offline, a pending record is not fetched again", async () => {
    const root = makeDir();
    await new RecordStore(root).record("thornode", "p", fetching<Tx>({ id: "p", status: "pending" }), RULES);
    const fetch = fetching<Tx>({ id: "p", status: "done" });

    assert.deepEqual(await new RecordStore(root, { offline: true }).record("thornode", "p", fetch, RULES), {
      id: "p",
      status: "pending",
    });
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe("chooseCopy", () => {
  const copy = (data: Tx, n: number): Copy<Tx> => ({ file: `${n}`, n, fetchedAt: `${n}`, sha256: sha256(data), data });

  test("says why a copy is used", () => {
    assert.equal(chooseCopy([copy({ id: "a" }, 1)], RULES).choice, "only");
    assert.equal(
      chooseCopy([copy({ id: "a", status: "pending" }, 1), copy({ id: "a" }, 2)], RULES).choice,
      "finalised",
    );
    assert.equal(chooseCopy([copy({ id: "a", gas: "1" }, 1), copy({ id: "a", gas: "2" }, 2)], RULES).choice, "revised");

    const pruned = chooseCopy([copy({ id: "a", gas: "1" }, 1), copy({ id: "a" }, 2)], RULES);
    assert.equal(pruned.choice, "kept-over-pruned");
    assert.deepEqual(pruned.copy.data, { id: "a", gas: "1" });
  });
});

describe("RecordStore lists", () => {
  test("stores each item as its own record, shared between wallets", async () => {
    const root = makeDir();
    const store = new RecordStore(root);

    await store.list("midgard", "w1", fetching([{ id: "a" }, { id: "b" }]), LIST);
    await store.list("midgard", "w2", fetching([{ id: "b" }]), LIST);

    assert.deepEqual(fs.readdirSync(path.join(root, "records", "midgard", "undated")).sort(), ["a.0.json", "b.0.json"]);
    assert.equal(store.copies("midgard", "b").length, 1);
  });

  test("fetching the latest: new items are added, finalised ones replace pending ones, and missing ones are kept", async () => {
    const root = makeDir();
    await new RecordStore(root).list(
      "midgard",
      "w",
      fetching([{ id: "old" }, { id: "gone" }, { id: "p", status: "pending" }]),
      LIST,
    );

    const manifest = new SnapshotManifest();
    const items = await new RecordStore(root, { manifest }).list(
      "midgard",
      "w",
      fetching([{ id: "new" }, { id: "old" }, { id: "p", status: "success" }]),
      LIST,
    );

    assert.deepEqual(items, [{ id: "new" }, { id: "old" }, { id: "p", status: "success" }, { id: "gone" }]);
    assert.equal(manifest.findRecord("midgard", "gone")?.missing, true);
    assert.equal(manifest.findRecord("midgard", "p")?.choice, "finalised");
    assert.equal(manifest.findRecord("midgard", "new")?.fetched, "new");
    assert.equal(manifest.findRecord("midgard", "old")?.fetched, "unchanged");
    assert.deepEqual(manifest.findList("midgard", "w")?.missing, ["gone"]);
  });

  test("normalises before comparing, so a field that changes on every fetch adds no copy", async () => {
    const root = makeDir();
    const options = {
      keyOf: (tx: Tx & { now?: string }) => tx.id,
      rules: { normalise: ({ now, ...tx }: Tx & { now?: string }) => tx },
    };
    await new RecordStore(root).list("viewblock", "w", fetching([{ id: "a", now: "1" }]), options);
    await new RecordStore(root, {}).list("viewblock", "w", fetching([{ id: "a", now: "2" }]), options);

    assert.deepEqual(
      new RecordStore(root).copies("viewblock", "a").map((c) => c.data),
      [{ id: "a" }],
    );
  });

  test("an empty list is stored, so offline runs can replay it", async () => {
    const root = makeDir();
    await new RecordStore(root).list("viewblock", "w", fetching([] as Tx[]), LIST);

    assert.deepEqual(
      await new RecordStore(root, { offline: true }).list("viewblock", "w", fetching([{ id: "x" }]), LIST),
      [],
    );
  });
});

describe("Layout", () => {
  const DATED = {
    keyOf: (tx: Tx & { month?: string }) => tx.id,
    rules: { folderOf: (tx: Tx & { month?: string }) => tx.month ?? "" },
  };

  test("a record is <key>.<n>.json in the folder its rules give; a later copy stays next to the first", async () => {
    const root = makeDir();
    await new RecordStore(root).list("midgard", "w", fetching([{ id: "swap.ABC", month: "2025/07" }]), DATED);
    // A revision whose date moved to another month
    await new RecordStore(root).list("midgard", "w", fetching([{ id: "swap.ABC", month: "2025/08" }]), DATED);

    assert.deepEqual(fs.readdirSync(path.join(root, "records", "midgard", "2025", "07")).sort(), [
      "swap.ABC.0.json",
      "swap.ABC.1.json",
    ]);
    assert.deepEqual(fs.readdirSync(path.join(root, "lists", "midgard")), ["w.0.json"]);
    assert.partialDeepStrictEqual(
      fs.readJSONSync(path.join(root, "records", "midgard", "2025", "07", "swap.ABC.0.json")),
      { source: "midgard", key: "swap.ABC" },
    );
  });

  test("a record with no date of its own is filed by the date it is given, and stays there", async () => {
    const root = makeDir();
    await new RecordStore(root).record(
      "thornode",
      "A",
      fetching<Tx>({ id: "A", status: "pending" }),
      RULES,
      new Date(Date.UTC(2025, 6, 4)),
    );
    await new RecordStore(root).record(
      "thornode",
      "A",
      fetching<Tx>({ id: "A", status: "done" }),
      RULES,
      new Date(Date.UTC(2026, 0, 1)),
    );

    assert.deepEqual(fs.readdirSync(path.join(root, "records", "thornode", "2025", "07")).sort(), [
      "A.0.json",
      "A.1.json",
    ]);
  });

  test("names decode back to keys, and are safe as file names", async () => {
    const { encodeName, decodeName } = await import("../src/sources/store/RecordStore.ts");
    const key = "contract.CFB6.wasm-rujira-fin/trade";

    assert.equal(encodeName(key), "contract.CFB6.wasm-rujira-fin%2Ftrade");
    assert.equal(decodeName(encodeName(key)), key);
    assert.equal(encodeName("a%b:c"), "a%25b%3Ac");

    const root = makeDir();
    await new RecordStore(root).record("midgard", key, fetching({ id: key }));
    assert.deepEqual(await new RecordStore(root, { offline: true }).record("midgard", key, fetching({ id: "x" })), {
      id: key,
    });
  });

  test("copies sort by fetch time: an old copy imported after a newer fetch still counts as older", async () => {
    const root = makeDir();
    const store = new RecordStore(root);
    await store.record("thornode", "A", fetching<Tx>({ id: "A", gas: "2" }), RULES);
    store.importCopy("thornode", "A", { id: "A", gas: "1" }, RULES, { fetchedAt: null, importedFrom: "old/A.json" });

    const copies = new RecordStore(root).copies<Tx>("thornode", "A");
    assert.deepEqual(
      copies.map((c) => [c.n, c.data.gas]),
      [
        [1, "1"],
        [0, "2"],
      ],
    );
    assert.deepEqual(
      await new RecordStore(root, { offline: true }).record("thornode", "A", fetching<Tx>({ id: "A" }), RULES),
      { id: "A", gas: "2" },
    );
  });

  test("a new copy never overwrites a file, even one written by another run", async () => {
    const root = makeDir();
    const first = new RecordStore(root);
    const second = new RecordStore(root);
    // second scans the store before first writes
    second.copies("thornode", "B");
    await first.record("thornode", "A", fetching<Tx>({ id: "A", gas: "1" }));
    await second.record("thornode", "A", fetching<Tx>({ id: "A", gas: "2" }));

    assert.deepEqual(fs.readdirSync(path.join(root, "records", "thornode", "undated")).sort(), [
      "A.0.json",
      "A.1.json",
    ]);
  });

  test("keys that differ only in case are refused", async () => {
    const root = makeDir();
    fs.outputJsonSync(path.join(root, "records", "viewblock", "abc.0.json"), {});
    fs.outputJsonSync(path.join(root, "records", "viewblock", "ABC.0.json"), {});

    if (fs.readdirSync(path.join(root, "records", "viewblock")).length === 2) {
      assert.throws(() => new RecordStore(root).copies("viewblock", "abc"), /differ only in case/);
    }
  });
});

describe("Replay", () => {
  test("reads exactly the copies a run used, even after later changes", async () => {
    const root = makeDir();
    const run1 = new SnapshotManifest();
    await new RecordStore(root, { manifest: run1 }).list("midgard", "w", fetching([{ id: "a", gas: "1" }]), LIST);
    run1.write(path.join(root, "run1"));

    await new RecordStore(root, {}).list("midgard", "w", fetching([{ id: "a", gas: "2" }, { id: "b" }]), LIST);

    const replay = new RecordStore(root, { replay: SnapshotManifest.load(path.join(root, "run1")) });
    const fetch = fetching([] as Tx[]);
    assert.deepEqual(await replay.list("midgard", "w", fetch, LIST), [{ id: "a", gas: "1" }]);

    // A replay's own manifest can be replayed too
    const run2 = new SnapshotManifest();
    await new RecordStore(root, { replay: SnapshotManifest.load(path.join(root, "run1")), manifest: run2 }).list(
      "midgard",
      "w",
      fetch,
      LIST,
    );
    assert.deepEqual(run2.findList("midgard", "w")?.keys, ["a"]);
    assert.equal(fetch.mock.callCount(), 0);
    await assert.rejects(replay.record("thornode", "other", fetching({ id: "other" })), StoreMissError);
  });

  test("fails if a stored copy no longer matches the manifest", async () => {
    const root = makeDir();
    const run = new SnapshotManifest();
    await new RecordStore(root, { manifest: run }).record("thornode", "a", fetching({ id: "a" }));
    run.write(path.join(root, "run"));

    const [copy] = new RecordStore(root).copies("thornode", "a");
    fs.writeJSONSync(copy.file, { ...fs.readJSONSync(copy.file), sha256: sha256({ id: "b" }) });

    await assert.rejects(
      new RecordStore(root, { replay: SnapshotManifest.load(path.join(root, "run")) }).record(
        "thornode",
        "a",
        fetching({ id: "a" }),
      ),
      /does not match the manifest/,
    );
  });
});

describe("THORNODE_RULES", () => {
  test("drops the growing block count of an outbound never signed", () => {
    const tx = {
      stages: { outbound_signed: { scheduled_outbound_height: 1, blocks_since_scheduled: 99, completed: false } },
    };

    assert.deepEqual(THORNODE_RULES.normalise!(tx as any), {
      stages: { outbound_signed: { scheduled_outbound_height: 1, completed: false } },
    });
  });
});

describe("RecordStore within one run", () => {
  test("a record shared by several wallets is fetched once, and keeps its changed status", async () => {
    const root = makeDir();
    await new RecordStore(root).record("thornode", "a", fetching({ id: "a", gas: "1" }));

    const manifest = new SnapshotManifest();
    const store = new RecordStore(root, { fetch: "all", manifest });
    const fetch = fetching<Tx>({ id: "a", gas: "2" });
    await store.record("thornode", "a", fetch, RULES);
    await store.record("thornode", "a", fetch, RULES);

    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(manifest.findRecord("thornode", "a")?.fetched, "changed");
  });

  test("a list item stored again by a second wallet keeps the first wallet's changed status", async () => {
    const root = makeDir();
    await new RecordStore(root).list("midgard", "w1", fetching([{ id: "a" }]), LIST);

    const manifest = new SnapshotManifest();
    const store = new RecordStore(root, { manifest });
    await store.list("midgard", "w1", fetching([{ id: "a", gas: "1" }]), LIST);
    await store.list("midgard", "w2", fetching([{ id: "a", gas: "1" }]), LIST);

    assert.equal(manifest.findRecord("midgard", "a")?.fetched, "changed");
  });

  test("copies that differ only in what normalise drops are not a revision", () => {
    const rules = { normalise: ({ gas, ...tx }: Tx) => tx };
    const copies = [
      { id: "a", gas: "1" },
      { id: "a", gas: "2" },
    ].map((data, n) => ({ file: `${n}`, n, fetchedAt: `${n}`, sha256: sha256(data), data }));

    assert.equal(chooseCopy(copies, rules).choice, "only");
  });
});

describe("replaying a run made before a source existed", () => {
  test("a source the run read nothing from gives nothing; a missing list of a source it read is an error", async () => {
    const replay = new SnapshotManifest(
      [],
      [{ source: "midgard", wallet: "w1", keys: [], missing: [], file: "" } as any],
    );
    const store = new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-replay-")), { replay });
    const never = async () => {
      throw new Error("no fetch on replay");
    };

    assert.deepEqual(await store.list("maya-distribution", "w1", never, { keyOf: (item: any) => item.id }), []);
    await assert.rejects(store.list("midgard", "w2", never, { keyOf: (item: any) => item.id }), /in the replayed run/);
  });
});

// Bundles are built a few at a time (docs/specs/snapshots.md), so two can ask for the same record at once: e.g. a
// swap and its refund for the inbound's THORNode status, or two actions in one price bucket
describe("Concurrent use", () => {
  test("a record asked for twice at once is fetched once, and both get it", async () => {
    const root = makeDir();
    const store = new RecordStore(root);
    const fetch = mock.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { data: { id: "a", gas: "1" } as Tx, url: "https://source/x" };
    });

    const [first, second] = await Promise.all([
      store.record("thornode", "a", fetch, RULES),
      store.record("thornode", "a", fetch, RULES),
    ]);

    assert.deepEqual(first, { id: "a", gas: "1" });
    assert.deepEqual(second, { id: "a", gas: "1" });
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(new RecordStore(root).copies("thornode", "a").length, 1);
  });

  test("the second caller gets the first's error", async () => {
    const store = new RecordStore(makeDir());
    const fetch = mock.fn(async (): Promise<any> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw { response: { status: 404 } };
    });

    const results = await Promise.allSettled([
      store.record("thornode", "a", fetch),
      store.record("thornode", "a", fetch),
    ]);

    assert.deepEqual(
      results.map((result) => result.status === "rejected" && result.reason),
      [{ response: { status: 404 } }, { response: { status: 404 } }],
    );
    assert.equal(fetch.mock.callCount(), 1);
  });

  test("a list asked for twice at once is fetched once", async () => {
    const store = new RecordStore(makeDir());
    const fetch = mock.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { data: [{ id: "a" }, { id: "b" }] as Tx[], url: "https://source/list" };
    });

    const [first, second] = await Promise.all([
      store.list("midgard", "w1", fetch, LIST),
      store.list("midgard", "w1", fetch, LIST),
    ]);

    assert.deepEqual(first, [{ id: "a" }, { id: "b" }]);
    assert.deepEqual(second, first);
    assert.equal(fetch.mock.callCount(), 1);
  });
});
