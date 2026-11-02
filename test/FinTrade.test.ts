import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { readCaseInput, toBundle } from "../src/fixtures/GoldenCase.ts";
import { runBundle } from "../src/pipeline/run.ts";
import { THORCHAIN } from "../src/domain/Protocol.ts";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { MIDGARD_LIST, midgardActionBaseKey, midgardActionKey } from "../src/sources/store/Sources.ts";

// A FIN trade event: one per price level a call filled at (issue #116, tx 59CAB4D2…8014: a RUJI liquid bond whose
// RUJI was sold at two levels)
const trade = (attributes: Record<string, string>, msg: any = { liquid: { bond: {} } }) =>
  ({
    type: "contract",
    date: "1792811291660899704",
    height: "28372742",
    status: "success",
    pools: [],
    in: [{ address: "thor1-user-wallet-11111", coins: [], txID: "T".repeat(64) }],
    out: [{ address: "thor1-fin-contract", coins: [], txID: "T".repeat(64) }],
    metadata: { contract: { contractType: "wasm-rujira-fin/trade", funds: "15000000000x/ruji", msg, attributes } },
  }) as any;

const first = { bid: "2205589087", offer: "361606314", price: "ccl:0.163949992375724081", side: "base" };
const second = { bid: "78993511", offer: "12943087", price: "ccl:0.163849992371070753", side: "base" };

describe("FIN trades: several in one tx", () => {
  test("each has its own record key, from its side, price and amounts only", () => {
    const keys = [trade(first), trade(second)].map(midgardActionKey);

    assert.notEqual(keys[0], keys[1]);
    assert.match(keys[0], new RegExp(`^contract\\.${"T".repeat(64)}\\.wasm-rujira-fin/trade\\.[0-9a-f]{12}$`));
    assert.equal(midgardActionKey(trade(Object.fromEntries(Object.entries(first).reverse()))), keys[0]);
    assert.equal(midgardActionKey(trade({ ...first, ranges: "151:0.1388-0.2306", rate: "0.16" })), keys[0]);
  });

  test("other contract events keep their key", () => {
    const bond = trade({ shares: "1" });
    bond.metadata.contract.contractType = "wasm-rujira-staking/liquid.bond";

    assert.equal(midgardActionKey(bond), `contract.${"T".repeat(64)}.wasm-rujira-staking/liquid.bond`);
  });

  test("a wallet's list stores both (it stopped the run with 'two records with the key')", async () => {
    const store = new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-fin-trade-")));
    const listed = await store.list(
      "midgard",
      "thor1-user-wallet-11111",
      async () => ({ data: [trade(first), trade(second)], url: "" }),
      MIDGARD_LIST,
    );

    assert.equal(listed.length, 2);
  });

  test("a store whose list has a FIN trade under its old key lists it once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-fin-trade-"));
    const oldKey = (action: any) => midgardActionBaseKey(action);
    await new RecordStore(dir).list("midgard", "w", async () => ({ data: [trade(first)], url: "" }), {
      ...MIDGARD_LIST,
      keyOf: oldKey,
    });

    const listed = await new RecordStore(dir).list(
      "midgard",
      "w",
      async () => ({ data: [trade(first)], url: "" }),
      MIDGARD_LIST,
    );
    assert.equal(listed.length, 1);
  });

  test("a FIN swap's row IDs are named without the fill hash: the same as before fills had their own keys", () => {
    const input = readCaseInput(path.join(import.meta.dirname, "cases/rujira/fin-swap-rune-to-brune"));
    const result = runBundle(toBundle(input), THORCHAIN);

    assert.equal(result.activities[0].id, `midgard/${midgardActionBaseKey(input.data as any)}`);
    assert.equal(result.rows[0].id, "2026-05-06T08:43:29.080Z.out.15716f911d11");
  });

  // The golden FIN swap, as if it had filled at two price levels: two trade events in the Cosmos tx, each a
  // Midgard action with the whole call's funds
  test("a swap that fills at two levels is one trade, mapped from its first fill", () => {
    const input = readCaseInput(path.join(import.meta.dirname, "cases/rujira/fin-swap-rune-to-brune"));
    const cosmosTx = structuredClone(input.cosmosTxs![0]);
    const index = cosmosTx.events.findIndex((event) => event.type === "wasm-rujira-fin/trade");
    const fill2 = structuredClone(cosmosTx.events[index]);
    fill2.attributes = fill2.attributes.map((attribute) =>
      attribute.key === "price" ? { ...attribute, value: attribute.value.replace(/:1$/, ":1.01") } : attribute,
    );
    cosmosTx.events.splice(index + 1, 0, fill2);

    const action = (price: string) => {
      const data = structuredClone(input.data) as any;
      data.metadata.contract.attributes.price = price;
      return toBundle({ ...input, data, cosmosTxs: [cosmosTx] });
    };
    const price1 = (input.data as any).metadata.contract.attributes.price;
    const one = runBundle(action(price1), THORCHAIN);
    const two = runBundle(action(price1.replace(/:1$/, ":1.01")), THORCHAIN);

    assert.equal(one.rows.length, 1);
    assert.equal(one.rows[0].baseAmount, "550");
    assert.deepEqual(two.rows, []);
    assert.deepEqual(
      two.issues.map((issue) => issue.kind),
      ["ignored"],
    );
    assert.match(two.issues[0].message, /fill 2 of a swap/);

    const unknown = runBundle(action(price1.replace(/:1$/, ":2")), THORCHAIN);
    assert.deepEqual(
      unknown.issues.map((issue) => issue.kind),
      ["failed"],
    );
  });

  test("trades from two messages in one tx are an error, not fills of one swap", () => {
    const input = readCaseInput(path.join(import.meta.dirname, "cases/rujira/fin-swap-rune-to-brune"));
    const cosmosTx = structuredClone(input.cosmosTxs![0]);
    const index = cosmosTx.events.findIndex((event) => event.type === "wasm-rujira-fin/trade");
    const second = structuredClone(cosmosTx.events[index]);
    second.attributes = second.attributes.map((attribute) =>
      attribute.key === "msg_index" ? { ...attribute, value: "1" } : attribute,
    );
    cosmosTx.events.splice(index + 1, 0, second);

    const result = runBundle(toBundle({ ...input, cosmosTxs: [cosmosTx] }), THORCHAIN);
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["failed"],
    );
    assert.match(result.issues[0].message, /several messages/);
  });

  // The multi-fill golden swap, changed by `change`: what its first and a later fill give
  const multiFill = (change: (input: any) => void) =>
    ["fin-swap-several-fills", "fin-swap-several-fills-later-fill"].map((name) => {
      const input = structuredClone(readCaseInput(path.join(import.meta.dirname, "cases/rujira", name))) as any;
      change(input);
      return runBundle(toBundle(input), THORCHAIN);
    });

  test("fills are matched by the attributes the fill hash covers: a reported `ranges` that differs still matches", () => {
    const [first, later] = multiFill((input) => (input.data.metadata.contract.attributes.ranges = "reformatted"));

    assert.equal(first.rows.length, 1);
    assert.deepEqual(
      later.issues.map((issue) => issue.kind),
      ["ignored"],
    );
  });

  test("several trade events with no msg_index are an error", () => {
    const results = multiFill((input) =>
      input.cosmosTxs[0].events.forEach(
        (event: any) => (event.attributes = event.attributes.filter((attribute: any) => attribute.key !== "msg_index")),
      ),
    );

    for (const result of results) {
      assert.deepEqual(
        result.issues.map((issue) => issue.kind),
        ["failed"],
      );
    }
  });
});
