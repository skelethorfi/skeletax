#!/usr/bin/env node
// summ-sync: keep Summ matching a set of Summ CSV files (README.md).

import { runApply, WRITE_TOOLS } from "../src/apply.ts";
import { login, READ_SCOPE, WRITE_SCOPE } from "../src/auth.ts";
import { McpClient, READ_TOOLS } from "../src/mcp.ts";
import { runPrune } from "../src/prune.ts";
import { pull } from "../src/pull.ts";
import { writePlan } from "../src/write-plan.ts";

const USAGE = `Usage:
  summ-sync login <state dir> [--write]   authorise in the browser (read, or read and write)
  summ-sync pull  <state dir> [<run dir>] [--full]  snapshot Summ into <state dir>/snapshots/
  summ-sync plan  <state dir> <run dir> [--only <scope file>]
                                          compare a run with the latest snapshot (calls nothing); with
                                          --only, only the rows the file's entries match
  summ-sync apply <state dir> <plan dir> [--dry-run] [--approve-deletes] [--approve-filed]
                                          carry out a plan (needs login --write)
  summ-sync prune <state dir> [--older-than <days>]
                                          remove committed snapshots older than that (default 30, never the
                                          latest) and the stored actions only they list
  summ-sync tools <state dir>             list the MCP server's tools`;

const [command, stateDir, ...rest] = process.argv.slice(2);
try {
  if (!stateDir) throw new Error(USAGE);
  if (command === "login") await login(stateDir, rest.includes("--write") ? WRITE_SCOPE : READ_SCOPE);
  else if (command === "pull")
    await pull(
      stateDir,
      rest.find((a) => !a.startsWith("--")),
      { full: rest.includes("--full") },
    );
  else if (command === "plan") {
    const at = rest.indexOf("--only");
    const only = at >= 0 ? rest[at + 1] : undefined;
    if (at >= 0 && (only === undefined || only.startsWith("--"))) throw new Error("--only needs a scope file");
    if (rest.lastIndexOf("--only") !== at) throw new Error("--only given twice");
    const args = rest.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
    const unknown = args.find((a) => a.startsWith("--"));
    if (unknown) throw new Error(`plan: unknown option ${unknown}\n${USAGE}`);
    const [runDir, ...extra] = args;
    if (!runDir || extra.length) throw new Error(USAGE);
    writePlan(stateDir, runDir, only);
  } else if (command === "apply") {
    if (!rest[0]) throw new Error(USAGE);
    const dryRun = rest.includes("--dry-run");
    const client = new McpClient(stateDir, dryRun ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]);
    await runApply(client, stateDir, rest[0], {
      dryRun,
      approveDeletes: rest.includes("--approve-deletes"),
      approveFiled: rest.includes("--approve-filed"),
    });
  } else if (command === "prune") {
    const at = rest.indexOf("--older-than");
    const days = at >= 0 ? rest[at + 1] : undefined;
    if (at >= 0 && !/^\d+(\.\d+)?$/.test(days ?? "")) throw new Error("--older-than needs a number of days");
    runPrune(stateDir, days === undefined ? undefined : Number(days));
  } else if (command === "tools") {
    const client = new McpClient(stateDir);
    await client.connect();
    for (const t of await client.listTools())
      console.log(`${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`);
  } else throw new Error(USAGE);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(message.startsWith("Usage") ? message : `Error: ${message}`);
  process.exit(1);
}
