// Summ as a fake MCP server, in its real wording: the tests' only Summ. Every value is made up.
//
// It keeps action ids across an edit or rebuilds them; its search can lag; a write can fail after it lands; a split can
// take its time. Its step counter ticks on every tool call and, through tick(), on every durable file operation:
// at step n the process dies (everything after throws Died), or a user edit lands.

import type { ToolCaller } from "../src/apply.ts";

export interface FakeLeg {
  price?: number;
  priceValueCurrency?: string;
  updatedAt?: string;
  _id: string;
  trade: string;
  quantity: string;
  timestamp?: string;
  id?: string;
  importType?: string;
  side?: "incoming" | "outgoing" | "fees";
  currencyIdentifier?: { symbol?: string; source?: string };
  from?: string;
  to?: string;
  blockchain?: string;
  description?: string;
  source?: string;
}

export class Died extends Error {
  constructor() {
    super("the process died");
  }
}

export class FakeSumm implements ToolCaller {
  actions = new Map<string, FakeLeg[]>();
  calls: { name: string; args: Record<string, unknown> }[] = [];
  /** Legs written, in order: an edit's legs and a bulk call's. */
  writes: { kind: "edit" | "ignore" | "delete"; legs: string[] }[] = [];
  splits = true;
  /** An edit keeps the action's id, as under a paused computation. */
  paused = false;
  /** So many searches after a write still show the state before it. */
  searchLag = 0;
  /** So many reads after an ignore edit before Summ moves the leg to an action of its own. */
  splitDelay = 0;
  /** The nth write (1 on) lands, and the call then fails; "all": every write does. */
  failAfterWrite: number | "all" | null = null;
  /** The nth write (1 on) fails and does not land. */
  failBeforeWrite: number | null = null;
  /** A batch of Summ's own at every step. */
  batchEveryStep = false;
  dieAt: number | null = null;
  userEdits = new Map<number, (summ: FakeSumm) => void>();
  history = new Map<string, string[]>();
  steps = 0;
  dead = false;
  /** Local currency per USD: Summ converts a price given in USD at its own rate. */
  usdRate = 1;
  /** The step of each write and read, for a test to find when a leg was last read before its write. */
  trace: { step: number; name: string; legs: string[] }[] = [];
  private n = 0;
  private clock = 0;
  private writeCount = 0;
  private pendingSplits: { due: number; action: string; legs: FakeLeg[] }[] = [];
  private searchView: { left: number; ids: [string, string[]][] } | null = null;

  add(actionId: string, legs: FakeLeg[]) {
    this.actions.set(actionId, legs);
  }

  /** One step of the world: a tool call or a durable file operation. */
  tick = (_what = "") => {
    if (this.dead) throw new Died();
    this.steps++;
    if (this.batchEveryStep) this.batch();
    this.userEdits.get(this.steps)?.(this);
    if (this.steps === this.dieAt) {
      this.dead = true;
      throw new Died();
    }
  };

  /** One of Summ's own batches: every leg's updatedAt moves, with no write. */
  batch() {
    for (const legs of this.actions.values()) for (const l of legs) this.stamp(l);
  }

  /** Dead no longer: a new process, on the same Summ. Steps go on counting. */
  restart() {
    this.dead = false;
  }

  /** A recalculation: every action id changes, nothing else. */
  recalculate() {
    this.actions = new Map([...this.actions].map(([, legs]) => [`recalc${++this.n}`, legs]));
  }

  holder(legId: string): [string, FakeLeg[]] | undefined {
    return [...this.actions].find(([, legs]) => legs.some((l) => l._id === legId));
  }

  leg(legId: string): FakeLeg | undefined {
    return this.holder(legId)?.[1].find((l) => l._id === legId);
  }

  /** Summ's state with action ids and times taken out: which legs sit together, holding what. */
  state(): unknown {
    return [...this.actions.values()]
      .map((legs) => legs.map(({ updatedAt: _, ...l }) => JSON.stringify(l)).sort())
      .filter((legs) => legs.length)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }

  private settleSplits() {
    for (const p of this.pendingSplits.filter((s) => --s.due < 0)) {
      this.pendingSplits.splice(this.pendingSplits.indexOf(p), 1);
      const [id, legs] = this.holder(p.legs[0]._id) as [string, FakeLeg[]];
      this.actions.set(
        id,
        legs.filter((l) => !p.legs.includes(l)),
      );
      this.actions.set(p.action, p.legs);
    }
  }

  /** The action as inspect_transaction prints it. */
  render(actionId: string, legs: FakeLeg[]): string {
    const side = (s: string) => legs.filter((l) => (l.side ?? "incoming") === s).map(({ side: _, ...l }) => l);
    const action = { _id: actionId, incoming: side("incoming"), outgoing: side("outgoing"), fees: side("fees") };
    const history = (this.history.get(actionId) ?? []).join("\n");
    return `# Action\n\`\`\`json\n${JSON.stringify(action)}\n\`\`\`\n## Change History\n${history}\n`;
  }

  private stamp(leg: FakeLeg) {
    leg.updatedAt = new Date(Date.UTC(2026, 0, 2, 0, 0, this.clock++)).toISOString();
  }

  /** The write's outcome: `land` makes it; a failing call then throws. */
  private write<T>(land: () => T): T {
    this.writeCount++;
    if (this.failBeforeWrite === this.writeCount) throw new Error("server gone before the write");
    this.searchView = this.searchLag
      ? { left: this.searchLag, ids: [...this.actions].map(([id, legs]) => [id, legs.map((l) => l._id)]) }
      : this.searchView;
    const out = land();
    if (this.failAfterWrite === "all" || this.failAfterWrite === this.writeCount)
      throw new Error("server gone after the write");
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.tick(name);
    this.calls.push({ name, args });
    this.trace.push({
      step: this.steps,
      name,
      legs:
        name === "inspect_transaction"
          ? [String(args.transactionId)]
          : name === "edit_transaction"
            ? (args.edits as { transactionId: string }[]).map((e) => e.transactionId)
            : ((args.actionIds as string[] | undefined)?.flatMap((id) =>
                (this.actions.get(id) ?? []).map((l) => l._id),
              ) ?? []),
    });
    if (name === "query_summ_transactions") {
      const ids = (args.filter as { value: string[] }).value;
      const view: [string, string[]][] = this.searchView
        ? this.searchView.ids
        : [...this.actions].map(([id, legs]) => [id, legs.map((l) => l._id)]);
      if (this.searchView && --this.searchView.left <= 0) this.searchView = null;
      const hits = view.filter(([, legs]) => legs.some((l) => ids.includes(l)));
      return hits.map(([actionId], i) => `## ${i + 1}. Send\n- **Action ID**: \`${actionId}\`\n`).join("\n");
    }
    if (name === "inspect_transaction") {
      this.settleSplits();
      if (args.transactionId) {
        const found = this.holder(args.transactionId as string);
        if (!found)
          throw new Error(
            `inspect_transaction: Transaction '${String(args.transactionId)}' was not found. Use \`query_summ_transactions\` to find current Transaction IDs.`,
          );
        return this.render(found[0], found[1]);
      }
      const legs = this.actions.get(args.actionId as string);
      if (!legs) throw new Error(`inspect_transaction: Action ${String(args.actionId)} was not found`);
      return this.render(args.actionId as string, legs);
    }
    if (name === "edit_transaction") return this.edit(args);
    if (name === "bulk_edit_transactions") return this.bulk(args);
    throw new Error(`unexpected tool ${name}`);
  }

  private edit(args: Record<string, unknown>): string {
    const id = args.actionId as string;
    const changes = args.edits as { transactionId: string; updates: Partial<FakeLeg> }[];
    const legs = this.actions.get(id);
    if (!legs) throw new Error(`edit_transaction: Action ${id} was not found`);
    this.writes.push({ kind: "edit", legs: changes.map((e) => e.transactionId) });
    return this.write(() => {
      for (const { transactionId, updates } of changes) {
        const leg = legs.find((l) => l._id === transactionId) as FakeLeg;
        Object.assign(leg, updates);
        if (updates.priceValueCurrency === "USD") leg.price = (updates.price as number) * this.usdRate;
        this.stamp(leg);
        // Real: a fee leg moves to outgoing when ignored
        if (leg.side === "fees" && leg.trade === "ignoreOut") leg.side = "outgoing";
      }
      // Like Summ: a categorised send no longer pairs with the receive it made up, which is left on its own,
      // and a leg edited to an ignore type moves to an action of its own
      const madeUp = this.splits ? legs.filter((l) => l.importType === "soft-transfer" && l.trade !== "ignoreIn") : [];
      const ignored = legs.filter((l) => l.trade === "ignoreIn" || l.trade === "ignoreOut");
      const moving = this.splits && ignored.length < legs.length ? ignored : [];
      const stays = legs.filter((l) => !madeUp.includes(l) && !moving.includes(l));
      const next = this.paused ? id : `rebuilt${++this.n}`;
      const named = [next];
      this.actions.delete(id);
      if (madeUp.length && stays.length) {
        const alone = `alone${++this.n}`;
        this.actions.set(alone, madeUp);
        named.push(alone);
      }
      const kept = madeUp.length && stays.length ? stays : legs.filter((l) => !moving.includes(l));
      this.actions.set(next, this.splitDelay ? legs : kept);
      if (moving.length) {
        const off = `ignored${++this.n}`;
        if (this.splitDelay) this.pendingSplits.push({ due: this.splitDelay, action: off, legs: moving });
        else this.actions.set(off, moving);
        named.push(off);
      }
      const leg = changes.length === 1 ? "1" : String(changes.length);
      return `Patched ${leg} transaction leg(s).\nRequested Action ID: ${id}\nAffected Action IDs (rebuilt — these replace the requested id): ${named.join(", ")}\nEditing rebuilds actions, so search results can be briefly stale — re-query if the change isn't reflected.\n- **Bulk Edit ID**: \`undo${this.n}abcdef\` (pass to undo_edit to reverse this change).`;
    });
  }

  private bulk(args: Record<string, unknown>): string {
    if (args.filter) throw new Error("a write selected by filter");
    const ids = args.actionIds as string[];
    const legs = ids.flatMap((id) => this.actions.get(id) ?? []);
    if ((args.operation as { type: string }).type === "ignore") {
      this.writes.push({ kind: "ignore", legs: legs.map((l) => l._id) });
      return this.write(() => {
        for (const l of legs) {
          l.trade = "ignoreIn";
          this.stamp(l);
        }
        const named = ids.map((id) => {
          const next = this.paused ? id : `rebuilt${++this.n}`;
          const held = this.actions.get(id) as FakeLeg[];
          this.actions.delete(id);
          this.actions.set(next, held);
          return next;
        });
        return `Bulk ignore updated ${ids.length} action.\nThe changes are saved.\nRequested Action IDs: ${ids.join(", ")}\nAffected Action IDs (rebuilt — these replace the requested ids, and grouping can change the count): ${named.join(", ")}\nBulk Edit ID: ignore${++this.n}abcdef\n`;
      });
    }
    this.writes.push({ kind: "delete", legs: legs.map((l) => l._id) });
    return this.write(() => {
      for (const id of ids) this.actions.delete(id);
      return `Bulk delete removed ${legs.length} transaction ${legs.length === 1 ? "leg" : "legs"}.\nDeletion is permanent — it returns no undo handle and undo_edit cannot reverse it.\nRequested Action IDs: ${ids.join(", ")}\n`;
    });
  }
}
