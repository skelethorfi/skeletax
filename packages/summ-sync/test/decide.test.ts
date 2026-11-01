import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runDecide } from "../src/decide.ts";
import { writeSnapshot } from "../src/snapshot.ts";

// Every value below is made up.
const SNAPSHOT = "2024-08-01T00-00-00";
const entry = { legId: "leg1", currency: "BBB", quantity: 2, reason: "the run exports this swap" };
const hold = { id: "old.csv:2", reason: "kept" };
const DECISIONS = [
  {
    id: "d1",
    kind: "swap-changed",
    filed: false,
    title: "t",
    lines: [],
    options: [
      { key: "a", title: "Delete.", result: "Goes.", config: { deleteManualEntries: [entry] } },
      { key: "b", title: "Keep.", result: "Stays.", config: { hold: [hold] } },
    ],
  },
  {
    id: "d2",
    kind: "lost-disposal",
    filed: false,
    title: "t",
    lines: [],
    options: [
      { key: "a", title: "Right.", result: "Apply.", config: {} },
      { key: "b", title: "Keep.", result: "Stays.", config: { hold: [{ id: "old.csv:9", reason: "kept" }] } },
    ],
  },
];

function state(
  config: object | null = { timezone: "UTC", hold: [{ id: "other", reason: "theirs" }] },
  snapshot = SNAPSHOT,
) {
  const dir = mkdtempSync(join(tmpdir(), "decide-"));
  writeSnapshot(join(dir, "snapshots", `${SNAPSHOT}.json`), {
    takenAt: "2024-08-01T00:00:00.000Z",
    total: 0,
    actions: [],
  });
  if (config) writeFileSync(join(dir, "summ-sync.json"), JSON.stringify(config));
  const plan = join(dir, "plans", "p");
  mkdirSync(plan, { recursive: true });
  writeFileSync(join(plan, "plan.json"), JSON.stringify({ snapshot, run: "/run", decisions: DECISIONS }));
  return { dir, plan };
}

const config = (dir: string) => JSON.parse(readFileSync(join(dir, "summ-sync.json"), "utf8"));

test("decide adds the options' config, keeps what is there, and the next plan can read it", () => {
  const { dir, plan } = state();
  runDecide(dir, plan, ["d1:a", "d2:b"]);
  const c = loadConfig(dir);
  assert.deepEqual(c.deleteManualEntries, [entry]);
  assert.deepEqual(
    c.hold.map((h) => h.id),
    ["other", "old.csv:9"],
  );
  assert.equal(c.timezone, "UTC");
  // Only what the user wrote and what was chosen: no defaults added to the file
  assert.deepEqual(Object.keys(config(dir)).sort(), ["deleteManualEntries", "hold", "timezone"]);
});

test("decide run twice adds nothing twice", () => {
  const { dir, plan } = state();
  runDecide(dir, plan, ["d1:a"]);
  runDecide(dir, plan, ["d1:a"]);
  assert.equal(loadConfig(dir).deleteManualEntries.length, 1);
});

test("an option with nothing to add leaves the file alone; with no file, one is made only when needed", () => {
  const { dir, plan } = state();
  const before = readFileSync(join(dir, "summ-sync.json"), "utf8");
  runDecide(dir, plan, ["d2:a"]);
  assert.equal(readFileSync(join(dir, "summ-sync.json"), "utf8"), before);
  const none = state(null);
  runDecide(none.dir, none.plan, ["d2:a"]);
  assert.throws(() => config(none.dir));
  runDecide(none.dir, none.plan, ["d1:b"]);
  assert.deepEqual(loadConfig(none.dir).hold, [hold]);
});

test("decide refuses what the plan does not have, and adds nothing of a list with one bad choice", () => {
  const { dir, plan } = state();
  const before = readFileSync(join(dir, "summ-sync.json"), "utf8");
  for (const [choices, message] of [
    [[], /name a decision/],
    [["d1"], /not a decision and an option/],
    [["d9:a"], /no decision d9/],
    [["d1:z"], /d1 has no option z/],
    [["d1:a", "d1:b"], /d1 is chosen twice/],
    [["d1:a", "d9:a"], /no decision d9/],
  ] as const) {
    assert.throws(() => runDecide(dir, plan, [...choices]), message);
    assert.equal(readFileSync(join(dir, "summ-sync.json"), "utf8"), before);
  }
});

test("decide refuses a plan apply would call out of date", () => {
  const stale = state(undefined, "2024-07-01T00-00-00");
  assert.throws(() => runDecide(stale.dir, stale.plan, ["d1:a"]), /pull and plan again/);
  const { dir, plan } = state();
  writeFileSync(
    join(dir, "apply-log.jsonl"),
    `${JSON.stringify({ time: "2024-08-02T00:00:00.000Z", plan: "q", call: "edit_transaction", kind: "edit", entry: "e", result: "ok" })}\n`,
  );
  assert.throws(() => runDecide(dir, plan, ["d1:a"]), /pull and plan again/);
});
