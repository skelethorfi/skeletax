import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Progress } from "../src/utils/Progress.ts";

describe("Progress", () => {
  test("prints at most once an interval, with the time left, and at the end", () => {
    let time = 0;
    const lines: string[] = [];
    const progress = new Progress(
      "[THORChain] thor1x: actions",
      4,
      10_000,
      () => time,
      (line) => lines.push(line),
    );

    time = 4_000;
    progress.done();
    time = 12_000;
    progress.done();
    time = 15_000;
    progress.done();
    time = 200_000;
    progress.done();

    assert.deepEqual(lines, [
      "[THORChain] thor1x: actions 2/4, about 12 s left",
      "[THORChain] thor1x: actions 4/4, done in 3 min",
    ]);
  });

  test("a step shorter than the interval prints nothing", () => {
    let time = 0;
    const lines: string[] = [];
    const progress = new Progress(
      "x",
      2,
      10_000,
      () => time,
      (line) => lines.push(line),
    );

    time = 1_000;
    progress.done();
    time = 2_000;
    progress.done();

    assert.deepEqual(lines, []);
  });
});
