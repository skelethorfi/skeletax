import fs from "fs-extra";
import path from "path";

// What a run printed that is worth keeping, written to its folder as summary.md (docs/specs/run-summary.md).
// Each line is printed as before and kept for the file.

export const SUMMARY_FILE = "summary.md";

export type IssueSection = "manual" | "warning" | "notFinal" | "unsupported" | "failed";

const ISSUE_HEADINGS: { [section in IssueSection]: string } = {
  manual: "Enter by hand",
  warning: "Action warnings",
  notFinal: "Not final (status not success)",
  unsupported: "Unsupported actions (saved in unsupported/)",
  failed: "Failed actions (saved in failures/ with their error)",
};

export class RunSummary {
  readonly run: string[] = [];
  readonly counts: string[] = [];
  readonly warnings: string[] = [];
  readonly notFetched: string[] = [];
  // The balance check's findings (docs/specs/run-summary.md, Balance check)
  readonly balances: string[] = [];
  readonly issues: { [section in IssueSection]: string[] } = {
    manual: [],
    warning: [],
    notFinal: [],
    unsupported: [],
    failed: [],
  };

  // How the run ran (config, mode, period)
  about(line: string) {
    this.run.push(line);
  }

  // A count or result, e.g. rows exported
  info(line: string) {
    console.log(line);
    this.counts.push(line);
  }

  // A warning about the whole run, e.g. a config key no longer used or a wallet missing from the config
  warn(line: string) {
    console.warn(line);
    this.warnings.push(line);
  }

  // A wallet the run could not fetch, so none of its rows were written (docs/specs/run-summary.md, Not fetched)
  notFetchedWallet(line: string) {
    console.error(line);
    this.notFetched.push(line);
  }

  // A difference the balance check found, or a wallet it could not check
  balance(line: string) {
    console.warn(line);
    this.balances.push(line);
  }

  // One action's issue: printed as before, and kept with the action's record key (e.g. midgard/swap.<txid>), so
  // the file says which action it was
  issue(section: IssueSection, line: string, key: string) {
    (section === "unsupported" || section === "failed" ? console.error : console.warn)(line);
    this.issues[section].push(`${line} (${key})`);
  }

  write(outputPath: string) {
    fs.outputFileSync(path.join(outputPath, SUMMARY_FILE), renderSummary(this));
  }
}

export function renderSummary(summary: RunSummary): string {
  const list = (lines: string[]) => lines.map((line) => `- ${line.replaceAll("\n", " ")}`);
  // Sections of warnings and issues give their count in the heading; an empty one is left out
  const section = (heading: string, lines: string[], counted = true) =>
    lines.length ? ["", `## ${heading}${counted ? ` (${lines.length})` : ""}`, "", ...list(lines)] : [];

  return [
    "# Run summary",
    ...section("Run", summary.run, false),
    ...section("Not fetched (no rows or CSV files for these wallets)", summary.notFetched),
    ...section("Counts", summary.counts, false),
    ...section("Warnings", summary.warnings),
    ...section("Balance check", summary.balances),
    ...(Object.keys(ISSUE_HEADINGS) as IssueSection[]).flatMap((key) =>
      section(ISSUE_HEADINGS[key], summary.issues[key]),
    ),
    "",
  ].join("\n");
}
