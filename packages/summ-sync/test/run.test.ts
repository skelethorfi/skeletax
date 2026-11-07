import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsvLine, parseWalletFile, readRun, readUnmapped, txidsOf } from "../src/run.ts";
import { inPeriod, before, startOfDay } from "../src/dates.ts";

const HEADER =
  "Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),Blockchain (Optional),ID (Optional),Description (Optional),Reference Price Per Unit (Optional),Reference Price Currency (Optional)";
const TXID = "AB".repeat(32);
const LINE = `2024-03-01T10:00:00.000Z,send,RUNE,1.5,,,RUNE,0.02,wallet-a,wallet-b,THORChain,2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa,"Sent 1.5 RUNE, ""example""; ${TXID}",,`;

test("parseCsvLine reads quoted fields with commas and doubled quotes", () => {
  assert.deepEqual(parseCsvLine('a,"b, c","say ""hi""",,e'), ["a", "b, c", 'say "hi"', "", "e"]);
  assert.deepEqual(parseCsvLine(""), [""]);
  assert.throws(() => parseCsvLine('a,"b'), /Unclosed quote/);
});

test("txidsOf finds 64-hex strings in lower case, once each", () => {
  assert.deepEqual(txidsOf(`out ${TXID}; in 0x${"cd".repeat(32)}; again ${TXID.toLowerCase()}`), [
    TXID.toLowerCase(),
    "cd".repeat(32),
  ]);
  assert.deepEqual(txidsOf("a".repeat(65)), []);
});

test("parseWalletFile reads the chain, the period and each row", () => {
  const { file, rows } = parseWalletFile("2023-07-01_2024-06-30_THOR_abcde_Example.csv", `${HEADER}\n${LINE}`);
  assert.deepEqual(file.period, { from: "2023-07-01", to: "2024-06-30" });
  assert.equal(file.chain, "THOR");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa");
  assert.equal(rows[0].type, "send");
  assert.equal(rows[0].feeAmount, "0.02");
  assert.equal(rows[0].description, `Sent 1.5 RUNE, "example"; ${TXID}`);
  assert.deepEqual(rows[0].txids, [TXID.toLowerCase()]);
  assert.equal(rows[0].line, LINE);
});

test("readRun reads only the period wallet files and refuses an ID in two files", () => {
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(run, "csv"));
  writeFileSync(join(run, "csv", "all.csv"), `${HEADER}\n${LINE}`);
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_THOR_abcde_Example.csv"), `${HEADER}\n${LINE}`);
  const { files, rows } = readRun(run);
  assert.equal(files.length, 1);
  assert.equal(rows.length, 1);
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_THOR_fghij_Other.csv"), `${HEADER}\n${LINE}`);
  assert.throws(() => readRun(run), /is in .* and /);
});

test("readRun refuses a run that could not fetch every wallet", () => {
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(run, "csv"));
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_THOR_abcde_Example.csv"), `${HEADER}\n${LINE}`);
  assert.equal(readRun(run).rows.length, 1);
  writeFileSync(
    join(run, "not-fetched.json"),
    JSON.stringify({
      version: 1,
      wallets: [{ name: "Other", address: "thor1other", source: "midgard", error: "503" }],
    }),
  );
  assert.throws(() => readRun(run), /could not fetch every wallet \(Other\).*delete its rows/);
  writeFileSync(join(run, "not-fetched.json"), "not json");
  assert.throws(() => readRun(run), /could not fetch every wallet and wrote no file/);
});

test("readRun adds extra files of the run's periods only, marking their rows", () => {
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(run, "csv"));
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_THOR_abcde_Example.csv"), `${HEADER}\n${LINE}`);
  const extra = mkdtempSync(join(tmpdir(), "summ-sync-extra-"));
  mkdirSync(join(extra, "current"));
  mkdirSync(join(extra, "earlier"));
  const manual = LINE.replace(
    "2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa",
    "2023-07-01_2024-06-30_THOR_abcde_Example_manual.csv:1",
  );
  writeFileSync(join(extra, "current", "2023-07-01_2024-06-30_THOR_abcde_Example_manual.csv"), `${HEADER}\n${manual}`);
  writeFileSync(
    join(extra, "earlier", "2022-07-01_2023-06-30_THOR_abcde_Example_manual.csv"),
    `${HEADER}\n${manual.replaceAll("2023-07-01_2024-06-30", "2022-07-01_2023-06-30")}`,
  );
  writeFileSync(join(extra, "README.md"), "not a period file");
  const { files, rows } = readRun(run, [extra]);
  assert.deepEqual(
    files.map((f) => f.name),
    ["2023-07-01_2024-06-30_THOR_abcde_Example.csv", "2023-07-01_2024-06-30_THOR_abcde_Example_manual.csv"],
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["2024-03-01T10:00:00.000Z.out.aaaaaaaaaaaa", "2023-07-01_2024-06-30_THOR_abcde_Example_manual.csv:1"],
  );
  assert.deepEqual(
    rows.map((r) => r.extra),
    [undefined, true],
  );
  // an extra file with a run file's name is uploaded with it, under one header: another header is refused
  const same = mkdtempSync(join(tmpdir(), "summ-sync-extra-"));
  const name = "2023-07-01_2024-06-30_THOR_abcde_Example.csv";
  const other = manual.replace(".csv:1", ".csv:2");
  writeFileSync(join(same, name), `${HEADER}\n${other}`);
  assert.equal(readRun(run, [same]).rows.length, 2);
  writeFileSync(join(same, name), `${HEADER.replace("Type,", "Type,Note,")}\n${other.replace(",send,", ",send,x,")}`);
  assert.throws(() => readRun(run, [same]), /the same name as another wallet file, with another header/);
});

test("periods are whole days in the timezone", () => {
  assert.equal(new Date(startOfDay("2024-07-01", "UTC")).toISOString(), "2024-07-01T00:00:00.000Z");
  assert.equal(new Date(startOfDay("2024-07-01", "Pacific/Auckland")).toISOString(), "2024-06-30T12:00:00.000Z");
  assert.equal(new Date(startOfDay("2024-01-01", "America/New_York")).toISOString(), "2024-01-01T05:00:00.000Z");
  const period = { from: "2023-07-01", to: "2024-06-30" };
  assert.equal(inPeriod("2024-06-30T23:59:59.000Z", period, "UTC"), true);
  assert.equal(inPeriod("2024-06-30T13:00:00.000Z", period, "Pacific/Auckland"), false);
  assert.equal(inPeriod("2023-06-30T13:00:00.000Z", period, "Pacific/Auckland"), true);
  assert.equal(before("2023-12-31T23:59:59.000Z", "2024-01-01", "UTC"), true);
});

test("readRun takes the chain in any case, and refuses any other CSV file in csv/", () => {
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  mkdirSync(join(run, "csv"));
  writeFileSync(join(run, "csv", "all.csv"), `${HEADER}\n${LINE}`);
  writeFileSync(join(run, "csv", "all-2023-07-01_2024-06-30.csv"), `${HEADER}\n${LINE}`);
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_thor_abcde_Example.csv"), `${HEADER}\n${LINE}`);
  const { files, rows } = readRun(run);
  assert.deepEqual(
    [files.map((f) => [f.name, f.chain]), rows.map((r) => r.chain)],
    [[["2023-07-01_2024-06-30_thor_abcde_Example.csv", "THOR"]], ["THOR"]],
  );
  // A wallet the exporter's config lacks gets a file named after its address: its rows would be missing
  writeFileSync(join(run, "csv", "2023-07-01_2024-06-30_thor1wallet.csv"), `${HEADER}\n${LINE}`);
  assert.throws(() => readRun(run), /Not period wallet files .*: 2023-07-01_2024-06-30_thor1wallet\.csv/);
});

test("readUnmapped reads the run's unmapped.json, or null when the run has none", () => {
  const run = mkdtempSync(join(tmpdir(), "summ-sync-run-"));
  assert.equal(readUnmapped(run), null);
  const record = {
    kind: "failed",
    record: "midgard/swap.x",
    wallet: "thor1wallet",
    time: "2024-03-01T10:00:00.000Z",
    txids: [TXID],
    reason: "boom",
  };
  writeFileSync(join(run, "unmapped.json"), JSON.stringify({ version: 1, records: [record] }));
  // An exporter before times: the record's own time
  assert.deepEqual(readUnmapped(run), [{ ...record, times: [record.time], txids: [TXID.toLowerCase()] }]);
  const times = [record.time, "2024-02-28T09:00:00.000Z"];
  writeFileSync(join(run, "unmapped.json"), JSON.stringify({ version: 1, records: [{ ...record, times }] }));
  assert.deepEqual(readUnmapped(run), [{ ...record, times, txids: [TXID.toLowerCase()] }]);
  writeFileSync(join(run, "unmapped.json"), JSON.stringify({ records: [] }));
  assert.throws(() => readUnmapped(run), /not version 1/);
});
