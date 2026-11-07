import fs from "fs-extra";
import path from "path";

// What a run was cut with, for tools that read the run folder (summ-sync): written to its folder as run.json
// (docs/specs/periods.md). Version 1 holds the timezone the periods' days are in.

export const RUN_FILE = "run.json";

export interface RunInfo {
  version: 1;
  // IANA name; the config's timezone, or UTC when it sets none
  timezone: string;
}

export function writeRunInfo(outputPath: string, timezone: string | undefined): void {
  const info: RunInfo = { version: 1, timezone: timezone ?? "UTC" };
  fs.outputJsonSync(path.join(outputPath, RUN_FILE), info, { spaces: 2 });
}
