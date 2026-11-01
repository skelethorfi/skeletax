// figures and compare: what a recalculation moved in Summ's reported disposals (spec: docs/specs/summ-sync.md, After-check).
//
//   <state dir>/figures/<time>.json                  Summ's capital gains rows and yearly totals, read when they are current
//   <state dir>/figures/compare-<a>-<b>.md           what moved between two of those files
//
// Both only read Summ. Rows are parcels of a disposal, so compare works by disposal leg (`sellUid`, stable across
// recalculations; the rows' own ids are not).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { startOfDay } from "./dates.ts";
import { loadConfig } from "./config.ts";
import { readLogLines } from "./journal.ts";
import type { McpClient } from "./mcp.ts";

type Client = Pick<McpClient, "connect" | "callTool">;

const CENT = 0.01;
const ZERO_COST = "zeroCostBuy";
/** No crypto disposal is older than this; rows and summaries are read from the tax year holding it. */
const FIRST_DAY = "2009-01-01";
const TOP_LIMIT = 20;

export interface FigureRow {
  sellUid: string;
  buyUid?: string;
  currencyId: string;
  symbol: string;
  quantity: number;
  sellTime: string;
  buyTime: string;
  cost: number;
  proceeds: number;
  gain: number;
  isLongTerm: boolean;
  error?: string;
  inTradeType: string;
  outTradeType: string;
  sellTxHash: string;
  buyTxHash?: string;
}

export interface FigureYear {
  year: number;
  from: string;
  to: string;
  filed: boolean;
  capitalGains: number;
  income: number;
  expenses: number;
}

export interface Figures {
  version: 1;
  takenAt: string;
  finishedAt: string;
  computation: { status: string; updatedAt: string };
  taxYearStart: string;
  timezone: string;
  years: FigureYear[];
  rows: FigureRow[];
}

/** Each tax year from the one holding FIRST_DAY to the one holding `now`: named by the calendar year it ends in. */
export function taxYears(start: string, timeZone: string, now: number): { year: number; from: number; to: number }[] {
  const startOf = (y: number) => startOfDay(`${y}-${start}`, timeZone);
  const firstDay = startOfDay(FIRST_DAY, timeZone);
  let y = Number(FIRST_DAY.slice(0, 4));
  while (startOf(y) > firstDay) y--;
  const years = [];
  for (; startOf(y) <= now; y++) {
    years.push({ year: start === "01-01" ? y : y + 1, from: startOf(y), to: startOf(y + 1) - 1 });
  }
  return years;
}

/** Summ's status of its latest computation. */
export function parseComputation(text: string): { status: string; updatedAt: string } {
  const field = (name: string) => text.match(new RegExp(`\\*\\*${name}\\*\\*: (.+)`))?.[1].trim() ?? "";
  return { status: field("Status"), updatedAt: field("Updated at") };
}

function reportJson(text: string): Record<string, unknown> {
  const json = text.match(/```json\n([\s\S]*?)\n```/);
  if (!json) throw new Error(`figures: no report in Summ's answer: ${text.slice(0, 200)}`);
  return JSON.parse(json[1]);
}

/** A disposal's row as a figures file keeps it. */
function figureRow(row: Record<string, unknown>): FigureRow {
  const currency = (row.currencyIdentifier ?? {}) as { id?: string; symbol?: string };
  const fine =
    typeof row.sellUid === "string" &&
    row.sellUid !== "" &&
    typeof currency.symbol === "string" &&
    [row.quantity, row.cost, row.proceeds, row.gain].every(Number.isFinite) &&
    Number.isFinite(Date.parse(row.sellTime as string)) &&
    typeof row.isLongTerm === "boolean";
  if (!fine) throw new Error(`figures: a row is not what this version reads: ${JSON.stringify(row).slice(0, 300)}`);
  return {
    sellUid: row.sellUid as string,
    ...(row.buyUid ? { buyUid: row.buyUid as string } : {}),
    currencyId: currency.id || (currency.symbol as string),
    symbol: currency.symbol as string,
    quantity: row.quantity as number,
    sellTime: row.sellTime as string,
    buyTime: row.buyTime as string,
    cost: row.cost as number,
    proceeds: row.proceeds as number,
    gain: row.gain as number,
    isLongTerm: row.isLongTerm as boolean,
    ...(row.error ? { error: row.error as string } : {}),
    inTradeType: row.inTradeType as string,
    outTradeType: row.outTradeType as string,
    sellTxHash: row.sellTxHash as string,
    ...(row.buyTxHash ? { buyTxHash: row.buyTxHash as string } : {}),
  };
}

/** The time of the log's last line, of any kind: at worst one needless recalculation. */
function lastLogTime(stateDir: string): number {
  const times = readLogLines<{ time?: string }>(stateDir).flatMap((l) => (l.time ? [Date.parse(l.time)] : []));
  return times.length ? Math.max(...times) : 0;
}

/** Refuses unless Summ's figures were computed after every logged write, with no apply running. */
async function currentComputation(client: Client, stateDir: string): Promise<{ status: string; updatedAt: string }> {
  if (existsSync(join(stateDir, ".lock"))) throw new Error("figures: an apply holds the lock: its figures are moving");
  const computation = parseComputation(await client.callTool("summ_get_latest_portfolio_computation", {}));
  if (computation.status !== "success") {
    throw new Error(
      `figures: Summ's computation is ${computation.status || "absent"}, so its figures may be stale: recalculate, and wait for success`,
    );
  }
  if (!(Date.parse(computation.updatedAt) > lastLogTime(stateDir))) {
    throw new Error(
      `figures: Summ's computation of ${computation.updatedAt} did not start after the last apply-log line: recalculate`,
    );
  }
  return computation;
}

/** A summary's figure: an empty one is no figure, not 0. */
const amount = (value: unknown): number => (value === null || value === "" ? NaN : Number(value));

const near = (a: number, b: number, within = CENT) => Math.abs(a - b) <= within;

export async function figures(
  stateDir: string,
  { client, now = Date.now() }: { client: Client; now?: number },
): Promise<string> {
  const config = loadConfig(stateDir);
  if (!config.taxYearStart) {
    throw new Error(
      'figures: set taxYearStart in summ-sync.json (for example "04-06"): a wrong year mislabels every year',
    );
  }
  await client.connect();
  const before = await currentComputation(client, stateDir);
  const logLines = readLogLines(stateDir).length;

  const years = taxYears(config.taxYearStart, config.timezone, now);
  const iso = (t: number) => new Date(t).toISOString();
  const whole = { fromDate: iso(years[0].from), toDate: iso((years.at(-1) as { to: number }).to) };

  const rows: FigureRow[] = [];
  const ids = new Set<string>();
  let total = 0;
  for (let page = 1; ; page++) {
    const report = reportJson(
      await client.callTool("get_tax_report", {
        ...whole,
        view: "detailed",
        reportType: "capital-gains",
        count: "100",
        page,
      }),
    );
    for (const row of report.rows as Record<string, unknown>[]) {
      ids.add(row._id as string);
      rows.push(figureRow(row));
    }
    total = report.totalRows as number;
    if (!Number.isInteger(report.totalPages) || !Number.isInteger(total)) {
      throw new Error("figures: Summ's report gave no row or page count");
    }
    process.stdout.write(`\r  page ${page}/${report.totalPages}   `);
    if (page >= (report.totalPages as number)) break;
  }
  process.stdout.write("\n");
  // A sum can miss a dust row dropped and another read twice, when rows shift between pages
  if (ids.size !== total || rows.length !== total) {
    throw new Error(`figures: read ${rows.length} rows, ${ids.size} unique, of Summ's ${total}: run it again`);
  }

  const summary = async (fromDate: string, toDate: string) =>
    reportJson(
      await client.callTool("get_tax_report", {
        fromDate,
        toDate,
        view: "summary",
        includeZeroCostBuys: true,
        zeroCostBuysLimit: TOP_LIMIT,
      }),
    );
  const filedBefore = config.filedBefore ? startOfDay(config.filedBefore, config.timezone) : -Infinity;
  const kept: FigureYear[] = [];
  let [gains, income] = [0, 0];
  for (const y of years) {
    const report = await summary(iso(y.from), iso(y.to));
    const yearRows = rows.filter((r) => Date.parse(r.sellTime) >= y.from && Date.parse(r.sellTime) <= y.to);
    const year: FigureYear = {
      year: y.year,
      from: iso(y.from),
      to: iso(y.to),
      filed: y.to < filedBefore,
      capitalGains: amount(report.totalCapitalGains),
      income: amount(report.totalIncome),
      expenses: amount(report.totalExpenses),
    };
    if (
      typeof report.zeroCostBuysHiddenCount !== "number" ||
      ![year.capitalGains, year.income, year.expenses].every(Number.isFinite)
    ) {
      throw new Error(`figures: ${y.year}'s summary is not what this version reads`);
    }
    const sum = yearRows.reduce((s, r) => s + r.gain, 0);
    if (!near(sum, year.capitalGains)) {
      throw new Error(`figures: ${y.year}'s rows sum to ${sum}, Summ's total is ${year.capitalGains}`);
    }
    if (report.zeroCostBuysHiddenCount === 0) checkZeroCost(y.year, yearRows, report);
    gains += year.capitalGains;
    income += year.income;
    if (yearRows.length || year.capitalGains || year.income || year.expenses) kept.push(year);
  }
  // Each year's total is rounded, so the years differ from the whole by up to a rounding each
  const totals = await summary(whole.fromDate, whole.toDate);
  const rounding = CENT * (years.length + 1);
  if (!near(gains, amount(totals.totalCapitalGains), rounding) || !near(income, amount(totals.totalIncome), rounding)) {
    throw new Error(
      `figures: the years sum to gains ${gains}, income ${income}; the whole range says ${totals.totalCapitalGains}, ${totals.totalIncome}`,
    );
  }

  const after = await currentComputation(client, stateDir);
  if (readLogLines(stateDir).length !== logLines)
    throw new Error("figures: the apply log grew during the read: run it again");
  if (after.updatedAt !== before.updatedAt) {
    throw new Error(
      `figures: Summ computed again while this read (${before.updatedAt}, ${after.updatedAt}): run it again`,
    );
  }

  const finishedAt = new Date().toISOString();
  const file = figuresFile(stateDir, finishedAt);
  writeFigures(file, {
    version: 1,
    takenAt: new Date(now).toISOString(),
    finishedAt,
    computation: after,
    taxYearStart: config.taxYearStart,
    timezone: config.timezone,
    years: kept,
    rows,
  });
  const marked = new Set(rows.filter((r) => r.error === ZERO_COST).map((r) => r.sellUid)).size;
  console.log(
    `${rows.length} rows, ${new Set(rows.map((r) => r.sellUid)).size} disposals, ${marked} with zero-cost parcels`,
  );
  console.log(`Tax years from ${config.taxYearStart} in ${config.timezone}`);
  console.log(`Figures written to ${file}`);
  return file;
}

/** The zero-cost rows must be Summ's own list of them, by symbol. */
function checkZeroCost(year: number, rows: FigureRow[], report: Record<string, unknown>): void {
  const bySymbol = new Map<string, number>();
  const add = (symbol: string, gain: number, sign: number) =>
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + sign * gain);
  for (const r of rows) if (r.error === ZERO_COST) add(r.symbol, r.gain, 1);
  for (const t of (report.zeroCostBuysTop ?? []) as { symbol: string; gain: number }[]) add(t.symbol, t.gain, -1);
  for (const [symbol, difference] of bySymbol) {
    if (!near(difference, 0))
      throw new Error(`figures: ${year}'s zero-cost ${symbol} differ from Summ's by ${difference}`);
  }
}

function figuresFile(stateDir: string, time: string): string {
  const stamp = (t: string) => t.slice(0, 19).replace(/:/g, "-");
  const dir = join(stateDir, "figures");
  let file = join(dir, `${stamp(time)}.json`);
  for (let t = Date.parse(time); existsSync(file);)
    file = join(dir, `${stamp(new Date((t += 1000)).toISOString())}.json`);
  return file;
}

/** Written whole and last, so a figures file means every check passed. */
function writeFigures(file: string, data: Figures): void {
  const { rows, years, ...head } = data;
  const list = (items: object[]) => items.map((i) => `    ${JSON.stringify(i)}`).join(",\n");
  const text = [
    "{",
    ...Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    '  "years": [',
    list(years),
    "  ],",
    '  "rows": [',
    list(rows),
    "  ]",
    "}",
    "",
  ].join("\n");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const figuresNames = (stateDir: string): string[] => {
  const dir = join(stateDir, "figures");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -5))
        .sort()
    : [];
};

/** A line for apply: figures taken before it are what a compare after it needs. Gates nothing. */
export function figuresNote(stateDir: string): string {
  // A bad figures file is no reason to stop an apply, or the resume of one
  try {
    const latest = figuresNames(stateDir).at(-1);
    if (!latest) return "No figures yet: without one from before this apply, compare has nothing to compare it with.";
    const { takenAt } = JSON.parse(readFileSync(join(stateDir, "figures", `${latest}.json`), "utf8")) as Figures;
    const since = readLogLines<{ time?: string }>(stateDir).filter((l) => l.time && l.time > takenAt).length;
    return `Latest figures ${latest}, ${since} apply-log lines since.`;
  } catch {
    return "The latest figures cannot be read.";
  }
}

// ---- compare

interface DisposalLeg {
  sellUid: string;
  currencyId: string;
  symbol: string;
  sellTime: string;
  year: number;
  types: string;
  sellTxHash: string;
  quantity: number;
  /** The quantity held long enough to count as long term. */
  longQuantity: number;
  gain: number;
  zeroQuantity: number;
  zeroGain: number;
}

interface Acquisition {
  buyUid: string;
  currencyId: string;
  symbol: string;
  buyTime: string;
  type: string;
  buyTxHash: string;
  quantity: number;
}

const sameQuantity = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));

/** By a cent or more, with room for a float's error at exactly a cent. */
const gainMoved = (a: DisposalLeg, b: DisposalLeg) => Math.abs(a.gain - b.gain) >= CENT - 1e-9;

function yearOf(time: string, data: Figures): number {
  const t = Date.parse(time);
  // A year with no rows may be left out of the file, but a row's year is always kept
  const year = data.years.find((y) => t >= Date.parse(y.from) && t <= Date.parse(y.to));
  if (!year) throw new Error(`compare: a disposal of ${time} is in no year of its file`);
  return year.year;
}

function disposalLegs(data: Figures): Map<string, DisposalLeg> {
  const legs = new Map<string, DisposalLeg & { typeSet: Set<string> }>();
  for (const r of data.rows) {
    let leg = legs.get(r.sellUid);
    if (!leg) {
      leg = {
        sellUid: r.sellUid,
        currencyId: r.currencyId,
        symbol: r.symbol,
        sellTime: r.sellTime,
        year: yearOf(r.sellTime, data),
        types: "",
        typeSet: new Set(),
        sellTxHash: r.sellTxHash,
        quantity: 0,
        longQuantity: 0,
        gain: 0,
        zeroQuantity: 0,
        zeroGain: 0,
      };
      legs.set(r.sellUid, leg);
    }
    leg.typeSet.add(r.outTradeType);
    leg.types = [...leg.typeSet].sort().join("+");
    leg.quantity += r.quantity;
    if (r.isLongTerm) leg.longQuantity += r.quantity;
    leg.gain += r.gain;
    if (r.error === ZERO_COST) {
      leg.zeroQuantity += r.quantity;
      leg.zeroGain += r.gain;
    }
  }
  return legs;
}

function acquisitions(data: Figures): Map<string, Acquisition> {
  const used = new Map<string, Acquisition>();
  for (const r of data.rows) {
    if (!r.buyUid) continue;
    const a = used.get(r.buyUid);
    if (a) a.quantity += r.quantity;
    else {
      used.set(r.buyUid, {
        buyUid: r.buyUid,
        currencyId: r.currencyId,
        symbol: r.symbol,
        buyTime: r.buyTime,
        type: r.inTradeType,
        buyTxHash: r.buyTxHash ?? "",
        quantity: r.quantity,
      });
    }
  }
  return used;
}

export interface Comparison {
  sameComputation: boolean;
  years: {
    year: number;
    filed: boolean;
    before: FigureYear | null;
    after: FigureYear | null;
    /** How the year's change in capital gains is made up. */
    gone: number;
    added: number;
    replaced: number;
    changed: number;
    underTolerance: number;
    /** The change the parts leave unexplained: rounding, unless the files disagree with their own totals. */
    unexplained: number;
  }[];
  zeroCost: { leg: DisposalLeg; before: number; after: number; gainBefore: number; gainAfter: number }[];
  gone: DisposalLeg[];
  added: DisposalLeg[];
  replaced: { before: DisposalLeg; after: DisposalLeg }[];
  changed: { before: DisposalLeg; after: DisposalLeg }[];
  noLongerUsed: Acquisition[];
  newlyUsed: Acquisition[];
}

/** What moved between two figures files. A pure function of them. */
export function compareFigures(before: Figures, after: Figures): Comparison {
  if (before.taxYearStart !== after.taxYearStart || before.timezone !== after.timezone) {
    throw new Error("compare: the two files were read under different tax years or timezones");
  }
  if (Date.parse(after.computation.updatedAt) < Date.parse(before.computation.updatedAt)) {
    throw new Error("compare: the files are the wrong way round: the second is the older computation");
  }
  const was = disposalLegs(before);
  const now = disposalLegs(after);

  const parts = new Map<number, { gone: number; added: number; replaced: number; changed: number; under: number }>();
  const part = (year: number) => {
    let p = parts.get(year);
    if (!p) parts.set(year, (p = { gone: 0, added: 0, replaced: 0, changed: 0, under: 0 }));
    return p;
  };

  const changed: Comparison["changed"] = [];
  for (const [id, b] of was) {
    const a = now.get(id);
    if (!a) continue;
    const moved =
      gainMoved(a, b) ||
      !sameQuantity(a.quantity, b.quantity) ||
      !sameQuantity(a.longQuantity, b.longQuantity) ||
      a.types !== b.types ||
      a.year !== b.year;
    if (moved) changed.push({ before: b, after: a });
    part(b.year)[moved ? "changed" : "under"] -= b.gain;
    part(a.year)[moved ? "changed" : "under"] += a.gain;
  }

  // One new leg stands for one gone leg, at most: a hint that it was deleted and uploaded again
  const gone = [...was.values()].filter((l) => !now.has(l.sellUid));
  const added = [...now.values()].filter((l) => !was.has(l.sellUid));
  const replaced: Comparison["replaced"] = [];
  const open = [...added];
  const alike = (a: DisposalLeg, b: DisposalLeg) =>
    a.currencyId === b.currencyId && a.sellTime === b.sellTime && sameQuantity(a.quantity, b.quantity);
  // Among identical legs, those with the same zero-cost and long-term quantities first: else two entries cancel out
  const same = (a: DisposalLeg, b: DisposalLeg) =>
    alike(a, b) && sameQuantity(a.zeroQuantity, b.zeroQuantity) && sameQuantity(a.longQuantity, b.longQuantity);
  let unpaired = gone;
  for (const fits of [same, alike]) {
    unpaired = unpaired.filter((b) => {
      const at = open.findIndex((a) => fits(a, b));
      if (at < 0) return true;
      replaced.push({ before: b, after: open[at] });
      open.splice(at, 1);
      return false;
    });
  }
  for (const l of unpaired) part(l.year).gone -= l.gain;
  for (const l of open) part(l.year).added += l.gain;
  for (const { before: b, after: a } of replaced) part(a.year).replaced += a.gain - b.gain;

  // A replaced pair is one leg here: both sides zero-cost is no change
  const zeroCost: Comparison["zeroCost"] = [];
  const kept = [...was.values()].flatMap((b) => {
    const a = now.get(b.sellUid);
    return a ? [{ b, a }] : [];
  });
  for (const { b, a } of [
    ...kept,
    ...replaced.map((p) => ({ b: p.before, a: p.after })),
    ...unpaired.map((b) => ({ b, a: undefined })),
    ...open.map((a) => ({ b: undefined, a })),
  ]) {
    const [q0, q1] = [b?.zeroQuantity ?? 0, a?.zeroQuantity ?? 0];
    if (sameQuantity(q0, q1)) continue;
    zeroCost.push({
      leg: (a ?? b) as DisposalLeg,
      before: q0,
      after: q1,
      gainBefore: b?.zeroGain ?? 0,
      gainAfter: a?.zeroGain ?? 0,
    });
  }
  zeroCost.sort((x, y) => Math.abs(y.gainAfter - y.gainBefore) - Math.abs(x.gainAfter - x.gainBefore));

  const usedBefore = acquisitions(before);
  const usedAfter = acquisitions(after);

  const byYear = new Map(before.years.map((y) => [y.year, y]));
  const nowYear = new Map(after.years.map((y) => [y.year, y]));
  const years = [...new Set([...byYear.keys(), ...nowYear.keys()])].sort().map((year) => {
    const [b, a] = [byYear.get(year) ?? null, nowYear.get(year) ?? null];
    const p = part(year);
    const total = (a?.capitalGains ?? 0) - (b?.capitalGains ?? 0);
    return {
      year,
      filed: Boolean(a?.filed ?? b?.filed),
      before: b,
      after: a,
      gone: p.gone,
      added: p.added,
      replaced: p.replaced,
      changed: p.changed,
      underTolerance: p.under,
      unexplained: total - (p.gone + p.added + p.replaced + p.changed + p.under),
    };
  });

  const byGainMoved = (
    x: { before: DisposalLeg; after: DisposalLeg },
    y: { before: DisposalLeg; after: DisposalLeg },
  ) => Math.abs(y.after.gain - y.before.gain) - Math.abs(x.after.gain - x.before.gain);
  return {
    sameComputation: before.computation.updatedAt === after.computation.updatedAt,
    years,
    zeroCost,
    gone: unpaired,
    added: open,
    replaced: replaced.sort(byGainMoved),
    changed: changed.sort(byGainMoved),
    noLongerUsed: [...usedBefore.values()].filter((u) => !usedAfter.has(u.buyUid)),
    newlyUsed: [...usedAfter.values()].filter((u) => !usedBefore.has(u.buyUid)),
  };
}

const money = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (r === 0 ? 0 : r).toFixed(2);
};
const signed = (n: number) => (Math.round(n * 100) === 0 ? "0.00" : `${n > 0 ? "+" : ""}${money(n)}`);
const legLine = (l: DisposalLeg) =>
  `${l.sellTime} ${l.quantity} ${l.symbol} ${l.types}, gain ${money(l.gain)} (leg ${l.sellUid}, tx ${l.sellTxHash})`;
const usedLine = (a: Acquisition) =>
  `${a.buyTime} ${a.quantity} ${a.symbol} ${a.type} (leg ${a.buyUid}${a.buyTxHash ? `, tx ${a.buyTxHash}` : ""})`;

/** The comparison as compare's report. */
export function compareMarkdown(c: Comparison, beforeName: string, afterName: string): string {
  const out = [`# Figures ${beforeName} to ${afterName}`, ""];
  if (c.sameComputation) out.push("Both files read the same computation: nothing was recalculated between them.", "");

  out.push("## Years", "");
  out.push(
    "| Year | Capital gain before | after | change | Income change | Expenses change |",
    "|---|---|---|---|---|---|",
  );
  for (const y of c.years) {
    const delta = (k: "capitalGains" | "income" | "expenses") => signed((y.after?.[k] ?? 0) - (y.before?.[k] ?? 0));
    out.push(
      `| ${y.year}${y.filed ? " (filed)" : ""} | ${money(y.before?.capitalGains ?? 0)} | ${money(y.after?.capitalGains ?? 0)} | ${delta("capitalGains")} | ${delta("income")} | ${delta("expenses")} |`,
    );
  }
  out.push("");
  const moved = c.years.filter(
    (y) => Math.abs((y.after?.capitalGains ?? 0) - (y.before?.capitalGains ?? 0)) >= CENT - 1e-9,
  );
  for (const y of moved) {
    out.push(
      `- ${y.year}: gone ${signed(y.gone)}, new ${signed(y.added)}, replaced ${signed(y.replaced)}, changed ${signed(y.changed)}, under a cent each ${signed(y.underTolerance)}.`,
    );
  }
  // Each total is rounded to a cent
  for (const y of c.years) {
    if (Math.abs(y.unexplained) > 2 * CENT)
      out.push(`- **${y.year}: ${signed(y.unexplained)} of the change is on no leg.**`);
  }
  if (moved.length) out.push("");

  const section = (title: string, lines: string[]) => {
    out.push(`## ${title}`, "", ...(lines.length ? lines : ["None."]), "");
  };
  section(
    "Zero-cost parcels",
    c.zeroCost.map(
      (z) =>
        `- ${z.leg.sellTime} ${z.leg.symbol} ${z.leg.types}: zero-cost quantity ${z.before} to ${z.after}, its gain ${money(z.gainBefore)} to ${money(z.gainAfter)} (leg ${z.leg.sellUid}, tx ${z.leg.sellTxHash})`,
    ),
  );
  section(
    "Disposals gone",
    c.gone.map((l) => `- ${legLine(l)}`),
  );
  section(
    "Disposals new",
    c.added.map((l) => `- ${legLine(l)}`),
  );
  section(
    "Disposals replaced (same currency, time and quantity under a new leg: a hint, not proof)",
    c.replaced.map(
      ({ before: b, after: a }) =>
        `- ${a.sellTime} ${a.quantity} ${a.symbol}: gain ${money(b.gain)} to ${money(a.gain)}, ${signed(a.gain - b.gain)}${sameQuantity(a.longQuantity, b.longQuantity) ? "" : `, long-term quantity ${b.longQuantity} to ${a.longQuantity}`} (${b.types} leg ${b.sellUid} to ${a.types} leg ${a.sellUid}, tx ${a.sellTxHash})`,
    ),
  );

  const groups = new Map<string, Comparison["changed"]>();
  for (const pair of c.changed) groups.set(pair.after.currencyId, [...(groups.get(pair.after.currencyId) ?? []), pair]);
  const moveOf = (pairs: Comparison["changed"]) => pairs.reduce((s, p) => s + p.after.gain - p.before.gain, 0);
  const lines = [...groups.values()]
    .sort((x, y) => Math.abs(moveOf(y)) - Math.abs(moveOf(x)))
    .flatMap((pairs) => [
      `- **${pairs[0].after.symbol}**: ${pairs.length} legs, ${signed(moveOf(pairs))}`,
      ...pairs.map(({ before: b, after: a }) => {
        const also = [
          sameQuantity(a.quantity, b.quantity) ? "" : `quantity ${b.quantity} to ${a.quantity}`,
          sameQuantity(a.longQuantity, b.longQuantity)
            ? ""
            : `long-term quantity ${b.longQuantity} to ${a.longQuantity}`,
          a.types === b.types ? "" : `type ${b.types} to ${a.types}`,
          a.year === b.year ? "" : `year ${b.year} to ${a.year}`,
        ].filter(Boolean);
        return `  - ${a.sellTime} ${a.types}: gain ${money(b.gain)} to ${money(a.gain)}, ${signed(a.gain - b.gain)}${also.length ? `; ${also.join(", ")}` : ""} (leg ${a.sellUid}, tx ${a.sellTxHash})`;
      }),
    ]);
  section("Gains changed on kept disposals", lines);

  section(
    "Acquisitions no longer used (a hint: what the parcels were drawn from)",
    c.noLongerUsed.map((a) => `- ${usedLine(a)}`),
  );
  section(
    "Acquisitions newly used",
    c.newlyUsed.map((a) => `- ${usedLine(a)}`),
  );
  return out.join("\n");
}

/** A figures file by its name, or a path. */
function readFigures(stateDir: string, name: string): Figures {
  const file = name.includes("/") ? name : join(stateDir, "figures", name.endsWith(".json") ? name : `${name}.json`);
  if (!existsSync(file)) throw new Error(`compare: no figures file ${file}`);
  const data = JSON.parse(readFileSync(file, "utf8")) as Figures;
  if (data.version !== 1) throw new Error(`compare: ${file} is not a figures file this version reads`);
  return data;
}

export function runCompare(stateDir: string, beforeName: string, afterName: string): string {
  const report = compareFigures(readFigures(stateDir, beforeName), readFigures(stateDir, afterName));
  const stem = (n: string) => basename(n, ".json");
  const text = compareMarkdown(report, stem(beforeName), stem(afterName));
  const file = join(stateDir, "figures", `compare-${stem(beforeName)}-${stem(afterName)}.md`);
  mkdirSync(join(stateDir, "figures"), { recursive: true });
  writeFileSync(file, text);
  console.log(text);
  console.log(`Written to ${file}`);
  return file;
}
