import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { RecordStore } from "../src/sources/store/RecordStore.ts";
import { MidgardService, midgardAddress } from "../src/sources/thorchain/MidgardService.ts";

describe("Midgard address (case)", () => {
  test("an EVM address is queried lowercase; other formats as given", () => {
    assert.equal(
      midgardAddress("0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c"),
      "0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c",
    );
    assert.equal(midgardAddress("DPHTBAzM8gUZaTDgTGJS8BbgoEx6aLRoZB"), "DPHTBAzM8gUZaTDgTGJS8BbgoEx6aLRoZB");
    assert.equal(
      midgardAddress("thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt"),
      "thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt",
    );
    assert.equal(midgardAddress("0x5A0b54"), "0x5A0b54");
  });

  test("a checksummed wallet's actions are fetched with its lowercase address", async () => {
    const midgard = new MidgardService(
      new RecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "tc-ct-midgard-address-"))),
      "midgard",
      "https://midgard",
    );
    const getActions = mock.method(
      midgard.api,
      "getActions",
      async () => ({ data: { count: "0", actions: [] } }) as any,
    );

    await midgard.getActions("0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c");
    assert.equal(getActions.mock.calls[0].arguments[0], "0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c");
  });
});
