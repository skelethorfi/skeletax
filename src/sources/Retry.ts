// ENOTFOUND: the public gateways' DNS has failed for a few seconds at a time
const TRANSIENT_CODES = [
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
];

export function isTransient(error: any): boolean {
  const status = error?.response?.status ?? error?.status;
  const code = error?.code ?? error?.cause?.code;

  return (
    (typeof status === "number" && (status >= 500 || status === 429)) ||
    TRANSIENT_CODES.includes(code) ||
    error?.message === "fetch failed"
  );
}

// Runs fn again after a transient error, waiting longer each time
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  delaysMs: number[] = [5_000, 20_000, 60_000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt >= delaysMs.length || !isTransient(error)) {
        throw error;
      }

      const reason = error?.response?.status ?? error?.code ?? error?.cause?.code ?? error?.message;
      console.log(`[Retry] ${label}: ${reason}; retrying in ${delaysMs[attempt] / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

// A fetch that failed after withRetry's retries (or with an error it does not retry), told in its message. It has no
// status, code or cause, so an outer withRetry does not retry it again; the command prints it as one line, a
// network error (src/cli/args.ts).
export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}
