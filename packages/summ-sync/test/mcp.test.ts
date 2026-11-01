import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, READ_TOOLS } from "../src/mcp.ts";

test("a client refuses tools it was not created with, before any request", async () => {
  const client = new McpClient("/nonexistent");
  await assert.rejects(client.callTool("bulk_edit_transactions", {}), /Refusing to call/);
});

test("the default tools are read-only", () => {
  assert.deepEqual(READ_TOOLS, [
    "query_summ_transactions",
    "inspect_transaction",
    "get_filter_options",
    "get_tax_report",
    "summ_get_latest_portfolio_computation",
  ]);
});

test("a read is retried once after a server error; a write and a client error are not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "summ-sync-"));
  writeFileSync(
    join(dir, ".auth.json"),
    JSON.stringify({ client_id: "c", scope: "mcp:read", access_token: "t", expires_at: Date.now() + 3_600_000 }),
  );
  let statuses: number[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    const status = statuses.shift() ?? 200;
    const { id } = JSON.parse(String(init.body));
    const body =
      status === 200
        ? JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } })
        : "gateway timeout";
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  const client = new McpClient(dir, [...READ_TOOLS, "edit_transaction"], { retryMs: 0 });
  const run = async (tool: string, s: number[]) => {
    statuses = s;
    calls = 0;
    const result = await client.callTool(tool, {}).catch((e: Error) => e.message);
    return [result, calls];
  };
  assert.deepEqual(await run("inspect_transaction", [504]), ["ok", 2]);
  assert.deepEqual(await run("inspect_transaction", [504, 502]), ["tools/call -> 502 gateway timeout", 2]);
  assert.deepEqual(await run("inspect_transaction", [404]), ["tools/call -> 404 gateway timeout", 1]);
  assert.deepEqual(await run("edit_transaction", [504]), ["tools/call -> 504 gateway timeout", 1]);
});
