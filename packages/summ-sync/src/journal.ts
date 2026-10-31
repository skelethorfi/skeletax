// The journal of an apply: what makes each write to Summ recorded and reversible (spec: docs/specs/summ-sync.md, Apply).
//
//   <state dir>/apply-log.jsonl                     appended and fsynced line by line
//   <plan dir>/pre/<entry>.<step>.json              the state read just before a write, durable before its intent line
//
// A crash then leaves, at worst, a pre-image with no line (the write was not made), an intent with no result (the
// write may have been made), or a last line cut off. <state dir>/.lock keeps a second apply out.

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ActionDetail } from "./parse.ts";
import { parseWalletFile } from "./run.ts";

/** How files reach the disk. Only a test that runs thousands of applies replaces it. */
export const durability = { sync: fsyncSync };

function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    durability.sync(fd);
  } finally {
    closeSync(fd);
  }
}

/** One log line, on disk when this returns. */
export function appendLogLine(file: string, line: object): void {
  const created = !existsSync(file);
  const fd = openSync(file, "a");
  try {
    writeFileSync(fd, JSON.stringify(line) + "\n");
    durability.sync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDir(dirname(file));
}

/** The log's lines that are not writes to Summ. Any other line counts as one, as does `error` in older logs. */
const NOT_WRITES = new Set(["skip", "found", "apply-start", "apply-stop", "torn-line"]);

export const isWriteLine = (line: { call?: unknown }): boolean => !NOT_WRITES.has(String(line.call));

/**
 * The log's lines, or none when there is no log. A last line with no newline was cut off by a stop, and is left out
 * if it does not parse; a bad line anywhere else is not something a stop leaves, so it stops the reader.
 */
export function readLogLines<T = Record<string, unknown>>(stateDir: string): T[] {
  const file = join(stateDir, "apply-log.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const parsed: T[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch (e) {
      if (i === lines.length - 1) continue;
      throw new Error(`${file}: line ${i + 1} is not JSON (${(e as Error).message}); only a last line can be cut off`, {
        cause: e,
      });
    }
  }
  return parsed;
}

/**
 * Makes a cut-off last line safe to append after: the fragment moves to a `torn-line` line of its own, keeping what it
 * says. A complete last line that only lost its newline gets it back.
 */
export function repairLog(file: string, time: string, plan: string): void {
  if (!existsSync(file)) return;
  const bytes = readFileSync(file);
  if (!bytes.length || bytes[bytes.length - 1] === 0x0a) return;
  const start = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(start).toString("utf8");
  let whole = true;
  try {
    JSON.parse(tail);
  } catch {
    whole = false;
  }
  const fd = openSync(file, "a");
  try {
    if (whole) writeFileSync(fd, "\n");
    else ftruncateSync(fd, start);
    durability.sync(fd);
  } finally {
    closeSync(fd);
  }
  if (whole) return;
  appendLogLine(file, { time, plan, call: "torn-line", text: tail });
}

const lockFile = (stateDir: string) => join(stateDir, ".lock");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Keeps a second apply out, by an exclusive create. A lock whose process is dead, or with no pid, is cleared. */
export function takeLock(stateDir: string, isAlive: (pid: number) => boolean = pidAlive): void {
  const file = lockFile(stateDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8"));
      if (pid > 0 && isAlive(pid))
        throw new Error(`Another apply is running (pid ${pid}, ${file}). If it is not, remove that file.`, {
          cause: e,
        });
      unlinkSync(file);
      continue;
    }
    try {
      writeFileSync(fd, `${process.pid}\n`);
      durability.sync(fd);
    } finally {
      closeSync(fd);
    }
    return;
  }
  throw new Error(`Could not take ${file}: another apply may be starting`);
}

export function releaseLock(stateDir: string): void {
  rmSync(lockFile(stateDir), { force: true });
}

/** A row's exact line in a CSV file, to upload it again. */
export interface RowLine {
  line: string;
  lineHeader: string;
  /** `run:<file>` or `upload:<file>`. */
  lineSource: string;
}

export interface PreImage {
  plan: string;
  entry: string;
  step: string;
  id: string | null;
  capturedAt: string;
  /** The action the write addresses, with its change history, as just read. Not an action Summ pairs a leg into. */
  actions: ActionDetail[];
  /** A delete only: the row's line, null when neither the run nor the plan's upload files hold it. */
  line?: string | null;
  lineHeader?: string | null;
  lineSource?: string | null;
}

/**
 * Writes a pre-image whole and durably; returns the file. Always writes what was just read, and never replaces a file:
 * one already there was read before an earlier attempt, and may be the only record of the state before it.
 */
export function writePreImage(planDir: string, image: PreImage): string {
  const dir = join(planDir, "pre");
  mkdirSync(dir, { recursive: true });
  const stem = `${image.entry}.${image.step}`;
  let file = join(dir, `${stem}.json`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}.${n}.json`);
  const fd = openSync(`${file}.tmp`, "w");
  try {
    writeFileSync(fd, JSON.stringify(image, null, 2) + "\n");
    durability.sync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${file}.tmp`, file);
  fsyncDir(dir);
  fsyncDir(dirname(dir));
  return file;
}

/** A pre-image's path as the log names it: relative to the state dir, so the state dir can move. */
export const logPath = (stateDir: string, file: string): string => relative(stateDir, file);

/**
 * Every row's line in the run's wallet files, then in the plan's upload files, by ID. Nothing here stops an apply:
 * a run that has moved or a file that does not parse just finds no line. A remade row's line is the run's version,
 * which can differ from what Summ held; the pre-image's action is the record of that.
 */
export function rowLines(runDir: string, planDir: string): Map<string, RowLine> {
  const lines = new Map<string, RowLine>();
  const add = (dir: string, source: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      try {
        const { file, rows } = parseWalletFile(name, readFileSync(join(dir, name), "utf8"));
        for (const row of rows)
          if (!lines.has(row.id))
            lines.set(row.id, { line: row.line, lineHeader: file.header, lineSource: `${source}:${name}` });
      } catch {
        // Not a wallet file (all.csv), or one that does not parse
      }
    }
  };
  add(join(runDir, "csv"), "run");
  add(join(planDir, "upload"), "upload");
  return lines;
}
