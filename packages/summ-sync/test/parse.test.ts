import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActions, parseDetail, parsePage, parsePageHeader } from "../src/parse.ts";

// Shaped like query_summ_transactions output; every value is made up.
const PAGE = `# Transactions (Page 2 of 3, 2 returned, 502 total)

## 1. transfer
- **Action ID**: \`0000000000000000000000a1\`
- **Tx Hash**: \`2024-01-01T00:00:00.000Z.out.aaaaaaaaaaaa\`
- **Date**: 2024-01-01T00:00:00.000Z
- **Action Category**: transfer
- **From**: Wallet\\_A | rawAddress: wallet-a
- **Outgoing**: 1 RUNE (5.00)

## 2. income [IGNORED] [UNCATEGORISED]
- **Action ID**: \`0000000000000000000000a2\`
- **Tx Hash**: \`example-manual\`
- **Incoming**: 2 RUNE (10.00)

_Use page: 3 to see the next page._
`;

test("parseActions reads each action block", () => {
  const actions = parseActions(PAGE);
  assert.equal(actions.length, 2);
  assert.equal(actions[0]["Action ID"], "0000000000000000000000a1");
  assert.equal(actions[0]["Tx Hash"], "2024-01-01T00:00:00.000Z.out.aaaaaaaaaaaa");
  assert.equal(actions[0].From, "Wallet_A | rawAddress: wallet-a");
  assert.deepEqual(actions[0].tags, []);
  assert.deepEqual(actions[1].tags, ["IGNORED", "UNCATEGORISED"]);
});

test("parseActions ignores text without an action id", () => {
  assert.deepEqual(parseActions("# Transactions (Page 1 of 1, 0 returned, 0 total)\n\nNo transactions found."), []);
});

test("parsePageHeader reads page, pages, returned and total", () => {
  assert.deepEqual(parsePageHeader(PAGE), { page: 2, pages: 3, returned: 2, total: 502 });
  assert.throws(() => parsePageHeader("something else"), /Unexpected page header/);
});

test("parsePage returns the header and the actions of a page that reads whole", () => {
  const { header, actions } = parsePage(PAGE);
  assert.equal(header.total, 502);
  assert.deepEqual(
    actions.map((a) => a["Action ID"]),
    ["0000000000000000000000a1", "0000000000000000000000a2"],
  );
  assert.deepEqual(
    parsePage("# Transactions (Page 1 of 1, 0 returned, 0 total)\n\nNo transactions found.").actions,
    [],
  );
});

test("parsePage stops when Summ's wording changes and fewer actions read than it returned", () => {
  // A renamed field: the block is there, its id is not read
  assert.throws(
    () => parsePage(PAGE.replace("**Action ID**: `0000000000000000000000a2`", "**Id**: `a2`")),
    /1 with an Action ID/,
  );
  // A renamed heading: the block is not seen at all
  assert.throws(() => parsePage(PAGE.replace("## 2. income", "### Action 2: income")), /2 returned; 1 action blocks/);
});

// Shaped like inspect_transaction output; every value is made up.
const DETAIL = `# Transaction Detail: \`0000000000000000000000a1\`

\`\`\`json
{
  "_id": "0000000000000000000000a1",
  "ids": ["2024-01-01T00:00:00.000Z.out.aaaaaaaaaaaa"],
  "type": "transfer",
  "outgoing": [{ "_id": "00000000000000000000b001", "id": "2024-01-01T00:00:00.000Z.out.aaaaaaaaaaaa", "trade": "withdrawal", "quantity": 1 }]
}
\`\`\`

## Cost Basis Breakdown

\`\`\`json
{ "00000000000000000000b001": { "breakdown": [] } }
\`\`\`

## Change History

1 Jan 2024 10:00 · user (original)
2 Jan 2024 11:00 · user · Quantity: 2 → 1

---
_Applied to: your account (self)_
`;

test("parseDetail returns the action JSON and the change history", () => {
  const { action, history } = parseDetail(DETAIL);
  assert.equal(action._id, "0000000000000000000000a1");
  assert.equal((action.outgoing as { _id: string }[])[0]._id, "00000000000000000000b001");
  assert.deepEqual(history, ["1 Jan 2024 10:00 · user (original)", "2 Jan 2024 11:00 · user · Quantity: 2 → 1"]);
});

test("parseDetail with no change history section gives an empty history", () => {
  const { history } = parseDetail('```json\n{"_id":"x"}\n```\n');
  assert.deepEqual(history, []);
});

test("parseDetail stops on a renamed history heading, which would hide the user's edits", () => {
  assert.throws(() => parseDetail(DETAIL.replace("## Change History", "## Edit History")), /history heading/);
});

test("parseDetail stops on a change history of another shape, and keeps a value's second line", () => {
  assert.throws(
    () => parseDetail(DETAIL.replace("1 Jan 2024 10:00 · user (original)", "1 Jan 2024 10:00 - user (original)")),
    /change history line/,
  );
  const { history } = parseDetail(DETAIL.replace("Quantity: 2 → 1", "Comment: a → a\nsecond line"));
  assert.equal(history.length, 3);
});

test("parseDetail stops on action JSON without an _id", () => {
  assert.throws(() => parseDetail('```json\n{"id":"x"}\n```\n'), /no _id/);
});

test("parseDetail refuses text without action JSON", () => {
  assert.throws(() => parseDetail("nothing here"), /no action JSON block/);
  assert.throws(() => parseDetail("```json\n{ not json\n```"), /the action JSON does not parse/);
});
