import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import {
  compareFigures,
  compareMarkdown,
  figures,
  figuresNote,
  type FigureRow,
  type Figures,
  parseComputation,
  runCompare,
  taxYears,
} from "../src/figures.ts";

const FY = "04-01";
const TZ = "Asia/Tokyo";
const NOW = Date.parse("2024-03-01T00:00:00Z");
const COMPUTED = "2024-02-01T00:00:00.000Z";

const row = (over: Partial<FigureRow> & { sellUid: string; gain: number }): FigureRow => ({
  buyUid: `buy-${over.sellUid}`,
  currencyId: "thorchain",
  symbol: "RUNE",
  quantity: 1,
  sellTime: "2023-01-01T00:00:00.000Z",
  buyTime: "2022-01-01T00:00:00.000Z",
  cost: 1,
  proceeds: 1 + over.gain,
  isLongTerm: false,
  inTradeType: "buy",
  outTradeType: "sell",
  sellTxHash: `tx-${over.sellUid}`,
  ...over,
});

const data = (rows: FigureRow[], updatedAt = COMPUTED, income = 0): Figures => ({
  version: 1,
  takenAt: updatedAt,
  finishedAt: updatedAt,
  computation: { status: "success", updatedAt },
  taxYearStart: FY,
  timezone: TZ,
  years: [
    {
      year: 2023,
      from: "2022-03-31T15:00:00.000Z",
      to: "2023-03-31T14:59:59.999Z",
      filed: true,
      capitalGains: rows.reduce((s, r) => s + r.gain, 0),
      income,
      expenses: 0,
    },
  ],
  rows,
});
const LATER = "2024-02-02T00:00:00.000Z";

test("tax years follow a clock change: the start is local midnight in that year's offset", () => {
  const years = taxYears("04-06", "Europe/London", NOW);
  const y = years.find((v) => v.year === 2023) as { from: number; to: number };
  assert.equal(new Date(y.from).toISOString(), "2022-04-05T23:00:00.000Z");
  assert.equal(new Date(y.to).toISOString(), "2023-04-05T22:59:59.999Z");
  const winter = taxYears("01-01", "Europe/London", NOW).find((v) => v.year === 2023) as { from: number };
  assert.equal(new Date(winter.from).toISOString(), "2023-01-01T00:00:00.000Z");
});

test("tax years end one millisecond before the next starts, in the account's timezone", () => {
  const years = taxYears(FY, TZ, NOW);
  assert.equal(years[0].year, 2009);
  const y = years.find((v) => v.year === 2023) as { from: number; to: number };
  assert.equal(new Date(y.from).toISOString(), "2022-03-31T15:00:00.000Z");
  assert.equal(new Date(y.to).toISOString(), "2023-03-31T14:59:59.999Z");
  assert.equal(years.at(-1)?.year, 2024);
  assert.equal(taxYears("01-01", "UTC", NOW).at(-1)?.year, 2024);
  assert.equal(taxYears("01-01", "UTC", NOW)[0].year, 2009);
});

test("taxYearStart must be a day of the year", () => {
  assert.equal(parseConfig(JSON.stringify({ taxYearStart: FY })).taxYearStart, FY);
  assert.equal(parseConfig("{}").taxYearStart, null);
  for (const bad of ["4-1", "13-01", "02-29", "02-30"]) {
    assert.throws(() => parseConfig(JSON.stringify({ taxYearStart: bad })), /taxYearStart/);
  }
});

test("Summ's computation status is read", () => {
  assert.deepEqual(parseComputation("# x\n\n- **Status**: success\n- **Updated at**: 2026-01-01T00:00:00.000Z\n"), {
    status: "success",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(parseComputation("# nothing").status, "");
});

// ---- figures, against a Summ that answers its two tools

interface Fake {
  status?: string[];
  rows?: Record<string, unknown>[];
  gains?: number;
  totalRows?: number;
  top?: { symbol: string; gain: number }[];
  hidden?: number | null;
  expenses?: string | null;
  /** Summary of the whole range, when it differs from the rows. */
  wholeIncome?: number;
}

const apiRow = (over: Record<string, unknown>) => ({
  _id: `r${over.sellUid}${over.buyUid ?? ""}`,
  sellUid: "s1",
  buyUid: "b1",
  currencyIdentifier: { id: "thorchain", symbol: "RUNE" },
  quantity: 1,
  sellTime: "2023-01-01T00:00:00.000Z",
  buyTime: "2022-01-01T00:00:00.000Z",
  cost: 1,
  proceeds: 3,
  gain: 2,
  isLongTerm: false,
  inTradeType: "buy",
  outTradeType: "sell",
  sellTxHash: "t1",
  buyTxHash: "t0",
  ...over,
});

function fakeSumm(fake: Fake) {
  const status = fake.status ?? [`success|${COMPUTED}`];
  const rows = fake.rows ?? [apiRow({})];
  const calls: Record<string, unknown>[] = [];
  let reads = 0;
  const block = (o: unknown) => "# r\n\n```json\n" + JSON.stringify(o) + "\n```\n";
  return {
    calls,
    connect: async () => {},
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args });
      if (name === "summ_get_latest_portfolio_computation") {
        const [s, u] = status[Math.min(reads++, status.length - 1)].split("|");
        return `- **Status**: ${s}\n- **Updated at**: ${u}\n`;
      }
      assert.equal(name, "get_tax_report");
      if (args.view === "detailed") {
        const page = args.page as number;
        return block({
          rows: rows.slice((page - 1) * 2, page * 2),
          totalRows: fake.totalRows ?? rows.length,
          totalPages: Math.max(1, Math.ceil(rows.length / 2)),
        });
      }
      const [from, to] = [Date.parse(args.fromDate as string), Date.parse(args.toDate as string)];
      const inside = rows.filter(
        (r) => Date.parse(r.sellTime as string) >= from && Date.parse(r.sellTime as string) <= to,
      );
      const isWhole = to - from > 2 * 366 * 86_400_000;
      return block({
        totalCapitalGains: String(
          (inside.length ? fake.gains : undefined) ?? inside.reduce((s, r) => s + (r.gain as number), 0),
        ),
        totalIncome: isWhole && fake.wholeIncome !== undefined ? String(fake.wholeIncome) : "0",
        totalExpenses: fake.expenses === undefined ? "0" : fake.expenses,
        zeroCostBuysTop:
          (inside.length ? fake.top : undefined) ??
          inside
            .filter((r) => r.error)
            .map((r) => ({ symbol: (r.currencyIdentifier as { symbol: string }).symbol, gain: r.gain })),
        zeroCostBuysHiddenCount: fake.hidden === undefined ? 0 : fake.hidden,
      });
    },
  };
}

function stateDir(config: object = { taxYearStart: FY, timezone: TZ }, log: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "summ-figures-"));
  writeFileSync(join(dir, "summ-sync.json"), JSON.stringify(config));
  if (log.length)
    writeFileSync(
      join(dir, "apply-log.jsonl"),
      log.map((time) => JSON.stringify({ time, call: "skip" })).join("\n") + "\n",
    );
  return dir;
}

const run = (dir: string, fake: Fake = {}) => figures(dir, { client: fakeSumm(fake), now: NOW });
const noFile = (dir: string) => assert.equal(existsSync(join(dir, "figures")), false);

test("figures saves rows, without Summ's row ids, and the years with anything in them", async () => {
  const dir = stateDir({ taxYearStart: FY, timezone: TZ, filedBefore: "2023-07-01" });
  const file = await run(dir, {
    rows: [
      apiRow({ buyUid: "b1" }),
      apiRow({ buyUid: "b2", gain: 1 }),
      apiRow({ sellUid: "s2", buyUid: undefined, error: "zeroCostBuy", gain: 5, sellTime: "2023-08-01T00:00:00.000Z" }),
    ],
  });
  const saved = JSON.parse(readFileSync(file, "utf8")) as Figures;
  assert.deepEqual(
    saved.years.map((y) => [y.year, y.capitalGains, y.filed]),
    [
      [2023, 3, true],
      [2024, 5, false],
    ],
  );
  assert.equal(saved.rows.length, 3);
  assert.equal("_id" in saved.rows[0], false);
  assert.equal(saved.rows[2].buyUid, undefined);
  assert.equal(saved.rows[2].error, "zeroCostBuy");
  assert.equal(saved.computation.updatedAt, COMPUTED);
  assert.match(figuresNote(dir), /Latest figures .*, 0 apply-log lines since/);
});

test("figures reads only, and each year's summary ends a millisecond before the next", async () => {
  const dir = stateDir();
  const client = fakeSumm({});
  await figures(dir, { client, now: NOW });
  const names = new Set(client.calls.map((c) => c.name));
  assert.deepEqual([...names].sort(), ["get_tax_report", "summ_get_latest_portfolio_computation"]);
  assert.ok(
    client.calls.some((c) => c.fromDate === "2022-03-31T15:00:00.000Z" && c.toDate === "2023-03-31T14:59:59.999Z"),
  );
});

for (const [name, fake, pattern] of [
  ["a paused computation", { status: [`requires-refresh|${COMPUTED}`] }, /requires-refresh/],
  ["a running computation", { status: [`pending|${COMPUTED}`] }, /pending/],
  ["no computation", { status: ["|"] }, /absent/],
  ["a computation during the read", { status: [`success|${COMPUTED}`, `success|${LATER}`] }, /computed again/],
  [
    "a computation going stale during the read",
    { status: [`success|${COMPUTED}`, `requires-refresh|${COMPUTED}`] },
    /requires-refresh/,
  ],
  ["rows that do not sum to Summ's total", { gains: 3 }, /sum to/],
  ["missing rows", { totalRows: 2 }, /run it again/],
  ["a row read twice in place of another", { rows: [apiRow({}), apiRow({})] }, /run it again/],
  ["zero-cost rows that are not Summ's list", { top: [{ symbol: "RUNE", gain: 9 }] }, /zero-cost RUNE/],
  ["income in no year", { wholeIncome: 50 }, /whole range/],
  ["a row with no leg", { rows: [apiRow({ sellUid: "" })] }, /not what this version reads/],
  ["a row with no gain", { rows: [apiRow({ gain: null })] }, /not what this version reads/],
  ["a row with no date", { rows: [apiRow({ sellTime: "soon" })] }, /not what this version reads/],
  ["a row with no holding period", { rows: [apiRow({ isLongTerm: undefined })] }, /not what this version reads/],
  ["a summary with no zero-cost count", { hidden: null }, /summary is not/],
  ["a summary with no expenses", { expenses: null }, /summary is not/],
] as [string, Fake, RegExp][]) {
  test(`figures refuses ${name}, and writes nothing`, async () => {
    const dir = stateDir();
    await assert.rejects(run(dir, fake), pattern);
    noFile(dir);
  });
}

test("figures leaves out the zero-cost check when Summ's list is cut short", async () => {
  const file = await run(stateDir(), { top: [{ symbol: "RUNE", gain: 9 }], hidden: 3 });
  assert.ok(existsSync(file));
});

test("figures refuses a computation that started before the last log line, of any kind", async () => {
  const dir = stateDir(undefined, ["2024-02-01T00:00:01.000Z"]);
  await assert.rejects(run(dir), /did not start after/);
  noFile(dir);
  assert.ok(await run(stateDir(undefined, ["2024-01-31T23:59:59.000Z"]), {}));
});

test("figures refuses while an apply holds the lock, and with no tax year set", async () => {
  const locked = stateDir();
  writeFileSync(join(locked, ".lock"), "1");
  await assert.rejects(run(locked), /lock/);
  await assert.rejects(run(stateDir({ timezone: TZ })), /taxYearStart/);
});

test("figures refuses a log line or a lock that appears during the read", async () => {
  for (const [name, pattern] of [
    ["apply-log.jsonl", /grew during/],
    [".lock", /lock/],
  ] as [string, RegExp][]) {
    const dir = stateDir();
    const client = fakeSumm({});
    const real = client.callTool;
    client.callTool = async (tool, args) => {
      if (tool === "get_tax_report") {
        const line = JSON.stringify({ call: "skip", time: "2020-01-01T00:00:00.000Z" }) + "\n";
        writeFileSync(join(dir, name), line);
      }
      return real(tool, args);
    };
    await assert.rejects(figures(dir, { client, now: NOW }), pattern);
    noFile(dir);
  }
});

test("a report with no page count stops rather than paging for ever", async () => {
  const client = fakeSumm({});
  const real = client.callTool;
  client.callTool = async (name, args) =>
    args.view === "detailed" ? '```json\n{"rows":[],"totalRows":0}\n```' : real(name, args);
  await assert.rejects(figures(stateDir(), { client, now: NOW }), /no row or page count/);
});

test("figures refuses an answer that is no report", async () => {
  const client = fakeSumm({});
  const real = client.callTool;
  client.callTool = async (name, args) =>
    name === "get_tax_report" ? "Upgrade your plan to see this report" : real(name, args);
  await assert.rejects(figures(stateDir(), { client, now: NOW }), /no report/);
});

// ---- compare

test("the same rows under a new computation show nothing moved", () => {
  const rows = [row({ sellUid: "a", gain: 2 }), row({ sellUid: "a", gain: 3, buyUid: "other" })];
  const c = compareFigures(data(rows), data(rows, LATER));
  assert.equal(c.sameComputation, false);
  for (const list of [c.zeroCost, c.gone, c.added, c.replaced, c.changed, c.noLongerUsed, c.newlyUsed]) {
    assert.deepEqual(list, []);
  }
  assert.equal(c.years[0].unexplained, 0);
});

test("parcels sum by disposal leg: a move between parcels with the same total is no change", () => {
  const b = [row({ sellUid: "a", gain: 2, buyUid: "x" }), row({ sellUid: "a", gain: 3, buyUid: "x" })];
  const a = [row({ sellUid: "a", gain: 5, quantity: 2, buyUid: "x" })];
  assert.deepEqual(compareFigures(data(b), data(a, LATER)).changed, []);
});

test("a disposal that moved shows its gain, by currency, largest first; under a cent is only counted", () => {
  const before = [
    row({ sellUid: "a", gain: 10 }),
    row({ sellUid: "b", gain: 10, currencyId: "bitcoin", symbol: "BTC" }),
    row({ sellUid: "c", gain: 10 }),
  ];
  const after = [
    row({ sellUid: "a", gain: 11 }),
    row({ sellUid: "b", gain: 30, currencyId: "bitcoin", symbol: "BTC" }),
    row({ sellUid: "c", gain: 10.005 }),
  ];
  const c = compareFigures(data(before), data(after, LATER));
  assert.deepEqual(
    c.changed.map((p) => p.after.sellUid),
    ["b", "a"],
  );
  assert.ok(Math.abs(c.years[0].changed - 21) < 1e-9);
  assert.ok(Math.abs(c.years[0].underTolerance - 0.005) < 1e-9);
  const md = compareMarkdown(c, "x", "y");
  assert.ok(md.indexOf("**BTC**") < md.indexOf("**RUNE**"));
  assert.match(
    md,
    /changed \+21\.00, under a cent each \+0\.01|changed \+21\.00, under a cent each \+0\.00|changed \+21\.00/,
  );
});

test("a holding period that flips shows at the same gain and quantity", () => {
  const c = compareFigures(
    data([row({ sellUid: "a", gain: 1, quantity: 2 })]),
    data([row({ sellUid: "a", gain: 1, quantity: 2, isLongTerm: true })], LATER),
  );
  assert.equal(c.changed.length, 1);
  assert.match(compareMarkdown(c, "x", "y"), /long-term quantity 0 to 2/);
});

test("a gain moved by exactly a cent counts as moved", () => {
  const c = compareFigures(data([row({ sellUid: "a", gain: 10 })]), data([row({ sellUid: "a", gain: 10.01 })], LATER));
  assert.equal(c.changed.length, 1);
});

test("a replaced pair zero-cost on both sides is no change; one that lost its cost is", () => {
  const zero = { error: "zeroCostBuy", buyUid: undefined, sellTime: "2023-02-02T00:00:00.000Z" };
  const same = compareFigures(
    data([row({ sellUid: "o", gain: 1, ...zero })]),
    data([row({ sellUid: "n", gain: 1, ...zero })], LATER),
  );
  assert.equal(same.replaced.length, 1);
  assert.deepEqual(same.zeroCost, []);
  const worse = compareFigures(
    data([row({ sellUid: "o", gain: 1, sellTime: zero.sellTime })]),
    data([row({ sellUid: "n", gain: 1, ...zero })], LATER),
  );
  assert.deepEqual(
    worse.zeroCost.map((z) => [z.before, z.after]),
    [[0, 1]],
  );
});

test("a holding period that flips on a replaced pair shows", () => {
  const c = compareFigures(
    data([row({ sellUid: "o", gain: 1 })]),
    data([row({ sellUid: "n", gain: 1, isLongTerm: true })], LATER),
  );
  assert.equal(c.replaced.length, 1);
  assert.match(compareMarkdown(c, "x", "y"), /long-term quantity 0 to 1/);
});

test("identical legs pair by their zero-cost quantity, so nothing cancels out", () => {
  const zero = { error: "zeroCostBuy", buyUid: undefined };
  const c = compareFigures(
    data([row({ sellUid: "o1", gain: 1 }), row({ sellUid: "o2", gain: 1, ...zero })]),
    data([row({ sellUid: "n1", gain: 1, ...zero }), row({ sellUid: "n2", gain: 1 })], LATER),
  );
  assert.deepEqual(
    c.replaced.map((p) => [p.before.sellUid, p.after.sellUid]),
    [
      ["o1", "n2"],
      ["o2", "n1"],
    ],
  );
  assert.deepEqual(c.zeroCost, []);
});

test("a year whose gain moved by a cent shows how", () => {
  const md = compareMarkdown(
    compareFigures(data([row({ sellUid: "a", gain: 10 })]), data([row({ sellUid: "a", gain: 10.01 })], LATER)),
    "x",
    "y",
  );
  assert.match(md, /- 2023: gone/);
});

test("a kept leg shows a quantity or type change even at the same gain", () => {
  const c = compareFigures(
    data([row({ sellUid: "a", gain: 1 }), row({ sellUid: "b", gain: 1 })]),
    data([row({ sellUid: "a", gain: 1, quantity: 2 }), row({ sellUid: "b", gain: 1, outTradeType: "expense" })], LATER),
  );
  assert.equal(c.changed.length, 2);
  const md = compareMarkdown(c, "x", "y");
  assert.match(md, /quantity 1 to 2/);
  assert.match(md, /type sell to expense/);
});

test("growth on a leg already partly zero-cost is reported, by the mark and not by cost", () => {
  const before = [
    row({ sellUid: "a", gain: 1, quantity: 3 }),
    row({ sellUid: "a", gain: 4, quantity: 1, error: "zeroCostBuy", buyUid: undefined, cost: 0.5 }),
    row({ sellUid: "free", gain: 0, cost: 0 }),
  ];
  const after = [
    row({ sellUid: "a", gain: 1, quantity: 2 }),
    row({ sellUid: "a", gain: 8, quantity: 2, error: "zeroCostBuy", buyUid: undefined, cost: 0.5 }),
    row({ sellUid: "free", gain: 0, cost: 0 }),
    row({ sellUid: "n", gain: 2, error: "zeroCostBuy", buyUid: undefined }),
  ];
  const c = compareFigures(data(before), data(after, LATER));
  assert.deepEqual(
    c.zeroCost.map((z) => [z.leg.sellUid, z.before, z.after]),
    [
      ["a", 1, 2],
      ["n", 0, 1],
    ],
  );
});

test("a zero-cost leg that goes away is reported as cleared", () => {
  const c = compareFigures(
    data([row({ sellUid: "a", gain: 4, error: "zeroCostBuy", buyUid: undefined })]),
    data([], LATER),
  );
  assert.deepEqual(
    c.zeroCost.map((z) => [z.before, z.after, z.gainAfter]),
    [[1, 0, 0]],
  );
});

test("a lost disposal, with no warning, shows as gone and in the year's account", () => {
  const c = compareFigures(
    data([row({ sellUid: "a", gain: 7 }), row({ sellUid: "b", gain: 1 })]),
    data([row({ sellUid: "b", gain: 1 })], LATER),
  );
  assert.deepEqual(
    c.gone.map((l) => l.sellUid),
    ["a"],
  );
  assert.equal(c.years[0].gone, -7);
  assert.ok(Math.abs(c.years[0].unexplained) < 1e-9);
  assert.match(compareMarkdown(c, "x", "y"), /2023 \(filed\) \| 8\.00 \| 1\.00 \| -7\.00/);
});

test("a replaced disposal shows its gain difference; pairing is one to one", () => {
  const same = { sellTime: "2023-02-02T00:00:00.000Z" };
  const c = compareFigures(
    data([row({ sellUid: "old1", gain: 1, ...same }), row({ sellUid: "old2", gain: 1, ...same })]),
    data([row({ sellUid: "new1", gain: 5, ...same })], LATER),
  );
  assert.deepEqual(
    c.replaced.map((p) => [p.before.sellUid, p.after.sellUid]),
    [["old1", "new1"]],
  );
  assert.deepEqual(
    c.gone.map((l) => l.sellUid),
    ["old2"],
  );
  assert.deepEqual(c.added, []);
  assert.equal(c.years[0].replaced, 4);
  assert.equal(c.years[0].gone, -1);
  assert.match(compareMarkdown(c, "x", "y"), /gain 1\.00 to 5\.00, \+4\.00/);
});

test("another currency, time or quantity is not a replacement", () => {
  for (const other of [{ currencyId: "bitcoin" }, { sellTime: "2023-02-02T00:00:00.000Z" }, { quantity: 2 }]) {
    const c = compareFigures(
      data([row({ sellUid: "o", gain: 1 })]),
      data([row({ sellUid: "n", gain: 1, ...other })], LATER),
    );
    assert.equal(c.replaced.length, 0);
    assert.equal(c.gone.length, 1);
    assert.equal(c.added.length, 1);
  }
});

test("acquisitions used before and not after, and the reverse, are listed", () => {
  const c = compareFigures(
    data([row({ sellUid: "a", gain: 1, buyUid: "lost", buyTxHash: "h" })]),
    data([row({ sellUid: "a", gain: 1, buyUid: "other" })], LATER),
  );
  assert.deepEqual(
    c.noLongerUsed.map((u) => u.buyUid),
    ["lost"],
  );
  assert.deepEqual(
    c.newlyUsed.map((u) => u.buyUid),
    ["other"],
  );
});

test("a leg moved to another year counts in both", () => {
  const two = (f: Figures): Figures => ({
    ...f,
    years: [
      ...f.years,
      {
        ...f.years[0],
        year: 2024,
        filed: false,
        from: "2023-03-31T15:00:00.000Z",
        to: "2024-03-31T14:59:59.999Z",
        capitalGains: 0,
      },
    ],
  });
  const before = two(data([row({ sellUid: "a", gain: 1 })]));
  const after = two(data([row({ sellUid: "a", gain: 1, sellTime: "2023-08-01T00:00:00.000Z" })], LATER));
  after.years[0].capitalGains = 0;
  after.years[1].capitalGains = 1;
  const c = compareFigures(before, after);
  assert.equal(c.changed.length, 1);
  assert.deepEqual(
    c.years.map((y) => [y.year, y.changed, y.unexplained]),
    [
      [2023, -1, 0],
      [2024, 1, 0],
    ],
  );
});

test("a change the legs do not explain is flagged", () => {
  const after = data([row({ sellUid: "a", gain: 1 })], LATER);
  after.years[0].capitalGains = 5;
  assert.match(
    compareMarkdown(compareFigures(data([row({ sellUid: "a", gain: 1 })]), after), "x", "y"),
    /\+4\.00 of the change is on no leg/,
  );
});

test("compare refuses other tax years and a reversed pair, and says when nothing was recalculated", () => {
  const rows = [row({ sellUid: "a", gain: 1 })];
  assert.throws(() => compareFigures(data(rows), { ...data(rows), timezone: "UTC" }), /different tax years/);
  assert.throws(() => compareFigures(data(rows, LATER), data(rows)), /wrong way round/);
  const c = compareFigures(data(rows), data(rows));
  assert.match(compareMarkdown(c, "x", "y"), /nothing was recalculated/);
});

test("income and expenses show by year", () => {
  const md = compareMarkdown(compareFigures(data([], COMPUTED, 10), data([], LATER, 12.5)), "x", "y");
  assert.match(md, /\| \+2\.50 \| 0\.00 \|/);
});

test("runCompare writes its report beside the figures, and reads files by name", async () => {
  const dir = stateDir();
  const first = await run(dir);
  const second = await run(dir, { status: [`success|${LATER}`] });
  const name = (f: string) => f.split("/").at(-1)?.replace(".json", "") as string;
  const written = runCompare(dir, name(first), name(second));
  assert.match(readFileSync(written, "utf8"), /## Years/);
  assert.equal(readdirSync(join(dir, "figures")).length, 3);
  assert.throws(() => runCompare(dir, "nope", name(second)), /no figures file/);
});

test("apply's note names a state with no figures, counts log lines since, and survives a bad file", async () => {
  assert.match(figuresNote(stateDir()), /No figures yet/);
  const dir = stateDir();
  const file = await run(dir);
  writeFileSync(
    join(dir, "apply-log.jsonl"),
    JSON.stringify({ time: "2999-01-01T00:00:00.000Z", call: "skip" }) + "\n",
  );
  assert.match(figuresNote(dir), /1 apply-log lines since/);
  for (const bad of ["", "{", "null"]) {
    writeFileSync(file, bad);
    assert.match(figuresNote(dir), /cannot be read/);
  }
});
