import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, parseConfig } from "../src/config.ts";

test("a missing config gives the defaults", () => {
  assert.deepEqual(loadConfig(mkdtempSync(join(tmpdir(), "summ-sync-"))), DEFAULTS);
});

test("a config overrides the defaults it names", () => {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-"));
  writeFileSync(
    join(dir, "summ-sync.json"),
    JSON.stringify({ managedSources: ["thorchain"], filedBefore: "2024-01-01" }),
  );
  assert.deepEqual(loadConfig(dir), {
    managedChains: ["THOR", "MAYA"],
    managedSources: ["thorchain"],
    filedBefore: "2024-01-01",
    timezone: "UTC",
    extraDirs: [],
    keepExtra: [],
    hold: [],
    deleteManual: [],
  });
});

test("a config with wrong types is refused", () => {
  assert.throws(() => parseConfig('{"managedChains": "THOR"}'), /managedChains must be a list/);
  assert.throws(() => parseConfig('{"filedBefore": "July 2025"}'), /filedBefore must be a date/);
  assert.throws(() => parseConfig('{"timezone": "Mars/Base"}'), /timezone must be an IANA name/);
  assert.throws(() => parseConfig('{"keepExtra": "x.csv:1"}'), /keepExtra must be a list/);
  assert.throws(() => parseConfig('{"hold": ["x"]}'), /hold must be a list/);
  assert.throws(() => parseConfig('{"hold": [{"id": "x", "reason": " "}]}'), /each with a reason/);
  assert.throws(() => parseConfig(`{"hold": [{"id": "x", "txid": "${"a".repeat(64)}", "reason": "r"}]}`), /hold must/);
  assert.throws(() => parseConfig('{"hold": [{"txid": "abc", "reason": "r"}]}'), /hold must/);
  assert.throws(() => parseConfig(`{"hold": [{"txid": "${"0".repeat(64)}", "reason": "r"}]}`), /hold must/);
});

test("a hold names a row ID or a txid", () => {
  const hold = [
    { id: "x", reason: "pending" },
    { txid: "A".repeat(64), reason: "pending" },
  ];
  assert.deepEqual(parseConfig(JSON.stringify({ hold })).hold, hold);
});

test("deleteManual needs a leg, currency, quantity and reason", () => {
  const entry = { legId: "l", currency: "BTC", quantity: 1, reason: "why" };
  assert.deepEqual(parseConfig(JSON.stringify({ deleteManual: [entry] })).deleteManual, [entry]);
  for (const bad of [{ ...entry, reason: " " }, { ...entry, quantity: "1" }, { ...entry, legId: "" }, "l"]) {
    assert.throws(() => parseConfig(JSON.stringify({ deleteManual: [bad] })), /deleteManual must be/);
  }
});
