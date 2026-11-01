import axios from "axios";
import axiosThrottle from "axios-request-throttle";

// The one HTTP client for Midgard, THORNode and the TCY distribution API, passed to the xchainjs API clients
// too. The public gateways (Liquify, Maya's Midgard) return occasional 502/504s and sometimes hang: a request
// that hangs fails after the timeout instead of stalling the run, and the throttle keeps under their rate
// limits. Retries are withRetry's, around each store fetch.
// Typed as axios's CommonJS declarations, which the xchainjs clients and the throttle (CommonJS packages) name;
// this module gets the ES module ones, a separate but identical type. It is the same instance either way.
// The xchainjs clients pin axios exactly, so upgrade axios and xchainjs together: a mismatch installs a second
// axios for them, and this cast would hide it.
export const http = axios.create({ timeout: 60_000 }) as unknown as CjsAxiosInstance;

type CjsAxiosInstance = import("axios", { with: { "resolution-mode": "require" } }).AxiosInstance;

axiosThrottle.use(http, { requestsPerSecond: 1 });
