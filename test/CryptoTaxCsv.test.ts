import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assignRowIds, csvField, renderCsv, rowId } from "../src/export/summ/csv/index.ts";

const row = (time: string, description = "") =>
  ({ timestamp: new Date(time), type: "fee", baseCurrency: "RUNE", baseAmount: "1", description }) as any;

describe("CSV rendering", () => {
  test("writes plain fields as they are", () => {
    assert.equal(csvField("refund (ABC): 0.5 RUNE kept"), "refund (ABC): 0.5 RUNE kept");
    assert.equal(csvField(""), "");
  });

  test("quotes a field with a comma or a double quote, doubling the quotes", () => {
    assert.equal(csvField("kept by thorchain, 1 BTC sent"), '"kept by thorchain, 1 BTC sent"');
    assert.equal(csvField('a "b"'), '"a ""b"""');
  });

  test("keeps every row on one line", () => {
    assert.equal(csvField("one\ntwo"), "one; two");
  });

  test("a description with commas stays in its column", () => {
    const [, line] = renderCsv([
      { ...row("2020-12-31T13:00:00.000Z", "kept, sent, returned"), id: "T.refund-fee" },
    ]).split("\n");
    assert.equal(line, '2020-12-31T13:00:00.000Z,fee,RUNE,1,,,,,,,,T.refund-fee,"kept, sent, returned",,');
  });

  test("rows newest first, without changing the order of the rows passed in", () => {
    const rows = [row("2021-01-01T00:00:00.000Z", "old"), row("2021-01-02T00:00:00.000Z", "new")];
    const lines = renderCsv(rows).split("\n");
    assert.match(lines[0], /^Timestamp \(UTC\),Type,/);
    assert.ok(lines[1].includes(",new,"));
    assert.deepEqual(
      rows.map((r) => r.description),
      ["old", "new"],
    );
  });
});

describe("row IDs", () => {
  const time = new Date("2021-01-01T00:00:00.000Z");
  const trace = { record: "midgard/swap.ABC", role: "trade-out", asset: "BTC.BTC" };

  test("<action time>.<role>.<12 hex of the identity>, the same on every call", () => {
    assert.match(rowId(time, "thor1a", trace), /^2021-01-01T00:00:00\.000Z\.trade-out\.[0-9a-f]{12}$/);
    assert.equal(rowId(time, "thor1a", trace), rowId(time, "thor1a", { ...trace }));
  });

  test("differs by record, wallet, role and asset", () => {
    const ids = [
      rowId(time, "thor1a", trace),
      rowId(time, "thor1a", { ...trace, record: "midgard/swap.ABD" }),
      rowId(time, "thor1b", trace),
      rowId(time, "thor1a", { ...trace, role: "trade-in" }),
      rowId(time, "thor1a", { ...trace, asset: "ETH.ETH" }),
    ];
    assert.equal(new Set(ids).size, ids.length);
  });

  test("two rows with one ID, or a row without one, is an error", () => {
    const a = { ...row("2021-01-01T00:00:00.000Z"), id: "X", trace };

    assert.equal(assignRowIds([a, { ...a, id: "Y" }]).length, 2);
    assert.throws(() => assignRowIds([a, { ...a }]), /Two rows with the ID X \(midgard\/swap\.ABC, trade-out\)/);
    assert.throws(() => assignRowIds([row("2021-01-01T00:00:00.000Z")]), /Row without an ID/);
  });
});

describe("row IDs and the export treatment", () => {
  test("a different treatment of the same action (here, how trade assets are named) keeps every ID", async () => {
    const path = await import("path");
    const { readCaseInput, runCaseLayers } = await import("../src/fixtures/GoldenCase.ts");
    const { exportSumm } = await import("../src/export/summ/index.ts");
    const [swap] = runCaseLayers(
      readCaseInput(path.join(import.meta.dirname, "cases", "swap", "rune-to-token-aggregator")),
    ).activities;
    const traded = {
      ...swap,
      legs: swap.legs.map((item) =>
        item.direction === "in" && item.role === "principal"
          ? { ...item, asset: { notation: "ETH~ETH", kind: "trade" as const } }
          : item,
      ),
    };

    const plain = exportSumm([traded]);
    const prefixed = exportSumm([traded], { assets: { prefixTradeAssets: true } });

    assert.notDeepEqual(
      plain.map((row) => row.baseCurrency),
      prefixed.map((row) => row.baseCurrency),
    );
    assert.deepEqual(
      plain.map((row) => row.id),
      prefixed.map((row) => row.id),
    );
  });
});
