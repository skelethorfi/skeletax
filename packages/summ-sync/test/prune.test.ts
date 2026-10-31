import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prune, snapshotTime } from "../src/prune.ts";
import { writeSnapshot } from "../src/snapshot.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args],
    { stdio: "pipe" },
  );

/** A git repo with the state dir in a sub folder: snapshots listing the given action ids, and those actions stored. */
function repo(snapshots: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "summ-sync-prune-"));
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "start");
  const state = join(root, "summ");
  mkdirSync(join(state, "actions"), { recursive: true });
  for (const [name, ids] of Object.entries(snapshots)) {
    writeSnapshot(join(state, "snapshots", `${name}.json`), {
      takenAt: name,
      total: ids.length,
      actions: ids.map((id) => ({ id, txHash: "", category: "", tags: [] })),
    });
    for (const id of ids) writeFileSync(join(state, "actions", `${id}.json`), "{}\n");
  }
  return state;
}

const S1 = "2024-01-01T00-00-00";
const S2 = "2024-01-20T12-00-00";
const S3 = "2024-01-31T00-00-00";
const NOW = Date.parse("2024-02-01T00:00:00Z");

test("snapshotTime reads the UTC time in a snapshot name", () => {
  assert.equal(snapshotTime(S2), Date.parse("2024-01-20T12:00:00Z"));
});

test("prune removes snapshots older than the days given and the stored actions only they list, once committed", () => {
  const state = repo({ [S1]: ["a", "b"], [S2]: ["b", "c"], [S3]: ["c", "d"] });
  const prune14 = () => prune(state, 14, NOW);
  assert.deepEqual(prune14().uncommitted.sort(), ["actions/a.json", `snapshots/${S1}.json`]);
  assert.ok(existsSync(join(state, "actions", "a.json")), "nothing removed while uncommitted");
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  writeFileSync(join(state, "actions", "a.json"), '{"changed": true}\n');
  assert.deepEqual(prune14().uncommitted, ["actions/a.json"], "a changed file is not committed");
  git(state, "checkout", "--", ".");
  assert.deepEqual(prune14(), { removed: [`snapshots/${S1}.json`, "actions/a.json"], uncommitted: [] });
  assert.deepEqual(
    ["a", "b", "c", "d"].map((id) => existsSync(join(state, "actions", `${id}.json`))),
    [false, true, true, true],
  );
  assert.equal(existsSync(join(state, "snapshots", `${S1}.json`)), false);
  assert.deepEqual(prune14(), { removed: [], uncommitted: [] });
  // never the latest, however old
  assert.deepEqual(prune(state, 0, NOW).removed, [`snapshots/${S2}.json`, "actions/b.json"]);
});

test("prune keeps the actions apply saved before a delete, and ignores files that are not stored actions", () => {
  const state = repo({ [S1]: ["a", "b"], [S3]: ["c"] });
  writeFileSync(
    join(state, "apply-log.jsonl"),
    JSON.stringify({ call: "bulk_edit_transactions", operation: "delete", actionIds: ["b"] }) + "\n",
  );
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  writeFileSync(join(state, "actions", ".DS_Store"), "");
  assert.deepEqual(prune(state, 14, NOW), { removed: [`snapshots/${S1}.json`, "actions/a.json"], uncommitted: [] });
  assert.ok(existsSync(join(state, "actions", "b.json")));
});

test("prune keeps every action a log line names as saved, a list or one file, wherever the state dir was then", () => {
  const state = repo({ [S1]: ["a", "b", "c"], [S3]: ["d"] });
  writeFileSync(
    join(state, "apply-log.jsonl"),
    [
      { call: "edit_transaction", kind: "split", saved: "/elsewhere/actions/b.json" },
      { call: "bulk_edit_transactions", operation: "delete", saved: ["/elsewhere/actions/c.json"] },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  assert.deepEqual(prune(state, 14, NOW).removed, [`snapshots/${S1}.json`, "actions/a.json"]);
  assert.ok(existsSync(join(state, "actions", "b.json")));
  assert.ok(existsSync(join(state, "actions", "c.json")));
});

/** A plan folder on snapshot S1, with one pre-image. */
function planWithPre(state: string, line: object): string {
  const pre = join(state, "plans", "p", "pre");
  mkdirSync(pre, { recursive: true });
  writeFileSync(join(state, "plans", "p", "plan.json"), JSON.stringify({ snapshot: S1 }));
  writeFileSync(join(pre, "edit-0.edit.json"), "{}\n");
  writeFileSync(join(state, "apply-log.jsonl"), JSON.stringify(line) + "\n");
  return join(pre, "edit-0.edit.json");
}

test("prune keeps the snapshot of a plan with pre-images, its details file, what it lists, and the pre-images", () => {
  const state = repo({ [S1]: ["a"], [S3]: ["b"] });
  const details = join(state, "snapshots", `${S1}.details.jsonl`);
  writeFileSync(details, "{}\n");
  const pre = planWithPre(state, { plan: "p", call: "edit_transaction", pre: "plans/p/pre/edit-0.edit.json" });
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  assert.deepEqual(prune(state, 14, NOW), { removed: [], uncommitted: [] });
  for (const file of [join(state, "snapshots", `${S1}.json`), details, join(state, "actions", "a.json"), pre])
    assert.ok(existsSync(file), file);
});

test("a plan with only lines from before pre-images keeps no snapshot; a plan folder is never pruned", () => {
  const state = repo({ [S1]: ["a"], [S3]: ["b"] });
  const pre = planWithPre(state, { plan: "p", call: "edit_transaction" });
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  assert.deepEqual(prune(state, 14, NOW).removed, [`snapshots/${S1}.json`, "actions/a.json"]);
  assert.ok(existsSync(pre));
});

test("prune stops when a plan with pre-images has lost its plan file: it cannot say which snapshot to keep", () => {
  const state = repo({ [S1]: ["a"], [S3]: ["b"] });
  planWithPre(state, { plan: "p", call: "edit_transaction", pre: "plans/p/pre/edit-0.edit.json" });
  rmSync(join(state, "plans", "p", "plan.json"));
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  assert.throws(() => prune(state, 14, NOW), /plan\.json is gone/);
  assert.ok(existsSync(join(state, "snapshots", `${S1}.json`)));
});

test("prune refuses with no snapshot, and outside git", () => {
  const state = repo({ [S1]: ["a"] });
  git(state, "add", ".");
  git(state, "commit", "-q", "-m", "state");
  rmSync(join(state, "snapshots"), { recursive: true });
  assert.throws(() => prune(state, 14, NOW), /No snapshot/);
  assert.ok(existsSync(join(state, "actions", "a.json")));
  const outside = mkdtempSync(join(tmpdir(), "summ-sync-nogit-"));
  writeSnapshot(join(outside, "snapshots", `${S1}.json`), { takenAt: S1, total: 0, actions: [] });
  writeSnapshot(join(outside, "snapshots", `${S3}.json`), { takenAt: S3, total: 0, actions: [] });
  assert.throws(() => prune(outside, 14, NOW), /needs the state dir in a git repo/);
});
