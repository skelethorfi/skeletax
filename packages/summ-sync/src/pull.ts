// pull: a snapshot of Summ's state, never patched afterwards (spec: docs/specs/summ-sync.md, State dir).
//
//   <state dir>/snapshots/<time>.details.jsonl   every action detail read, one line each, appended as it is read,
//                                                so a stopped pull resumes and each pull's state stays on record
//   <state dir>/snapshots/<time>.json            the counts and one entry per listed action; written last, so its
//                                                existence means the pull finished and its checks passed
//
// Every detail is read on every pull: an action can change and keep its id. The range defaults to the run's periods.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nextDay, startOfDay } from "./dates.ts";
import { McpClient } from "./mcp.ts";
import { matchesOwnLegs } from "./plan.ts";
import { type ListedAction, parseActions, parseDetail, parsePageHeader } from "./parse.ts";
import { type Config, extraDirsOf, loadConfig } from "./config.ts";
import { periodsOf, readRun, type Row, type RunFile } from "./run.ts";
import {
  detailsFile,
  legsOf,
  normaliseTxid,
  type PullRange,
  readDetails,
  type SnapshotEntry,
  writeSnapshot,
} from "./snapshot.ts";

const PAGE_SIZE = 250;
const DAY_MS = 86_400_000;
/** Lists until two rounds in a row agree; beyond this Summ is not settling. */
const MAX_ROUNDS = 5;
/** Details older than this are not resumed: too much could have changed under ids they read. */
const RESUME_MS = DAY_MS;

type Client = Pick<McpClient, "connect" | "callTool">;

async function queryAll(client: Client, filter?: Record<string, unknown>): Promise<string[]> {
  const pages: string[] = [];
  for (let page = 1; ; page++) {
    const text = await client.callTool("query_summ_transactions", {
      count: PAGE_SIZE,
      page,
      sort: "oldestFirst",
      includeHidden: true,
      ...(filter ? { filter } : {}),
    });
    pages.push(text);
    const header = parsePageHeader(text);
    process.stdout.write(`\r  page ${header.page}/${header.pages} (${header.total} total)   `);
    if (header.page >= header.pages) break;
  }
  process.stdout.write("\n");
  return pages;
}

/** The txids of the run's rows plan matches to Summ's own imports: categorised rows, and protocol rows whose fee is
 * the gas of a request. */
export function categorisedTxids(rows: Row[], config: Config): Set<string> {
  const managed = new Set(config.managedChains);
  return new Set(rows.filter((r) => matchesOwnLegs(r, managed)).flatMap((r) => r.txids));
}

/** The ids of the listed actions whose tx hash is one of `txids`. */
export function actionsWithTxids(actions: ListedAction[], txids: Set<string>): string[] {
  return actions
    .filter((a) => typeof a["Tx Hash"] === "string" && txids.has(normaliseTxid(a["Tx Hash"])))
    .map((a) => a["Action ID"] as string);
}

const str = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/** A listed action as the snapshot keeps it. */
export function snapshotEntry(a: ListedAction): SnapshotEntry {
  return { id: a["Action ID"] as string, txHash: str(a["Tx Hash"]), category: str(a["Action Category"]), tags: a.tags };
}

/** The run's periods, with a day's margin each side for a leg dated near a boundary. */
export function rangeOf(files: Pick<RunFile, "period">[], timeZone: string): PullRange {
  const periods = periodsOf(files as RunFile[]);
  const from = periods.map((p) => p.from).sort()[0];
  const to = periods
    .map((p) => p.to)
    .sort()
    .at(-1) as string;
  return {
    from,
    to,
    after: startOfDay(from, timeZone) - DAY_MS,
    before: startOfDay(nextDay(to), timeZone) + DAY_MS,
  };
}

/** A filter limited to the range. */
function inRange(range: PullRange | null, rule?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!range) return rule;
  return {
    type: "and",
    rules: [...(rule ? [rule] : []), { type: "after", value: range.after }, { type: "before", value: range.before }],
  };
}

interface Header {
  startedAt: string;
  run: string | null;
  range: PullRange | null;
  managedSources: string[];
}

/** The newest stopped pull of the same run, range and sources, and recent enough to resume. */
function resumable(
  stateDir: string,
  want: Omit<Header, "startedAt">,
  now: number,
): { name: string; header: Header } | null {
  const dir = join(stateDir, "snapshots");
  if (!existsSync(dir)) return null;
  const stopped = readdirSync(dir)
    .filter((f) => f.endsWith(".details.jsonl") && !existsSync(join(dir, f.replace(".details.jsonl", ".json"))))
    .sort()
    .reverse();
  for (const f of stopped) {
    const first = readFileSync(join(dir, f), "utf8").split("\n", 1)[0];
    let header: Header;
    try {
      header = JSON.parse(first);
    } catch {
      continue;
    }
    const { startedAt, ...same } = header;
    if (JSON.stringify(same) !== JSON.stringify(want) || now - Date.parse(startedAt) > RESUME_MS) continue;
    return { name: f.replace(".details.jsonl", ""), header };
  }
  return null;
}

export async function pull(
  stateDir: string,
  runDir?: string,
  { all = false, client = new McpClient(stateDir) as Client, now = Date.now() } = {},
): Promise<string> {
  const config = loadConfig(stateDir);
  const run = runDir ? readRun(runDir, extraDirsOf(stateDir, config)) : null;
  const txids = run ? categorisedTxids(run.rows, config) : null;
  const range = run && !all ? rangeOf(run.files, config.timezone) : null;
  const want = { run: runDir ? resolve(runDir) : null, range, managedSources: config.managedSources };

  // A stopped pull goes on from what it read; otherwise a new one starts
  mkdirSync(join(stateDir, "snapshots"), { recursive: true });
  const earlier = resumable(stateDir, want, now);
  const startedAt = earlier?.header.startedAt ?? new Date(now).toISOString();
  const name = earlier?.name ?? startedAt.slice(0, 19).replace(/:/g, "-");
  const file = join(stateDir, "snapshots", `${name}.json`);
  const details = detailsFile(file);
  if (!earlier) appendFileSync(details, JSON.stringify({ startedAt, ...want }) + "\n");
  else if (!readFileSync(details, "utf8").endsWith("\n")) appendFileSync(details, "\n");
  const read = new Set(readDetails(details).keys());
  if (earlier) console.log(`Resuming the pull of ${startedAt}: ${read.size} actions read so far`);
  console.log(range ? `Range: ${range.from} to ${range.to}, with a day's margin` : "Range: the whole history");
  await client.connect();

  let previous: string | null = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`Round ${round}: listing every action (including ignored, spam and dust)`);
    const pages = await queryAll(client, inRange(range));
    const actions = pages.flatMap(parseActions);
    const total = parsePageHeader(pages[0]).total;
    const unique = new Set(actions.map((a) => a["Action ID"])).size;
    console.log(`  ${actions.length} actions parsed, ${unique} unique, server reported ${total}`);

    // An action Summ rebuilt while the list was paged appears under its new id only in the source query
    const listed = new Set(actions.map((a) => a["Action ID"]));
    const late: ListedAction[] = [];
    const needed = new Set<string>();
    for (const source of config.managedSources) {
      console.log(`  Source "${source}"`);
      const sourceActions = (await queryAll(client, inRange(range, { type: "source", value: [source] }))).flatMap(
        parseActions,
      );
      for (const a of sourceActions) {
        needed.add(a["Action ID"] as string);
        if (listed.has(a["Action ID"])) continue;
        listed.add(a["Action ID"]);
        late.push(a);
      }
    }
    if (txids) for (const id of actionsWithTxids(actions, txids)) needed.add(id);

    const todo = [...needed].filter((id) => !read.has(id));
    console.log(`  ${needed.size} details needed, ${todo.length} to read`);
    let gone = 0;
    for (const [i, actionId] of todo.entries()) {
      let text: string;
      try {
        text = await client.callTool("inspect_transaction", { actionId });
      } catch (e) {
        // Rebuilt since it was listed: the next round lists its new id
        if (!/was not found/.test((e as Error).message)) throw e;
        gone++;
        continue;
      }
      appendFileSync(
        details,
        JSON.stringify({ a: actionId, at: new Date().toISOString(), ...parseDetail(text) }) + "\n",
      );
      read.add(actionId);
      process.stdout.write(`\r  ${i + 1}/${todo.length}   `);
    }
    if (todo.length) process.stdout.write("\n");

    // Settled: nothing left to read, and the list is what the last round saw
    const seen = JSON.stringify([[...listed].sort(), [...needed].sort()]);
    const settled = todo.length === 0 && gone === 0 && seen === previous && unique === total && late.length === 0;
    previous = seen;
    if (!settled) continue;

    const stored = readDetails(details);
    const owner = new Map<string, string>();
    for (const id of needed) {
      for (const leg of legsOf(stored.get(id) as never)) {
        const other = owner.get(leg.legId);
        if (other && other !== id)
          throw new Error(
            `Leg ${leg.legId} is in actions ${other} and ${id}: Summ changed while it was read. No snapshot written; pull again to go on.`,
          );
        owner.set(leg.legId, id);
      }
    }
    writeSnapshot(file, {
      version: 2,
      takenAt: startedAt,
      finishedAt: new Date().toISOString(),
      total,
      parsed: actions.length,
      unique,
      managedSources: config.managedSources,
      run: want.run,
      range,
      rounds: round,
      details: needed.size,
      actions: actions.map((a) => ({
        ...snapshotEntry(a),
        ...(needed.has(a["Action ID"] as string) ? { detail: true as const } : {}),
      })),
    });
    console.log(`Snapshot written to ${file}`);
    return file;
  }
  throw new Error(
    `Summ's list kept changing over ${MAX_ROUNDS} rounds (a recalculation or an import running?). No snapshot written; what was read is kept, and pull goes on from it.`,
  );
}
