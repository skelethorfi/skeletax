import * as path from "path";
import { format } from "date-fns-tz";
import { Exporter, NOT_FETCHED_FILE } from "./cli/Exporter.ts";
import { oldCacheHint } from "./cli/store.ts";
import { SUMMARY_FILE } from "./cli/RunSummary.ts";
import { parseExportArgs, printError, USAGE } from "./cli/args.ts";
import { writeRunInfo } from "./cli/RunInfo.ts";

async function main(argv: string[]): Promise<number> {
  const { help, configFile, offline, fetch, replay } = parseExportArgs(argv);

  if (help) {
    console.log(USAGE);
    return 0;
  }

  console.log(`Current directory: ${process.cwd()}`);

  // By default a run fetches every wallet's history again (new activity, changed records) and records still
  // pending; anything stored before is kept (docs/specs/snapshots.md). The flags are in USAGE (src/cli/args.ts).
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

  // Every wallet's rows are collected before saving, otherwise one wallet's TC swaps could overwrite another.
  // A wallet a source failed for is skipped; the others go on (docs/specs/run-summary.md, Not fetched)
  const bundles = await exporter.collectBundles();
  exporter.writeNotFetched(outputPath);
  const rows = exporter.getRows(await exporter.withPrices(bundles), outputPath);
  exporter.saveToCsv(rows, path.join(outputPath, "csv"));

  // Before the snapshot is written, so it lists the balances the check read
  await exporter.checkBalances(rows);

  // The timezone the periods were cut in, which summ-sync checks against its own
  writeRunInfo(outputPath, exporter.config.timezone);

  // Which snapshot of each source this run used, for --replay
  exporter.snapshots.write(outputPath).forEach((line) => report.info(line));

  // Last, so they are seen
  exporter.endWarnings.forEach((line) => report.warn(line));
  report.write(outputPath);
  console.log(`Summary: ${path.join(outputPath, SUMMARY_FILE)}`);

  if (exporter.notFetched.length > 0) {
    const count = exporter.notFetched.length;
    console.error(
      `\n${count} wallet${count === 1 ? "" : "s"} not fetched: ${exporter.notFetched.map(({ wallet }) => wallet.name).join(", ")}. ` +
        `Their rows are not in this run's CSV files, and summ-sync refuses the run (${NOT_FETCHED_FILE}). ` +
        `See summary.md, Not fetched; ${offline ? "run again without --offline to fetch what the store lacks" : "run again once the source answers"}.`,
    );
    return 1;
  }

  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => process.exit(printError(error)),
);
