import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlanFile, startState } from "../src/apply.ts";
import { configSha, parseConfig } from "../src/config.ts";
import { writeSnapshot } from "../src/snapshot.ts";

// Every value below is made up.
const SNAPSHOT = "2024-08-01T00-00-00";
const entry = (legId: string, filed: boolean) => ({
  id: null,
  summId: legId,
  filed,
  legIds: [legId],
  actionIds: [],
  reason: "r",
  otherLegs: 0,
});
const decision = (key: string, deletes: string[], filed = false) => ({
  key,
  deletes,
  value: null,
  kind: "lost-disposal" as const,
  filed,
  title: "t",
  lines: [],
  options: [],
});
const ON = { approveDeletes: true, approveFiled: false };

function setup(plan: object) {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  writeSnapshot(join(dir, "snapshots", `${SNAPSHOT}.json`), {
    takenAt: "2024-08-01T00:00:00.000Z",
    total: 0,
    actions: [],
  });
  writeFileSync(join(dir, "summ-sync.json"), "{}");
  const file = {
    snapshot: SNAPSHOT,
    run: "/run",
    configSha: configSha(dir),
    delete: [],
    ...plan,
  } as unknown as PlanFile;
  return { dir, file };
}

test("apply --approve-deletes refuses a delete a decision is open over, and names it", () => {
  const { dir, file } = setup({ delete: [entry("leg1", false)], decisions: [decision("2024-03-01-abcdef", ["leg1"])] });
  assert.throws(
    () => startState(dir, file, "p", "sha", ON),
    /1 decisions are open over this plan's deletes: 2024-03-01-abcdef\./,
  );
  assert.equal(startState(dir, file, "p", "sha", { ...ON, approveDeletes: false }), "first");
});

test("only what this apply would delete counts: a filed delete does not stop a current-year run, nor a decision over none", () => {
  const { dir, file } = setup({
    delete: [entry("leg1", true), entry("leg2", false)],
    decisions: [decision("k", ["leg1"], true)],
  });
  assert.equal(startState(dir, file, "p", "sha", ON), "first");
  assert.throws(
    () => startState(dir, file, "p", "sha", { ...ON, approveFiled: true }),
    /open over this plan's deletes: k/,
  );
  const none = setup({ delete: [entry("leg2", false)], decisions: [decision("k", [])] });
  assert.equal(startState(none.dir, none.file, "p", "sha", ON), "first");
});

test("a plan with no decisions, or from before them, is not stopped", () => {
  const { dir, file } = setup({ delete: [entry("leg1", false)] });
  assert.equal(startState(dir, file, "p", "sha", ON), "first");
  const old = setup({ delete: [entry("leg1", false)], configSha: undefined });
  writeFileSync(join(old.dir, "summ-sync.json"), '{"timezone":"UTC"}');
  assert.equal(startState(old.dir, old.file, "p", "sha", ON), "first");
});

test("a plan whose decisions have no keys, from before they did, is told to plan again", () => {
  const { dir, file } = setup({
    delete: [entry("leg1", false)],
    decisions: [{ id: "d1", title: "t", lines: [], options: [] }],
  });
  assert.throws(() => startState(dir, file, "p", "sha", ON), /have no keys.*plan again/);
  assert.equal(startState(dir, file, "p", "sha", { ...ON, approveDeletes: false }), "first");
});

test("a run without the flag writes nothing, so the refusal still applies when it comes with the flag", () => {
  const { dir, file } = setup({ delete: [entry("leg1", false)], decisions: [decision("k", ["leg1"])] });
  const start = {
    time: "2024-07-31T00:00:00.000Z",
    plan: "p",
    run: "r",
    call: "apply-start",
    planSha: "sha",
    flags: { approveDeletes: false, approveFiled: false },
  };
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n`);
  assert.throws(() => startState(dir, file, "p", "sha", ON), /open over this plan's deletes/);
});

test("apply refuses a plan from an older config until it has written, and a finished one stays complete", () => {
  const { dir, file } = setup({});
  const flags = { approveDeletes: false, approveFiled: false };
  assert.equal(startState(dir, file, "p", "sha", flags), "first");
  writeFileSync(join(dir, "summ-sync.json"), '{"hold":[{"id":"x","reason":"y"}]}');
  const refused = /summ-sync\.json changed since this plan was made/;
  assert.throws(() => startState(dir, file, "p", "sha", flags), refused);
  const start = { time: "2024-07-31T00:00:00.000Z", plan: "p", run: "r", call: "apply-start", planSha: "sha", flags };
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n`);
  assert.throws(() => startState(dir, file, "p", "sha", flags), refused);
  const stop = { ...start, call: "apply-stop", reason: "complete" };
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n${JSON.stringify(stop)}\n`);
  assert.equal(startState(dir, file, "p", "sha", flags), "complete");
  const wrote = { ...start, call: "edit_transaction", kind: "edit", entry: "e", result: "ok" };
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n${JSON.stringify(wrote)}\n`);
  assert.equal(startState(dir, file, "p", "sha", flags), "resume");
});

test("a config still saying <why> is refused: the reason is the user's to write", () => {
  for (const text of [
    '{"accept":[{"key":"k","reason":"<why>"}]}',
    '{"hold":[{"id":"x","reason":"<why>"}]}',
    '{"deleteManualEntries":[{"legId":"l","currency":"A","quantity":1,"reason":"<why>"}]}',
  ])
    assert.throws(() => parseConfig(text), /still say <why>/);
  assert.throws(() => parseConfig('{"accept":[{"key":"k"}]}'), /accept must be a list/);
  assert.throws(() => parseConfig('{"accept":[{"key":"","reason":"r"}]}'), /accept must be a list/);
  assert.throws(() => parseConfig('{"accept":[{"key":"k","reason":"  "}]}'), /accept must be a list/);
  assert.throws(() => parseConfig('{"accept":[{"key":"k","reason":" <why> "}]}'), /still say <why>/);
  assert.throws(() => parseConfig('{"accept":"k"}'), /accept must be a list/);
  assert.equal(parseConfig('{"accept":[{"key":"k","reason":"read it"}]}').accept[0].key, "k");
});
