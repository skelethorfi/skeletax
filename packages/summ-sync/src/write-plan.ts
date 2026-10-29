// The plan command: reads the run, the latest snapshot and the state tables, and writes
//
//   <state dir>/plans/<timestamp>/plan.json        the plan (input to apply)
//   <state dir>/plans/<timestamp>/plan.md          the same, for review
//   <state dir>/plans/<timestamp>/upload/<file>    per CSV file, the rows Summ lacks, for the user to upload
//
// It writes nothing else: apply adds what the plan adopted and captured to adopted.csv and overrides.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extraDirsOf, loadConfig } from "./config.ts";
import { type Change, makePlan, type EditEntry, parseScope, type Plan } from "./plan.ts";
import { readRun, type Row, type RunFile } from "./run.ts";
import { latestSnapshot, readSnapshot } from "./snapshot.ts";
import { readAdopted, readApplyLog, readOverrides } from "./state.ts";

const show = (v: unknown) => (v === null || v === "" || v === undefined ? "–" : String(v));
const cell = (v: unknown) => show(v).replaceAll("|", "\\|");

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

export function renderPlan(plan: Plan, snapshot: string, run: string): string {
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
    ...section("Edit", plan.edit, (es) => [
      "| Row | Leg | Field | Summ | Desired |",
      "| --- | --- | --- | --- | --- |",
      ...changeLines(es),
    ]),
    ...section("Upload (files in upload/, uploaded by you)", plan.upload, (es) =>
      es.map((e) => `- ${e.file}: ${e.ids.length} rows${uploadNote(plan, e.file)}`),
    ),
    ...section("Categorise", plan.categorise, (es) => [
      "| Row | Leg | Field | Summ | Desired |",
      "| --- | --- | --- | --- | --- |",
      ...changeLines(es),
    ]),
    ...section("Held (nothing planned: held in summ-sync.json, or the user's manual pairing)", plan.held, (es) => [
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
    now,
    scope,
  });

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
  writeFileSync(join(dir, "plan.md"), renderPlan(plan, snapshot.name, resolve(runDir)) + "\n");
  for (const file of uploadFiles(plan, files, planned)) writeFileSync(join(dir, "upload", file.name), file.text);

  console.log(
    Object.entries(plan.counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", "),
  );
  console.log(`Plan written to ${dir}`);
  return dir;
}
