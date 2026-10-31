// The journal of an apply: what makes each write to Summ recorded and reversible (spec: docs/specs/summ-sync.md, Apply).
//
//   <state dir>/apply-log.jsonl                     appended and fsynced line by line
//   <plan dir>/pre/<entry>.<step>.json              the state read just before a write, durable before its intent line
//
// A crash then leaves, at worst, a pre-image with no line (the write was not made) or an intent with no result
// (the write may have been made).

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ActionDetail } from "./parse.ts";
import { parseWalletFile } from "./run.ts";

function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
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
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDir(dirname(file));
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
    fsyncSync(fd);
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
