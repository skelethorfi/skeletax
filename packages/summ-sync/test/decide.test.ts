import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSha, loadConfig } from "../src/config.ts";
import { readPlanFile, startState } from "../src/apply.ts";
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
  plan: object = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "decide-"));
  writeSnapshot(join(dir, "snapshots", `${SNAPSHOT}.json`), {
    takenAt: "2024-08-01T00:00:00.000Z",
    total: 0,
    actions: [],
  });
  if (config) writeFileSync(join(dir, "summ-sync.json"), JSON.stringify(config));
  const planDir = join(dir, "plans", "p");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    join(planDir, "plan.json"),
    JSON.stringify({ snapshot, run: "/run", configSha: configSha(dir), decisions: DECISIONS, delete: [], ...plan }),
  );
  return { dir, plan: planDir };
}

function said(run: () => void): string {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    run();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
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

test("what is already there stays, and is not added twice", () => {
  const theirs = { legId: "theirs", currency: "CCC", quantity: 1, reason: "named by hand" };
  const { dir, plan } = state({ deleteManualEntries: [theirs, entry], hold: [hold] });
  assert.match(
    said(() => runDecide(dir, plan, ["d1:a"])),
    /Nothing to add/,
  );
  assert.deepEqual(loadConfig(dir).deleteManualEntries, [theirs, entry]);
  const held = state({ deleteManualEntries: [theirs], hold: [hold] });
  runDecide(held.dir, held.plan, ["d1:a", "d2:b"]);
  assert.deepEqual(loadConfig(held.dir).deleteManualEntries, [theirs, entry]);
  const again = state({ hold: [hold] });
  runDecide(again.dir, again.plan, ["d1:b"]);
  assert.deepEqual(loadConfig(again.dir).hold, [hold]);
});

test("after a choice the plan is out of date: another choice from it, or the other option, is refused", () => {
  const { dir, plan } = state();
  runDecide(dir, plan, ["d1:a"]);
  const after = readFileSync(join(dir, "summ-sync.json"), "utf8");
  assert.throws(() => runDecide(dir, plan, ["d1:b"]), /summ-sync\.json changed since this plan was made/);
  assert.throws(() => runDecide(dir, plan, ["d2:b"]), /plan \S+ \/run/);
  assert.equal(readFileSync(join(dir, "summ-sync.json"), "utf8"), after);
  // A plan made before the config was recorded
  const old = state(undefined, SNAPSHOT, { configSha: undefined });
  assert.throws(() => runDecide(old.dir, old.plan, ["d1:a"]), /changed since this plan was made/);
});

test("filed and current-year entries are refused together, as the plan refuses them", () => {
  const decisions = [
    DECISIONS[0],
    {
      ...DECISIONS[0],
      id: "d2",
      filed: true,
      options: [{ key: "a", title: "T", result: "R", config: { deleteManualEntries: [{ ...entry, legId: "leg2" }] } }],
    },
    { ...DECISIONS[1], id: "d3", filed: true },
  ];
  const { dir, plan } = state(undefined, SNAPSHOT, { decisions });
  assert.throws(() => runDecide(dir, plan, ["d1:a", "d2:a"]), /both filed and current-year/);
  assert.equal(loadConfig(dir).deleteManualEntries.length, 0);
  // A hold or nothing to add names no entry, so it mixes with either
  runDecide(dir, plan, ["d1:a", "d3:a"]);
  assert.equal(loadConfig(dir).deleteManualEntries.length, 1);
});

test("decide says what it chose and how to plan again, with the plan's scope", () => {
  const { dir, plan } = state(undefined, SNAPSHOT, { scopeFile: "/scope.txt" });
  const out = said(() => runDecide(dir, plan, ["d1:a"]));
  assert.match(out, /d1 \(t\): Delete\. 1 added\. Goes\./);
  assert.match(out, /Nothing is written to Summ/);
  assert.match(out, /plan \S+ \/run --only \/scope\.txt/);
  const none = state();
  assert.doesNotMatch(
    said(() => runDecide(none.dir, none.plan, ["d2:a"])),
    /Plan again/,
  );
});

test("the file stays what it was: its mode, a link to it, no empty lists, nothing left beside it, a broken one refused", () => {
  const { dir, plan } = state({ timezone: "UTC" });
  const file = join(dir, "summ-sync.json");
  chmodSync(file, 0o600);
  const planNow = JSON.parse(readFileSync(join(plan, "plan.json"), "utf8"));
  assert.ok(planNow.configSha);
  runDecide(dir, plan, ["d1:b"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(config(dir)).sort(), ["hold", "timezone"]);
  assert.equal(existsSync(`${file}.tmp`), false);
  const linked = state(null);
  const real = join(linked.dir, "real.json");
  writeFileSync(real, "{}");
  symlinkSync(real, join(linked.dir, "summ-sync.json"));
  const plan2 = JSON.parse(readFileSync(join(linked.plan, "plan.json"), "utf8"));
  writeFileSync(join(linked.plan, "plan.json"), JSON.stringify({ ...plan2, configSha: configSha(linked.dir) }));
  runDecide(linked.dir, linked.plan, ["d1:b"]);
  assert.ok(lstatSync(join(linked.dir, "summ-sync.json")).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).hold, [hold]);
  const broken = state({ hold: "not a list" });
  assert.throws(() => runDecide(broken.dir, broken.plan, ["d1:a"]), /hold must be a list/);
  const invalid = state(undefined, SNAPSHOT, {
    decisions: [
      {
        ...DECISIONS[0],
        options: [{ key: "a", title: "T", result: "R", config: { hold: [{ id: "x", reason: "" }] } }],
      },
    ],
  });
  const before = readFileSync(join(invalid.dir, "summ-sync.json"), "utf8");
  assert.throws(() => runDecide(invalid.dir, invalid.plan, ["d1:a"]), /hold must be a list/);
  assert.equal(readFileSync(join(invalid.dir, "summ-sync.json"), "utf8"), before);
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

test("what the plan already deletes by name counts, and an option spanning both is refused", () => {
  const named = {
    id: null,
    summId: "m",
    filed: true,
    legIds: ["x"],
    actionIds: [],
    reason: "r",
    otherLegs: 0,
    manual: true,
  };
  const { dir, plan } = state(undefined, SNAPSHOT, { delete: [named] });
  assert.throws(() => runDecide(dir, plan, ["d1:a"]), /apply those already named first/);
  const decisions = [{ ...DECISIONS[0], options: [{ ...DECISIONS[0].options[0], spans: true }] }];
  const spanning = state(undefined, SNAPSHOT, { decisions });
  assert.throws(() => runDecide(spanning.dir, spanning.plan, ["d1:a"]), /span filed and current years/);
});

test("apply refuses a plan from an older config until it has written, and goes on after", () => {
  const { dir, plan } = state();
  const { plan: file, sha } = readPlanFile(plan);
  const flags = { approveDeletes: true, approveFiled: false };
  const start = { time: "2024-07-31T00:00:00.000Z", plan: "p", run: "r", call: "apply-start", planSha: sha, flags };
  assert.equal(startState(dir, file, "p", sha, flags), "first");
  runDecide(dir, plan, ["d1:a"]);
  const refused = /summ-sync\.json changed since this plan was made/;
  assert.throws(() => startState(dir, file, "p", sha, flags), refused);
  // Begun, but a run without its flag wrote nothing
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n`);
  assert.throws(() => startState(dir, file, "p", sha, flags), refused);
  // Finished with nothing to write: still complete
  const stop = { ...start, call: "apply-stop", reason: "complete" };
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n${JSON.stringify(stop)}\n`);
  assert.equal(startState(dir, file, "p", sha, flags), "complete");
  const wrote = { ...start, call: "edit_transaction", kind: "edit", entry: "e", result: "ok" };
  writeFileSync(join(dir, "apply-log.jsonl"), `${JSON.stringify(start)}\n${JSON.stringify(wrote)}\n`);
  assert.equal(startState(dir, file, "p", sha, flags), "resume");
});

test("the command line runs it", () => {
  const { dir, plan } = state();
  const out = execFileSync(
    process.execPath,
    [join(import.meta.dirname, "..", "bin", "summ-sync.ts"), "decide", dir, plan, "d1:a"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  assert.match(out, /Nothing is written to Summ/);
  assert.equal(loadConfig(dir).deleteManualEntries.length, 1);
});
