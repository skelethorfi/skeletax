import * as path from "path";
import { format } from "date-fns-tz";
import { Exporter } from "./cli/Exporter.ts";
import { oldCacheHint } from "./cli/store.ts";
import { SUMMARY_FILE } from "./cli/RunSummary.ts";

async function main() {
  console.log(`Current directory: ${process.cwd()}`);

  const args = process.argv.slice(2);

  // --offline: only use what is stored, fail on anything not stored
  const offline = args.includes("--offline");
  // By default a run fetches every wallet's history again (new activity, changed records) and records still
  // pending; anything stored before is kept (docs/specs/snapshots.md). --refetch-all also fetches every
  // finalised record again, e.g. to see what was revised or pruned before filing.
  const fetch = args.includes("--refetch-all") ? "all" : undefined;
  // --replay <run folder>: read exactly the snapshots that run used
  const replayIndex = args.indexOf("--replay");
  const replay = replayIndex >= 0 ? args[replayIndex + 1] : undefined;

  if (replayIndex >= 0 && !replay) {
    throw new Error("--replay needs a run folder");
  }

  // Get the last non-flag argument as the config filename
  const configFile = args.filter((arg) => !arg.startsWith("--") && arg !== replay).pop() ?? "";

  if (!configFile.endsWith(".json") && !configFile.endsWith(".toml")) {
    throw new Error("must specify config file");
  }

  const now = new Date();
  const timestamp = format(now, "yyyy-MM-dd_HH-mm-ss");

  // Read config
  const exporter = new Exporter(configFile, { offline, fetch, replay, today: now });

  const outputPath = path.join(exporter.config.outputPath, timestamp);
  const storePath = exporter.config.storePath;

  const importCommand = replay ? undefined : oldCacheHint(storePath, path.dirname(path.resolve(configFile)));

  const report = exporter.report;
  report.about(`Config: ${path.resolve(configFile)}`);
  report.about(`Started: ${now.toISOString()}`);
  report.about(
    `Period: ${exporter.config.fromDate} to ${exporter.config.toDate} (${exporter.config.timezone ?? "UTC"}), ${exporter.config.frequency}`,
  );
  report.about(`Protocols: ${(exporter.config.protocols ?? ["thorchain"]).join(", ")}`);
  report.about(
    `Mode: ${replay ? `replay of ${path.resolve(replay)}` : offline ? "offline" : fetch === "all" ? "refetch all" : "fetch the latest data"}; store ${storePath}`,
  );

  if (importCommand) {
    report.warn(
      `Found a cache from before the store, which runs no longer read. To keep what it holds, stop and import it first:\n  ${importCommand}\n`,
    );
  }

  if (replay) {
    console.log(`Replay: reading the records of ${replay} from ${storePath}\n`);
  } else if (offline) {
    console.log(`Offline: reading only from the store: ${storePath}\n`);
  } else {
    console.log(
      `Fetching ${fetch === "all" ? "every record" : "the latest data"}; earlier copies in ${storePath} are kept\n`,
    );
  }

  // Every wallet's rows are collected before saving, otherwise one wallet's TC swaps could overwrite another
  exporter.saveToCsv(
    exporter.getRows(await exporter.withPrices(await exporter.collectBundles()), outputPath),
    path.join(outputPath, "csv"),
  );

  // Which snapshot of each source this run used, for --replay
  exporter.snapshots.write(outputPath).forEach((line) => report.info(line));

  // Last, so they are seen
  exporter.endWarnings.forEach((line) => report.warn(line));
  report.write(outputPath);
  console.log(`Summary: ${path.join(outputPath, SUMMARY_FILE)}`);
}

main().then(() => {
  process.exit(0);
});
