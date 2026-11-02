import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { http } from "../src/sources/http.ts";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { MidgardService } from "../src/sources/thorchain/MidgardService.ts";

const midgard = () =>
  new MidgardService(
    new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-midgard-actions-"))),
    "midgard",
    "https://midgard",
  );

// `n` distinct actions, newest first, the way Midgard lists them
const actions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: String((2_000_000_000 - i) * 1e9),
    height: String(1_000_000 - i),
    type: "send",
    status: "success",
    in: [{ address: "thor1w", coins: [{ asset: "THOR.RUNE", amount: "1" }], txID: `TX${i}` }],
    out: [],
    pools: [],
    metadata: {},
  }));

// A fake Midgard serving `all` in pages of 50 by cursor. Tokens are 64-bit, past Number.MAX_SAFE_INTEGER, so a token
// that went through a JS number would not be found. `count` is on the first page only, as Midgard does; the last page
// is answered with `last` (an empty page with no token, or a short page with none).
function fakeMidgard(all: any[], options: { count?: string; emptyLastPage?: boolean } = {}) {
  const base = 283844929000000173n;
  const tokenAt = (i: number) => String(base - BigInt(i));
  const get = mock.method(http, "get", async (url: string) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("limit"), "50");
    assert.equal(params.has("offset"), false);
    const token = params.get("nextPageToken");
    let start = 0;

    if (token !== null) {
      start = all.findIndex((_, i) => tokenAt(i) === token);
      start = start === -1 ? (token === tokenAt(all.length) ? all.length : -1) : start;
      assert.notEqual(start, -1, `unknown nextPageToken ${token}`);
    }

    const page = all.slice(start, start + 50);
    const end = start + page.length;
    const more = end < all.length || (options.emptyLastPage && page.length > 0);
    return {
      data: {
        ...(token === null ? { count: options.count ?? String(all.length) } : {}),
        actions: page,
        meta: { nextPageToken: more ? tokenAt(end) : "", prevPageToken: "" },
      },
    } as any;
  });
  return get;
}

afterEach(() => mock.restoreAll());

describe("Midgard actions list (cursor paging)", () => {
  for (const n of [0, 49, 50, 100, 101, 5_000, 5_519]) {
    test(`${n} actions, the last page empty`, async () => {
      const all = actions(n);
      const get = fakeMidgard(all, { emptyLastPage: true });

      const listed = await midgard().getActions("thor1w");
      assert.deepEqual(
        listed.map((a) => a.in[0].txID),
        all.map((a) => a.in[0].txID),
      );
      assert.equal(get.mock.calls.length, Math.ceil(n / 50) + (n > 0 ? 1 : 0) || 1);
    });
  }

  test("a short last page with no token ends the list", async () => {
    const get = fakeMidgard(actions(120));

    assert.equal((await midgard().getActions("thor1w")).length, 120);
    assert.equal(get.mock.calls.length, 3);
  });

  test("count -1 is not checked", async () => {
    fakeMidgard(actions(75), { count: "-1" });

    assert.equal((await midgard().getActions("thor1w")).length, 75);
  });

  test("the token reaches the URL as Midgard wrote it", async () => {
    const get = fakeMidgard(actions(60));

    await midgard().getActions("thor1w");
    assert.equal(new URL(get.mock.calls[1].arguments[0]).searchParams.get("nextPageToken"), "283844929000000123");
  });

  test("a page that repeats its token is an error, not a loop", async () => {
    mock.method(http, "get", async () => ({ data: { actions: actions(50), meta: { nextPageToken: "7" } } }) as any);

    await assert.rejects(midgard().getActions("thor1w"), /same nextPageToken 7/);
  });

  test("a transient error retries that page, not the list", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const all = actions(120);
    let failed = false;
    fakeMidgard(all);
    const urls: string[] = [];
    const serve = http.get;
    mock.method(http, "get", async (url: string) => {
      urls.push(url);
      if (url.includes("nextPageToken") && !failed) {
        failed = true;
        throw Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } });
      }
      return serve.call(http, url);
    });

    const listing = midgard().getActions("thor1w");
    while (urls.length < 3) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(5_000);
    }
    assert.equal((await listing).length, 120);
    assert.deepEqual(
      urls.map((url) => new URL(url).searchParams.get("nextPageToken")),
      [null, "283844929000000123", "283844929000000123", "283844929000000073"],
    );
  });
});
