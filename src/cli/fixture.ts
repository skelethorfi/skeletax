import fs from "fs-extra";
import os from "os";
import path from "path";
import { type Action, Configuration, DefaultApi } from "@xchainjs/xchain-midgard";
import { ThornodeService } from "../sources/thorchain/ThornodeService.ts";
import { RecordStore } from "../sources/store/RecordStore.ts";
import { MayanodeService } from "../sources/maya/MayanodeService.ts";
import { CosmosTxService } from "../sources/thorchain/CosmosTxService.ts";
import { EvmReceipts } from "../sources/evm/EvmReceipts.ts";
import { TcyClaimService } from "../sources/tcy/TcyClaimService.ts";
import { Viewblock } from "../sources/viewblock/index.ts";
import { MidgardService } from "../sources/thorchain/MidgardService.ts";
import { MidgardSource } from "../sources/Source.ts";
import { http } from "../sources/http.ts";
import { execFileSync } from "child_process";
import { Anonymiser, findSurvivors, getTokens } from "../fixtures/Anonymise.ts";
import {
  ACTIVITY_FILE,
  EXPECTED_FILE,
  formatRows,
  type GoldenCaseInput,
  INPUT_FILE,
  readCaseInput,
  runCaseLayers,
  toCaseInput,
  toPlainActivity,
  writeCaseActivities,
  writeCaseExpected,
} from "../fixtures/GoldenCase.ts";
import { getPrivateDir, mask, PrivateData } from "../fixtures/PrivateData.ts";
import { describeShape, getActionIds, getActionShape, sameShape } from "../fixtures/Shape.ts";
import { getProtocol, type Protocol } from "../domain/Protocol.ts";

// Workflow for adding a golden test case without leaking private data:
//
// Set TCT_PRIVATE_DIR to a folder outside the repo holding your own configs and caches,
// so the tool can refuse to write cases containing your addresses or txids.
//
//   fetch <txid>                 save a (possibly private) tx into the private folder (or --out)
//   similar <input.json>         find public txs with the same shape
//   add <txid> <group/name>      fetch a public tx into test/cases (refuses private data)
//   anonymise <input.json> <group/name>   fallback: anonymised copy of a private tx
//   show <case-dir> [--write]    print the mapped rows; --write saves expected.yaml after review
//
// fetch, similar and add take --protocol maya for Maya Protocol txs (default thorchain).

const REPO_DIR = path.resolve(import.meta.dirname, "../..");

// Written next to an anonymised case. The owner's pre-commit hook blocks committing anything in the case's
// folder while it exists, and CI fails on it: a fresh reviewer deletes it once the case is checked.
const REVIEW_MARKER = "TO-REVIEW.md";
const REVIEW_CHECKLIST = `# To review: anonymised case

This case was anonymised from a private transaction. Before it is committed, a fresh reviewer (a
new agent, or the owner) checks it, reporting only counts, field names and shapes, never private values:

1. No token of the original survives (\`npm run fixture -- anonymise\` already refuses if one does).
2. No number or name in the case appears in the private store or private-denylist.txt.
3. Nothing else narrows the search on-chain: asset pair, action or contract type, memo layout, output
   count, anything unusual.
4. The case maps to the same row types as the original.
5. No test value written alongside it comes from the private transaction.

Delete this file once the review finds nothing (or after fixing what it found).
`;
const CASES_DIR = path.join(REPO_DIR, "test/cases");

// Tokens already public: in the repo's tracked code, docs and tests
function getPublicTokens(): Set<string> {
  const files = execFileSync("git", ["ls-files", "src", "docs", "test"], { cwd: REPO_DIR, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const tokens = new Set<string>();
  files.forEach((file) => getTokens(fs.readFileSync(path.join(REPO_DIR, file), "utf8"), tokens));
  return tokens;
}
const midgardFor = (protocol: Protocol) =>
  new DefaultApi(new Configuration({ basePath: protocol.midgardUrl }), protocol.midgardUrl, http);

async function fetchInput(txid: string, protocol: Protocol, index?: number): Promise<GoldenCaseInput> {
  const response = await midgardFor(protocol).getActions(undefined, txid);
  const actions = response.data.actions;

  if (actions.length === 0) {
    throw new Error(`no Midgard action for txid ${mask(txid)}`);
  }

  if (actions.length > 1 && index === undefined) {
    actions.forEach((action, i) => console.error(`  [${i}] ${describeShape(getActionShape(action))}`));
    throw new Error(`${actions.length} actions for this txid; choose one with --index`);
  }

  const action = actions[index ?? 0];
  // The exporter's bundle builder; related txs go to a throwaway store, as the tx may be anyone's
  const store = new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-fixture-")));
  const source = new MidgardSource(
    protocol,
    new MidgardService(store, `${protocol.id}-midgard`, protocol.midgardUrl),
    new ThornodeService(store),
    new CosmosTxService(store),
    [],
    undefined,
    protocol.nodeUrl ? new MayanodeService(store, protocol.nodeUrl) : undefined,
    { viewblock: new Viewblock(store), evm: new EvmReceipts(store) },
    new TcyClaimService(store),
  );
  const bundle = await source.bundle(action, action.in[0]?.address ?? "");

  return toCaseInput(bundle, describeShape(getActionShape(action)));
}

async function findSimilar(input: GoldenCaseInput, maxPages: number, privateData: PrivateData): Promise<Action[]> {
  const midgard = midgardFor(getProtocol(input.protocol));
  const target = input.data as Action;
  const shape = getActionShape(target);
  const asset = shape.inAssets[0]?.[0];
  const matches: Action[] = [];
  // Search backwards from the original tx's block, so the API format is from the same era.
  // (Querying by height is fast; by timestamp it times out on the Liquify gateway.)
  let nextPageToken: number | undefined;
  const height = Number(target.height);

  for (let page = 0; page < maxPages && matches.length < 5; page++) {
    const response = await midgard.getActions(
      undefined,
      undefined,
      shape.type === "contract" ? undefined : asset,
      shape.type,
      undefined,
      undefined,
      50,
      undefined,
      nextPageToken,
      undefined,
      nextPageToken ? undefined : height,
    );

    for (const action of response.data.actions) {
      const isPrivate = getActionIds(action).some((id) => privateData.isPrivate(id));

      if (!isPrivate && sameShape(getActionShape(action), shape)) {
        matches.push(action);
      }
    }

    nextPageToken = Number(response.data.meta.nextPageToken) || undefined;

    if (!nextPageToken) {
      break;
    }
  }

  return matches;
}

function assertNoPrivateData(input: GoldenCaseInput, privateData: PrivateData) {
  const found = privateData.findIn(JSON.stringify(input));

  if (found.length > 0) {
    found.forEach((value) => console.error(`  private: ${mask(value)}`));
    throw new Error("refusing to write a test case containing private data");
  }
}

function writeCase(name: string, input: GoldenCaseInput) {
  const dir = path.join(CASES_DIR, name);

  if (fs.existsSync(path.join(dir, INPUT_FILE))) {
    throw new Error(`case already exists: ${path.relative(process.cwd(), dir)}`);
  }

  fs.outputJsonSync(path.join(dir, INPUT_FILE), input, { spaces: 2 });
  console.log(`Wrote ${path.relative(process.cwd(), path.join(dir, INPUT_FILE))}`);
  show(dir, false);
}

function show(dir: string, write: boolean) {
  const { activities, rows } = runCaseLayers(readCaseInput(dir));

  if (activities.length) {
    console.log(`# ${ACTIVITY_FILE}\n${formatRows(activities.map(toPlainActivity))}\n# ${EXPECTED_FILE}`);
  }

  console.log(formatRows(rows));

  if (write) {
    if (activities.length) {
      writeCaseActivities(dir, activities);
      console.log(`Wrote ${path.relative(process.cwd(), path.join(dir, ACTIVITY_FILE))}`);
    }

    writeCaseExpected(dir, rows);
    console.log(`Wrote ${path.relative(process.cwd(), path.join(dir, EXPECTED_FILE))}`);
  } else {
    console.log(
      `\nReview ${activities.length ? "the activities and " : ""}these rows against the spec. If they are right: npm run fixture -- show ${path.relative(process.cwd(), dir)} --write`,
    );
  }
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const positional = args.filter(
    (arg, i) => !arg.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--write"),
  );
  const index = getFlag(args, "--index");
  const protocol = getProtocol(getFlag(args, "--protocol"));
  const privateData = PrivateData.load();

  if (["add", "anonymise", "similar"].includes(command) && !getPrivateDir()) {
    console.error("Warning: TCT_PRIVATE_DIR is not set, so cases are not checked for your own addresses and txids.");
  }

  switch (command) {
    case "fetch": {
      const [txid] = positional;
      const input = await fetchInput(txid, protocol, index === undefined ? undefined : Number(index));
      const privateDir = getPrivateDir();
      const out = getFlag(args, "--out") ?? (privateDir && path.join(privateDir, "fixtures", txid, INPUT_FILE));

      if (!out) {
        throw new Error(
          "set TCT_PRIVATE_DIR or pass --out <file>; fetched txs may be private, so they are not written into the repo",
        );
      }

      fs.outputJsonSync(out, input, { spaces: 2 });
      console.log(`${input.description}\nWrote ${out}`);
      break;
    }
    case "similar": {
      const [file] = positional;
      const input: GoldenCaseInput = fs.readJSONSync(file);
      console.log(`Looking for: ${describeShape(getActionShape(input.data as Action))}`);
      const matches = await findSimilar(input, Number(getFlag(args, "--pages") ?? 10), privateData);

      for (const action of matches) {
        console.log(`${new Date(Number(BigInt(action.date) / 1_000_000n)).toISOString()} ${action.in[0]?.txID}`);
      }

      if (matches.length === 0) {
        console.log("No public tx with the same shape found. Try --pages, or use anonymise.");
      }
      break;
    }
    case "add": {
      const [txid, name] = positional;

      if (privateData.isPrivate(txid)) {
        throw new Error("that txid is private; use similar or anonymise");
      }

      const input = await fetchInput(txid, protocol, index === undefined ? undefined : Number(index));
      assertNoPrivateData(input, privateData);
      writeCase(name, input);
      break;
    }
    case "anonymise": {
      const [file, name] = positional;
      const original: GoldenCaseInput = fs.readJSONSync(file);
      const input: GoldenCaseInput = new Anonymiser().anonymise(original);
      input.description = `${input.description} (anonymised)`;
      assertNoPrivateData(input, privateData);

      // Anything of the original that is still there and not already public could identify it
      const survivors = findSurvivors(original, input, getPublicTokens());

      if (survivors.length > 0) {
        survivors.forEach((token) => console.error(`  kept: ${mask(token)}`));
        throw new Error(
          `refusing to write: ${survivors.length} values of the original survive anonymising; extend src/fixtures/Anonymise.ts or edit the case by hand`,
        );
      }

      fs.outputFileSync(path.join(CASES_DIR, name, REVIEW_MARKER), REVIEW_CHECKLIST);
      console.log(
        `Wrote ${path.relative(process.cwd(), path.join(CASES_DIR, name, REVIEW_MARKER))}: the case can't be committed until a fresh review deletes it`,
      );

      writeCase(name, input);
      break;
    }
    case "show": {
      const [dir] = positional;
      show(path.resolve(dir), args.includes("--write"));
      break;
    }
    default:
      console.log("usage: npm run fixture -- <fetch|similar|add|anonymise|show> ...  (see src/fixtures/cli.ts)");
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
