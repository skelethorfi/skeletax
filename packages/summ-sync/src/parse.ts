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
  const history = (markdown.split(/^## Change History\s*$/m)[1] ?? "")
    .split(/^(?:---|## )/m)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { action: JSON.parse(json[1]), history };
}
