import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { http } from "../src/sources/http.ts";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { MidgardService } from "../src/sources/thorchain/MidgardService.ts";
import { FetchError } from "../src/sources/Retry.ts";
import { knownErrorMessage } from "../src/cli/args.ts";

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
function fakeMidgard(
  all: any[],
  options: { count?: string; emptyLastPage?: boolean; fail?: (url: string) => boolean } = {},
) {
  const base = 283844929000000173n;
  const tokenAt = (i: number) => String(base - BigInt(i));
  const get = mock.method(http, "get", async (url: string) => {
    if (options.fail?.(url)) {
      throw Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } });
    }

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

afterEach(() => mock.reset());

const tokens = (get: any) =>
  get.mock.calls.map((call: any) => new URL(call.arguments[0]).searchParams.get("nextPageToken"));

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

  test("count is only a check: -1 is ignored, a mismatch logged", async () => {
    const log = mock.method(console, "log", () => {});
    const counted = () => log.mock.calls.filter((call) => /Midgard counted/.test(String(call.arguments[0]))).length;

    fakeMidgard(actions(75), { count: "-1" });
    assert.equal((await midgard().getActions("thor1w")).length, 75);
    assert.equal(counted(), 0);

    mock.method(http, "get", async () => ({ data: { count: "80", actions: actions(75), meta: {} } }) as any);
    assert.equal((await midgard().getActions("thor1w")).length, 75);
    assert.equal(counted(), 1);
  });

  test("a page with no actions array is an error, not the end of the list", async () => {
    mock.method(http, "get", async () => ({ data: "<html>Bad gateway</html>" }) as any);

    await assert.rejects(midgard().getActions("thor1w"), /page 0: no actions in the answer/);
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

  // withRetry waits 5s, 20s and 60s between tries; the fake clock is moved on until the list settles
  async function settle<T>(listing: Promise<T>): Promise<T> {
    let done = false;
    listing.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(60_000);
    }
    return listing;
  }

  test("a transient error retries that page, not the list", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let failed = false;
    const get = fakeMidgard(actions(120), {
      fail: (url) => url.includes("nextPageToken") && !failed && (failed = true),
    });

    assert.equal((await settle(midgard().getActions("thor1w"))).length, 120);
    assert.deepEqual(tokens(get), [null, "283844929000000123", "283844929000000123", "283844929000000073"]);
  });

  test("a page that keeps failing fails the list once, without restarting it", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const get = fakeMidgard(actions(120), { fail: (url) => url.includes("nextPageToken") });

    await assert.rejects(settle(midgard().getActions("thor1w")), /actions of thor1w, page 1: HTTP 503/);
    assert.deepEqual(tokens(get), [null, ...Array(4).fill("283844929000000123")]);
  });

  // The command prints it as one line, a network error, not as a bug with its stack
  test("a failed page is a FetchError, named by its code", async () => {
    mock.method(http, "get", async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND midgard"), { code: "ENOTFOUND" });
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    const error = await settle(midgard().getActions("thor1w")).catch((error) => error);

    assert.ok(error instanceof FetchError);
    assert.equal(knownErrorMessage(error), "Network error: [Midgard] actions of thor1w, page 0: ENOTFOUND");
  });
});
