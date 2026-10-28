import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "../src/utils/Keccak.ts";
import { checksumAddress } from "../src/utils/Address.ts";

const hex = (text: string) => Buffer.from(keccak256(Buffer.from(text, "utf8"))).toString("hex");

describe("Keccak-256 and EIP-55 checksums", () => {
  test("Keccak-256 (Ethereum's padding, not SHA3-256)", () => {
    assert.equal(hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    assert.equal(
      hex("The quick brown fox jumps over the lazy dog"),
      "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
    );
    // more than one 136-byte block (checked against a separate implementation)
    assert.equal(hex("a".repeat(200)), "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
  });

  test("the EIP-55 test vectors, from any case", () => {
    for (const address of [
      "0x52908400098527886E0F7030069857D2E4169EE7",
      "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
      "0xde709f2102306220921060314715629080e2fb77",
      "0x27b1fdb04752bbc536007a920d24acb045561c26",
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      assert.equal(checksumAddress(address.toLowerCase()), address);
      assert.equal(checksumAddress("0x" + address.slice(2).toUpperCase()), address);
    }
  });
});
