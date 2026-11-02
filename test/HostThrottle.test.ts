import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HostThrottle, hostOf, http } from "../src/sources/http.ts";

// A clock that only moves when the throttle sleeps
function fakeClock() {
  const clock = { time: 0, sleeps: [] as number[] };
  const now = () => clock.time;
  const sleep = async (ms: number) => {
    clock.sleeps.push(ms);
  };
  return { clock, now, sleep };
}

describe("HostThrottle", () => {
  test("spaces the requests to one host by 1/requestsPerSecond", async () => {
    const { clock, now, sleep } = fakeClock();
    const throttle = new HostThrottle(1, now, sleep);

    await Promise.all([
      throttle.wait("https://gateway.liquify.com/chain/thorchain_midgard/v2/actions"),
      throttle.wait("https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/status/AB"),
      throttle.wait("https://gateway.liquify.com/chain/thorchain_midgard/v2/history/rune"),
    ]);

    assert.deepEqual(clock.sleeps, [1000, 2000]);
  });

  test("gives each host its own budget", async () => {
    const { clock, now, sleep } = fakeClock();
    const throttle = new HostThrottle(1, now, sleep);

    await Promise.all([
      throttle.wait("https://gateway.liquify.com/chain/thorchain_api/x"),
      throttle.wait("https://eth.drpc.org"),
      throttle.wait("https://api.avax.network/ext/bc/C/rpc"),
      throttle.wait("https://midgard.mayachain.info/v2/actions"),
    ]);

    assert.deepEqual(clock.sleeps, []);
  });

  test("a host idle for longer than the interval is not made to wait", async () => {
    const { clock, now, sleep } = fakeClock();
    const throttle = new HostThrottle(2, now, sleep);

    await throttle.wait("https://eth.drpc.org");
    await throttle.wait("https://eth.drpc.org");
    clock.time = 5_000;
    await throttle.wait("https://eth.drpc.org");

    assert.deepEqual(clock.sleeps, [500]);
  });

  test("hostOf: the host and port; a relative URL counts as one host", () => {
    assert.equal(hostOf("https://eth.drpc.org"), "eth.drpc.org");
    assert.equal(hostOf("http://localhost:8080/v2/actions"), "localhost:8080");
    assert.equal(hostOf("/v2/actions"), "");
  });

  test("the client throttles by the request's full URL, base and path", async () => {
    // The interceptor the client was made with; xchainjs clients pass a baseURL and a path
    const interceptor = (http.interceptors.request as any).handlers[0].fulfilled;
    const config = { baseURL: "https://gateway.liquify.com/chain/thorchain_api", url: "/thorchain/tx/AB", headers: {} };

    assert.equal(http.getUri(config), "https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/AB");
    assert.equal(await interceptor(config), config);
  });
});
