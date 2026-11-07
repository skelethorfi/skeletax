import axios from "axios";

// The one HTTP client for Midgard, THORNode, Viewblock, the EVM RPCs and the TCY distribution API, passed to the
// xchainjs API clients too. The public gateways (Liquify, Maya's Midgard) return occasional 502/504s and sometimes
// hang: a request that hangs fails after the timeout instead of stalling the run, and the throttle keeps under their
// rate limits. Retries are withRetry's, around each store fetch.
// Typed as axios's CommonJS declarations, which the xchainjs clients (CommonJS packages) name; this module gets the
// ES module ones, a separate but identical type. It is the same instance either way.
// The xchainjs clients pin axios exactly, so upgrade axios and xchainjs together: a mismatch installs a second
// axios for them, and this cast would hide it.
export const http = axios.create({ timeout: 60_000 }) as unknown as CjsAxiosInstance;

type CjsAxiosInstance = import("axios", { with: { "resolution-mode": "require" } }).AxiosInstance;

// Requests a second to each host
export const REQUESTS_PER_SECOND = 1;

// Hosts given more time between requests: Viewblock's quota is small, and a 429 locks it out for days
// (docs/specs/sends.md, Viewblock is best-effort), so it gets one request every 2 s
export const HOST_INTERVAL_MS: Record<string, number> = { "api.viewblock.io": 2000 };

// Spaces the requests to each host (e.g. gateway.liquify.com, eth.drpc.org) by 1/requestsPerSecond, each host on
// its own budget: a request to one host does not wait for another's. A request starts once its slot comes; it does
// not wait for the one before it to finish. The wait is before the request is sent, so it does not count towards
// the timeout. now and sleep are for tests.
export class HostThrottle {
  private readonly intervalMs: number;
  private readonly hostIntervalMs: Record<string, number>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  // The time each host's next request may start
  private readonly next = new Map<string, number>();

  constructor(
    requestsPerSecond: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hostIntervalMs: Record<string, number> = {},
  ) {
    this.intervalMs = 1000 / requestsPerSecond;
    this.hostIntervalMs = hostIntervalMs;
    this.now = now;
    this.sleep = sleep;
  }

  // Waits for the next slot of the URL's host
  async wait(url: string): Promise<void> {
    const host = hostOf(url);
    const now = this.now();
    const slot = Math.max(now, this.next.get(host) ?? now);
    this.next.set(host, slot + (this.hostIntervalMs[host] ?? this.intervalMs));

    if (slot > now) {
      await this.sleep(slot - now);
    }
  }
}

// The host of a request's URL; one that is not a full URL (no base) counts as one host
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const throttle = new HostThrottle(REQUESTS_PER_SECOND, undefined, undefined, HOST_INTERVAL_MS);

http.interceptors.request.use(async (config) => {
  await throttle.wait(http.getUri(config));
  return config;
});
