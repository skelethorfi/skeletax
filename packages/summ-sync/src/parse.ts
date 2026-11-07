// Parsers for the Markdown that Summ's MCP tools return.

/** One action of a query_summ_transactions page: its tags and "Key: value" fields. */
export interface ListedAction {
  tags: string[];
  "Action ID"?: string;
  [field: string]: string | string[] | undefined;
}

export interface PageHeader {
  page: number;
  pages: number;
  returned: number;
  total: number;
}

/** The action JSON of inspect_transaction (only the fields the sync reads are typed). */
export interface SummAction {
  _id: string;
  ids?: string[];
  type?: string;
  [field: string]: unknown;
}

export interface ActionDetail {
  action: SummAction;
  history: string[];
}

/**
 * query_summ_transactions: one "## n. <category> [TAGS]" block per action,
 * then "- **Key**: value" lines. Returns one object per action.
 */
export function parseActions(markdown: string): ListedAction[] {
  return markdown
    .split(/^## \d+\. /m)
    .slice(1)
    .map((block) => {
      const [head, ...lines] = block.split("\n");
      const action: ListedAction = { tags: [...head.matchAll(/\[([A-Z_ ]+)\]/g)].map((m) => m[1]) };
      for (const line of lines) {
        const m = line.match(/^- \*\*(.+?)\*\*: (.*)$/);
        if (m) action[m[1]] = m[2].replace(/^`|`$/g, "").replace(/\\_/g, "_");
      }
      return action;
    })
    .filter((a) => a["Action ID"]);
}

/** An answer of Summ's that no longer reads as the sync expects: its wording changed, and summ-sync needs an update. */
export class FormatChanged extends Error {
  constructor(tool: string, what: string, markdown: string) {
    super(
      `${tool}: Summ's answer no longer reads as summ-sync expects (${what}). Its wording may have changed, so ` +
        `summ-sync stops rather than read part of it; it needs an update. The answer began: ${JSON.stringify(markdown.slice(0, 200))}`,
    );
  }
}

/**
 * A query_summ_transactions page, checked whole: every "## n." block an action with an id, and as many as the header
 * says it returned. A page that parses to fewer actions than Summ sent stops here, instead of shrinking the snapshot.
 */
export function parsePage(markdown: string): { header: PageHeader; actions: ListedAction[] } {
  const header = parsePageHeader(markdown);
  const blocks = markdown.split(/^## \d+\. /m).length - 1;
  const actions = parseActions(markdown);
  if (blocks !== header.returned || actions.length !== blocks)
    throw new FormatChanged(
      "query_summ_transactions",
      `page ${header.page} says ${header.returned} returned; ${blocks} action blocks found, ${actions.length} with an Action ID`,
      markdown,
    );
  return { header, actions };
}

/** query_summ_transactions page header: "(Page 2 of 5, 250 returned, 1100 total)". */
export function parsePageHeader(markdown: string): PageHeader {
  const m = markdown.match(/Page (\d+) of (\d+), (\d+) returned, (\d+) total/);
  if (!m) throw new Error(`Unexpected page header: ${markdown.slice(0, 200)}`);
  const [page, pages, returned, total] = m.slice(1).map(Number);
  return { page, pages, returned, total };
}

/** Summ's answer to inspect_transaction for a transaction id it does not hold, for this very id. Any other failure, a
 * gateway's 404 too, is a failed read, which says nothing of the leg. */
export const isLegAbsent = (message: string, legId: string): boolean =>
  message.startsWith(`inspect_transaction: Transaction '${legId}' was not found`);

/**
 * inspect_transaction: the action's JSON (the first ```json block) and the
 * "## Change History" lines ("<date> · <who> · <what changed>").
 */
export function parseDetail(markdown: string): ActionDetail {
  const json = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!json) throw new Error(`No action JSON in: ${markdown.slice(0, 200)}`);
  const action = JSON.parse(json[1]);
  if (typeof action?._id !== "string")
    throw new FormatChanged("inspect_transaction", "no _id in the action JSON", markdown);
  const section = markdown.split(/^## Change History\s*$/m)[1];
  // A renamed heading would read as an action nobody edited, hiding the user's edits from plan
  if (section === undefined && /^#+ .*\bhistory\b/im.test(markdown))
    throw new FormatChanged("inspect_transaction", 'a history heading other than "## Change History"', markdown);
  const history = (section ?? "")
    .split(/^(?:---|## )/m)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Checked on the first line only: a later line can be the rest of a value that holds a line break
  if (history.length && !history[0].includes(" · "))
    throw new FormatChanged(
      "inspect_transaction",
      `a change history line without " · ": ${JSON.stringify(history[0])}`,
      markdown,
    );
  return { action, history };
}
