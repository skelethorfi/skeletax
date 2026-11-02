import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { RUN_FILE, writeRunInfo } from "../src/cli/RunInfo.ts";

describe("RunInfo", () => {
  test("writes the config's timezone to run.json, UTC when it sets none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-info-"));
    writeRunInfo(path.join(dir, "a"), "Europe/London");
    assert.deepEqual(fs.readJsonSync(path.join(dir, "a", RUN_FILE)), { version: 1, timezone: "Europe/London" });
    writeRunInfo(path.join(dir, "b"), undefined);
    assert.deepEqual(fs.readJsonSync(path.join(dir, "b", RUN_FILE)), { version: 1, timezone: "UTC" });
  });
});
