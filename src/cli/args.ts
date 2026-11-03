import { parseArgs } from "node:util";
import axios from "axios";
import { StoreMissError } from "../sources/store/RecordStore.ts";
import { FetchError } from "../sources/Retry.ts";
import { InputError } from "../utils/InputError.ts";

// The export command's arguments and how its errors are printed. A typo in a flag (e.g. --ofline) is an error,
// not ignored: an ignored --offline would fetch from the network.

export const USAGE = `Usage: node src/full-export.ts [options] <config.toml|config.json>

Writes the wallets' rows as CSV files for Summ (docs/nodejs-instructions.md).

Options:
  --offline              read only from the store; anything not stored is an error
  --refetch-all          fetch every record again, not only wallet histories and pending records
  --replay <run folder>  read exactly the records that an earlier run used
  -h, --help             print this help`;

// A mistake in the command line: printed with the usage, exit code 1
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ExportArgs {
  help: boolean;
  configFile: string;
  offline: boolean;
  fetch?: "all";
  replay?: string;
}

export function parseExportArgs(argv: string[]): ExportArgs {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        offline: { type: "boolean" },
        "refetch-all": { type: "boolean" },
        replay: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error: any) {
    const message = String(error?.message ?? error);

    // --replay with no value, or followed by another option; an unknown option such as --replays takes the path below
    if (error?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && /^Option '--replay[ ']/.test(message)) {
      throw new UsageError("--replay needs a run folder");
    }

    // Node's message goes on to say how to pass a value starting with '-'; its first sentence is the mistake
    throw new UsageError(message.split(/\.\s/)[0].replace(/\.$/, ""));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    return { help: true, configFile: "", offline: false };
  }

  if (values.replay === "") {
    throw new UsageError("--replay needs a run folder");
  }

  if (values.offline && values["refetch-all"]) {
    throw new UsageError("--offline and --refetch-all cannot be used together");
  }

  if (positionals.length === 0) {
    throw new UsageError("must specify config file");
  }

  if (positionals.length > 1) {
    throw new UsageError(`expected one config file, got ${positionals.length}: ${positionals.join(" ")}`);
  }

  const configFile = positionals[0];

  if (!/\.(json|toml)$/i.test(configFile)) {
    throw new UsageError(`config file must be .toml or .json: ${configFile}`);
  }

  return {
    help: false,
    configFile,
    offline: values.offline ?? false,
    fetch: values["refetch-all"] ? "all" : undefined,
    replay: values.replay,
  };
}

// The one line to print for an error the user can act on (a bad command line, config or replayed run, something
// not stored, a network or file error); undefined for anything else, a bug, which is printed with its stack. Each
// kind is recognised by its class (or Node's errno fields), never by where it was thrown, so a TypeError while the
// config is read is still a bug.
export function knownErrorMessage(error: unknown): string | undefined {
  if (error instanceof UsageError || error instanceof InputError || error instanceof StoreMissError) {
    return error.message;
  }

  // A fetch that failed after its retries, wrapped with what was being fetched (e.g. a Midgard actions page)
  if (error instanceof FetchError) {
    return `Network error: ${error.message}`;
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const url = error.config?.url;
    const reason = status ? `HTTP ${status}` : (error.code ?? error.message);
    return `Network error: ${reason}${url ? ` (${url})` : ""}`;
  }

  // fetch() reports a network failure as TypeError "fetch failed", the reason in its cause
  if (error instanceof TypeError && error.message === "fetch failed") {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    const code = cause?.code ?? cause?.message;
    return `Network error: fetch failed${code ? ` (${code})` : ""}`;
  }

  // A file the run could not read or write: ENOENT, EACCES, ...
  const system = error as NodeJS.ErrnoException;

  if (error instanceof Error && typeof system.code === "string" && typeof system.syscall === "string") {
    return error.message;
  }

  return undefined;
}

// Prints an error for the terminal: a usage mistake with the usage, a known error as one line, anything else (a
// bug) with its stack. Returns the exit code.
export function printError(error: unknown, log: (text: string) => void = console.error): number {
  const known = knownErrorMessage(error);

  if (known === undefined) {
    log(error instanceof Error ? (error.stack ?? String(error)) : String(error));
  } else if (error instanceof UsageError) {
    log(`Error: ${known}\n\n${USAGE}`);
  } else {
    log(`Error: ${known.replace(/\s*\n\s*/g, " ")}`);
  }

  return 1;
}
