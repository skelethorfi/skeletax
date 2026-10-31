// The plan command: reads the run, the latest snapshot and the state tables, and writes
//
//   <state dir>/plans/<timestamp>/plan.json        the plan (input to apply)
//   <state dir>/plans/<timestamp>/plan.md          the same, for review
//   <state dir>/plans/<timestamp>/upload/<file>    per CSV file, the rows Summ lacks, for the user to upload
//
// It writes nothing else: apply adds what the plan adopted and captured to adopted.csv and overrides.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extraDirsOf, loadConfig } from "./config.ts";
import { type Change, makePlan, type EditEntry, parseScope, type Plan, type ValueMatch } from "./plan.ts";
import { parseCsvLine, readRun, type Row, type RunFile } from "./run.ts";
import { latestSnapshot, type PullRange, readSnapshot, readSnapshotFile } from "./snapshot.ts";
import { readAdopted, readApplyLog, readLeftLegs, readOverrides } from "./state.ts";

const show = (v: unknown) => (v === null || v === "" || v === undefined ? "–" : String(v));
const cell = (v: unknown) => show(v).replaceAll("|", "\\|");

/** A two-leg price edit, as one entry: what each leg gets. */
function matchLines(entries: EditEntry[]): string[] {
  const two = entries.filter((e) => e.match);
  if (!two.length) return [];
  return [
    "",
    "Sells whose quote Summ cannot price, each one entry in two edits: the sell, then the buy from the sell's value as Summ then shows it, so both sides hold the same value:",
    "",
    "| Row | Sell leg | Sell gets | Buy leg | Buy holds | Buy gets |",
    "| --- | --- | --- | --- | --- | --- |",
    ...two.map((e) => {
      const m = e.match as ValueMatch;
      const price = e.changes.find((c) => c.field === "price" && c.legId === m.baseLegId);
      return `| ${e.id} | \`${m.baseLegId}\` | ${price ? `US$${price.desired}` : "keeps its price"} | \`${m.legId}\` | ${show(m.summ)} | ${m.desired === null ? "sell value / buy amount (local)" : `${m.desired} (local)`} |`;
    }),
  ];
}

function changeLines(entries: EditEntry[]): string[] {
  return entries.flatMap((e) => [
    ...e.changes.map(
      (c: Change) => `| ${e.id} | ${c.leg} \`${c.legId}\` | ${c.field} | ${cell(c.summ)} | ${cell(c.desired)} |`,
    ),
    ...(e.ignore ?? []).map((legId) => `| ${e.id} | made-up leg \`${legId}\` | – | transfer | ignored |`),
  ]);
}

function section<T extends { filed: boolean }>(
  title: string,
  entries: T[],
  render: (entries: T[]) => string[],
): string[] {
  const out = [`## ${title} (${entries.length})`, ""];
  for (const [label, part] of [
    ["", entries.filter((e) => !e.filed)],
    ["### Amendments (filed years): apply only with --approve-filed", entries.filter((e) => e.filed)],
  ] as const) {
    if (part.length === 0) continue;
    if (label) out.push(label, "");
    out.push(...render(part as T[]), "");
  }
  if (entries.length === 0) out.push("None.", "");
  return out;
}

/** Where a file on an unmanaged chain goes: its rows have no tx of that chain (PROTOCOL_TYPES), so not into its wallet. */
function uploadNote(plan: Plan, file: string): string {
  const chain = file.split("_")[2];
  return plan.managedChains.includes(chain)
    ? ""
    : ` (into the THORChain or Maya account, not the ${chain} wallet: no ${chain} tx of their own)`;
}

export function renderPlan(plan: Plan, snapshot: string, run: string, legs: Map<string, number> = new Map()): string {
  const hasPrice = (e: EditEntry) => e.changes.some((c) => c.field === "price");
  const unpriced = (es: EditEntry[]) =>
    es
      .map((e) => ({ ...e, changes: e.changes.filter((c) => c.field !== "price") }))
      .filter((e) => e.changes.length || e.ignore?.length);
  const withoutPrices = unpriced(plan.edit);
  const withPrices = [
    ...plan.edit.filter((e) => hasPrice(e) || e.match),
    // An import's leg: categorised in the same edit, and listed with the prices
    ...plan.categorise.filter(hasPrice).map((e) => ({ ...e, id: `${e.id} (Summ's import)` })),
  ];
  const lines = [
    "# Summ sync plan",
    "",
    `- Created: ${plan.createdAt}`,
    `- Snapshot: ${snapshot}`,
    `- Run: ${run}`,
    `- Periods: ${plan.periods.map((p) => `${p.from} to ${p.to}`).join(", ")} (${plan.timezone})`,
    `- Managed chains: ${plan.managedChains.join(", ")}; sources: ${plan.managedSources.join(", ") || "–"}; filed before: ${show(plan.filedBefore)}`,
    ...(plan.scope
      ? [
          `- Scope (plan --only): only the rows these entries match, and nothing else of the run: ${plan.scope.map((e) => `\`${e}\``).join(", ")}`,
          "- Counts of the run's rows, legs and matches cover the whole run; adoptions and the sections cover the scope",
        ]
      : []),
    "",
    "## Counts",
    "",
    ...Object.entries(plan.counts).map(([k, v]) => `- ${k}: ${v}`),
    ...plan.notes.map((n) => `- Note: ${n}`),
    "",
    ...section(
      "Superseded extra rows (a run row is the same event; not uploaded, their legs adopt to it)",
      plan.superseded.map((e) => ({ ...e, filed: false })),
      (es) => ["| Extra row | Run row |", "| --- | --- |", ...es.map((e) => `| ${cell(e.extra)} | ${cell(e.run)} |`)],
    ),
    ...section("Delete (only with --approve-deletes)", plan.delete, (es) => [
      "| Row | ID in Summ | Legs | Other legs in the actions | Reason |",
      "| --- | --- | --- | --- | --- |",
      ...es.map(
        (e) => `| ${show(e.id)} | ${cell(e.summId)} | ${e.legIds.length} | ${e.otherLegs} | ${cell(e.reason)} |`,
      ),
    ]),
    ...section("Edit", withoutPrices, (es) => [
      "| Row | Leg | Field | Summ | Desired |",
      "| --- | --- | --- | --- | --- |",
      ...changeLines(es),
    ]),
    ...section("Edit: reference prices (Summ converts the USD price at its own rate)", withPrices, (es) =>
      [...priceLines(es, legs), ...matchLines(es)],
    ),
    ...section("Upload (files in upload/, uploaded by you)", plan.upload, (es) =>
      es.map((e) => `- ${e.file}: ${e.ids.length} rows${uploadNote(plan, e.file)}`),
    ),
    ...section("Categorise", unpriced(plan.categorise), (es) => [
      "| Row | Leg | Field | Summ | Desired |",
      "| --- | --- | --- | --- | --- |",
      ...changeLines(es),
    ]),
    ...section("Held (nothing planned: held in summ-sync.json, or the user's manual pairing; a price edit awaiting a test)", plan.held, (es) => [
      "| Kind | Row | Reason | Left out |",
      "| --- | --- | --- | --- |",
      ...es.map(
        (e) =>
          `| ${e.kind} | ${show(e.id ?? e.summId)} | ${cell(e.reason)} | ${cell(e.held.join("; ") || "nothing to do")} |`,
      ),
    ]),
    ...section("Report (for you to resolve)", plan.report, (es) => [
      "| Kind | Row | Legs | Detail |",
      "| --- | --- | --- | --- |",
      ...es.map((e) => `| ${e.kind} | ${show(e.id)} | ${(e.legIds ?? []).join(" ") || "–"} | ${cell(e.detail)} |`),
    ]),
    ...section(
      "Overridden (your values in Summ: kept unless retainUserEdit is no; undecided ones are listed until you decide)",
      plan.overridden.map((o) => ({ ...o, filed: false })),
      (es) => [
        "| Kind | Row | Leg | Field | Run | Yours | Run now |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...es.map(
          (o) =>
            `| ${o.kind} | ${o.override.id} | ${o.override.leg} | ${o.override.field} | ${cell(o.override.run)} | ${cell(o.override.summ)} | ${cell(o.runNow)} |`,
        ),
      ],
    ),
  ];
  return lines.join("\n");
}

/** The USD price of each row in the newest upload file holding it: a plan's file is what the user uploaded. */
export function uploadedPrices(stateDir: string): Map<string, number> {
  const prices = new Map<string, number>();
  const plans = join(stateDir, "plans");
  if (!existsSync(plans)) return prices;
  for (const name of readdirSync(plans).sort()) {
    const dir = join(plans, name, "upload");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".csv"))) {
      const [header, ...lines] = readFileSync(join(dir, file), "utf8").split(/\r?\n/).filter(Boolean);
      const names = parseCsvLine(header);
      const [id, price, currency] = [
        "ID (Optional)",
        "Reference Price Per Unit (Optional)",
        "Reference Price Currency (Optional)",
      ].map((c) => names.indexOf(c));
      if (id < 0 || price < 0 || currency < 0) continue;
      for (const line of lines) {
        const values = parseCsvLine(line);
        if (values[price] && values[currency] === "USD") prices.set(values[id], Number(values[price]));
        else prices.delete(values[id]);
      }
    }
  }
  return prices;
}

/** Price edits, largest first, those whose rate is furthest from the list's median at the head. */
export function priceLines(entries: EditEntry[], legs: Map<string, number>): string[] {
  const rows = entries.flatMap((e) =>
    e.changes
      .filter((c) => c.field === "price")
      .map((c) => {
        // Summ has no price of its own (0 or none) for some rows, e.g. LP tokens: no rate to read
        const rate = c.summ ? Number(c.summ) / Number(c.desired) : null;
        return { e, c, rate, value: (legs.get(c.legId) ?? 0) * Number(c.summ ?? 0) };
      }),
  );
  const rates = rows.flatMap((r) => (r.rate === null ? [] : [r.rate])).sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)] ?? 0;
  const line = (r: (typeof rows)[number]) =>
    `| ${r.e.id} | \`${r.c.legId}\` | ${r.value.toFixed(2)} | ${show(r.c.summ)} | ${show(r.c.desired)} | ${r.rate === null ? "–" : r.rate.toFixed(4)} |`;
  const table = [
    "| Row | Leg | Value in Summ | Summ price | USD price | Rate |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const furthest = rows
    .filter((r) => r.rate !== null)
    .sort((a, b) => Math.abs((b.rate as number) - median) - Math.abs((a.rate as number) - median))
    .slice(0, 10);
  return [
    `Median rate ${median.toFixed(4)}. Furthest from it:`,
    "",
    ...table,
    ...furthest.map(line),
    "",
    "All, largest value first:",
    "",
    ...table,
    ...[...rows].sort((a, b) => b.value - a.value).map(line),
  ];
}

/** Upload files: per CSV file (and filed or not), its header and the rows Summ lacks, in the file's order. */
export function uploadFiles(plan: Plan, files: RunFile[], rows: Row[]): { name: string; text: string }[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return plan.upload.map((u) => {
    const header = (files.find((f) => f.name === u.file) as RunFile).header;
    const name = u.filed ? u.file.replace(/\.csv$/, "_filed.csv") : u.file;
    return { name, text: [header, ...u.ids.map((id) => (byId.get(id) as Row).line)].join("\n") + "\n" };
  });
}

/** `only`: a scope file (plan --only), one entry per line (parseScope). */
export function writePlan(stateDir: string, runDir: string, only?: string): string {
  const config = loadConfig(stateDir);
  const scope = only === undefined ? undefined : parseScope(readFileSync(only, "utf8"));
  if (scope && scope.length === 0) throw new Error(`${only}: no scope entries`);
  const snapshotDir = latestSnapshot(stateDir);
  const snapshot = readSnapshot(snapshotDir);
  const { files, rows } = readRun(runDir, extraDirsOf(stateDir, config));
  const pulled = readSnapshotFile(snapshotDir);
  if (pulled.version === 2 && pulled.run !== resolve(runDir))
    throw new Error(`The latest snapshot was pulled for ${pulled.run ?? "no run"}, not ${resolve(runDir)}: pull again`);
  if (
    pulled.version === 2 &&
    JSON.stringify([pulled.managedSources, pulled.managedChains]) !==
      JSON.stringify([config.managedSources, config.managedChains])
  )
    throw new Error("managedSources or managedChains changed since the latest snapshot: pull again");
  const now = new Date().toISOString();
  const { plan, rows: planned } = makePlan({
    files,
    rows,
    legs: snapshot.legs,
    history: snapshot.history,
    txHashes: snapshot.txHashes,
    config,
    adopted: readAdopted(stateDir),
    overrides: readOverrides(stateDir),
    applyLog: readApplyLog(stateDir),
    leftLegs: readLeftLegs(stateDir),
    uploadedPrices: uploadedPrices(stateDir),
    now,
    scope,
  });

  // A leg dated outside the range is not in the snapshot, so a row could look missing, or a tx's other copy go unseen.
  // Only an edit of a leg the plan can see, in a current year, rests on nothing it cannot see
  if (pulled.range) {
    const wider = [
      plan.upload.length ? `${plan.upload.reduce((n, u) => n + u.ids.length, 0)} uploads` : "",
      plan.delete.length ? `${plan.delete.length} deletes` : "",
      plan.categorise.length ? `${plan.categorise.length} categorisations` : "",
      plan.edit.some((e) => e.filed) ? `edits in filed years` : "",
    ].filter(Boolean);
    if (wider.length)
      throw new Error(
        `This plan has ${wider.join(", ")}, but the snapshot covers only ${(pulled.range as PullRange).from} to ${(pulled.range as PullRange).to}, and these rest on legs outside it. Pull with --all and plan again.`,
      );
    plan.notes.unshift(
      `The snapshot covers only ${(pulled.range as PullRange).from} to ${(pulled.range as PullRange).to}: reports can miss or misstate a tx with legs outside it`,
    );
  }

  const dir = join(stateDir, "plans", now.slice(0, 19).replace(/:/g, "-"));
  mkdirSync(join(dir, "upload"), { recursive: true });
  writeFileSync(
    join(dir, "plan.json"),
    JSON.stringify(
      { snapshot: snapshot.name, run: resolve(runDir), ...(only ? { scopeFile: resolve(only) } : {}), ...plan },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "plan.md"),
    renderPlan(plan, snapshot.name, resolve(runDir), new Map(snapshot.legs.map((l) => [l.legId, l.quantity]))) + "\n",
  );
  for (const file of uploadFiles(plan, files, planned)) writeFileSync(join(dir, "upload", file.name), file.text);

  console.log(
    Object.entries(plan.counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", "),
  );
  console.log(`Plan written to ${dir}`);
  return dir;
}
