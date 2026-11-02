import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent } from "../src/utils/Concurrency.ts";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapConcurrent", () => {
  test("keeps the items' order, and runs at most `limit` at a time", async () => {
    let running = 0;
    let most = 0;
    const results = await mapConcurrent([30, 10, 20, 0, 5], 2, async (ms, index) => {
      most = Math.max(most, ++running);
      await tick(ms);
      running--;
      return `${index}:${ms}`;
    });

    assert.deepEqual(results, ["0:30", "1:10", "2:20", "3:0", "4:5"]);
    assert.equal(most, 2);
  });

  test("starts no more items after an error, and throws the first error once the started ones finish", async () => {
    const started: number[] = [];
    let finished = 0;

    await assert.rejects(
      mapConcurrent([0, 1, 2, 3, 4], 2, async (item) => {
        started.push(item);
        await tick(item === 0 ? 5 : 20);
        finished++;
        if (item === 0) {
          throw new Error("first");
        }
        return item;
      }),
      /first/,
    );

    assert.deepEqual(started, [0, 1]);
    assert.equal(finished, 2);
  });

  test("no items, no calls", async () => {
    assert.deepEqual(await mapConcurrent([], 4, async () => 1), []);
  });
});
