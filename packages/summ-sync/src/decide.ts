// Chooses a plan's decision option: adds its config to summ-sync.json, for the next plan. Nothing is written to Summ:
// a chosen entry still goes through a plan the user reads, and apply's approvals.

import { renameSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFresh, readPlanFile } from "./apply.ts";
import { type DeleteManualEntry, type Hold, parseConfig } from "./config.ts";

/** `choices`: each `d1:a`, a decision of the plan and one of its options. All or none are added. */
export function runDecide(stateDir: string, planPath: string, choices: string[]): void {
  if (!choices.length) throw new Error("decide: name a decision and an option, such as d1:a");
  const { plan } = readPlanFile(planPath);
  checkFresh(stateDir, plan);
  const file = join(stateDir, "summ-sync.json");
  const config: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const manual = [...((config.deleteManualEntries as DeleteManualEntry[] | undefined) ?? [])];
  const hold = [...((config.hold as Hold[] | undefined) ?? [])];
  const said: string[] = [];
  const seen = new Set<string>();
  let added = 0;
  for (const choice of choices) {
    const [, id, key] = /^(d\d+):([a-z])$/.exec(choice) ?? [];
    if (!id) throw new Error(`decide: ${choice} is not a decision and an option, such as d1:a`);
    if (seen.has(id)) throw new Error(`decide: ${id} is chosen twice`);
    seen.add(id);
    const decision = plan.decisions?.find((d) => d.id === id);
    if (!decision) throw new Error(`decide: this plan has no decision ${id}`);
    const option = decision.options.find((o) => o.key === key);
    if (!option) throw new Error(`decide: ${id} has no option ${key}`);
    const before = manual.length + hold.length;
    for (const m of option.config.deleteManualEntries ?? [])
      if (!manual.some((x) => x.legId === m.legId)) manual.push(m);
    for (const h of option.config.hold ?? []) if (!hold.some((x) => x.id === h.id)) hold.push(h);
    const count = manual.length + hold.length - before;
    added += count;
    said.push(`${id}: ${option.title} ${count ? `${count} added.` : "Nothing to add."} ${option.result}`);
  }
  if (added) {
    const text =
      JSON.stringify(
        {
          ...config,
          ...(manual.length ? { deleteManualEntries: manual } : {}),
          ...(hold.length ? { hold } : {}),
        },
        null,
        2,
      ) + "\n";
    parseConfig(text);
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  }
  for (const line of said) console.log(line);
  if (added)
    console.log(`Added to ${file}. Nothing is written to Summ. Plan again and read it: plan ${stateDir} ${plan.run}`);
}
