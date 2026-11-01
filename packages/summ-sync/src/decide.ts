// Chooses a plan's decision option: adds its config to summ-sync.json, for the next plan. Nothing is written to Summ:
// a chosen entry still goes through a plan the user reads, and apply's approvals.

import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFresh, readPlanFile } from "./apply.ts";
import { configSha, type DeleteManualEntry, type Hold, parseConfig } from "./config.ts";

/**
 * `choices`: each `d1:a`, a decision of the plan and one of its options. All or none are added. A decision's number
 * means something only in its plan, and one option can undo what another assumes, so the plan must be the one made from
 * summ-sync.json as it is now: after a choice, plan again before choosing more.
 */
export function runDecide(stateDir: string, planPath: string, choices: string[]): void {
  if (!choices.length) throw new Error("decide: name a decision and an option, such as d1:a");
  const { plan } = readPlanFile(planPath);
  checkFresh(stateDir, plan);
  const scope = plan.scopeFile ? ` --only ${plan.scopeFile}` : "";
  const again = `plan ${stateDir} ${plan.run}${scope}`;
  if (plan.configSha !== configSha(stateDir))
    throw new Error(`decide: summ-sync.json changed since this plan was made. Plan again: ${again}`);
  const file = join(stateDir, "summ-sync.json");
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "{}";
  parseConfig(text); // Says what is wrong with a config the user broke, before anything is added to it
  const config: Record<string, unknown> = JSON.parse(text);
  const manual = [...((config.deleteManualEntries as DeleteManualEntry[] | undefined) ?? [])];
  const hold = [...((config.hold as Hold[] | undefined) ?? [])];
  const said: string[] = [];
  const seen = new Set<string>();
  const filedKinds = new Set<boolean>();
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
    const entries = option.config.deleteManualEntries ?? [];
    if (entries.length) filedKinds.add(decision.filed);
    if (filedKinds.size > 1)
      throw new Error("decide: these name both filed and current-year entries, and a plan takes one kind at a time");
    const before = manual.length + hold.length;
    for (const m of entries) if (!manual.some((x) => x.legId === m.legId)) manual.push(m);
    for (const h of option.config.hold ?? []) if (!hold.some((x) => x.id === h.id)) hold.push(h);
    const count = manual.length + hold.length - before;
    added += count;
    said.push(
      `${id} (${decision.title}): ${option.title} ${count ? `${count} added.` : "Nothing to add."} ${option.result}`,
    );
  }
  if (added) {
    const next =
      JSON.stringify(
        { ...config, ...(manual.length ? { deleteManualEntries: manual } : {}), ...(hold.length ? { hold } : {}) },
        null,
        2,
      ) + "\n";
    parseConfig(next);
    // Through a link to the file itself, and with its mode: the rename replaces what it lands on
    const target = exists ? realpathSync(file) : file;
    writeFileSync(`${target}.tmp`, next, exists ? { mode: statSync(target).mode } : {});
    renameSync(`${target}.tmp`, target);
  }
  for (const line of said) console.log(line);
  if (added) console.log(`Added to ${file}. Nothing is written to Summ. Plan again and read it: ${again}`);
}
