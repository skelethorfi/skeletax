// Keccak-256 as Ethereum uses it (the original Keccak padding, not NIST SHA3-256, which node:crypto has instead).
// Only for EIP-55 address checksums (src/utils/Address.ts), so it favours clarity over speed: 64-bit lanes as BigInt.

const MASK = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
// Rotation offsets by lane [x][y]
const ROTATIONS = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];
const RATE = 136; // bytes: 1600-bit state less a 512-bit capacity

const rotate = (lane: bigint, n: bigint) => (n === 0n ? lane : ((lane << n) | (lane >> (64n - n))) & MASK);

// The Keccak-f[1600] permutation; state[x][y] is the lane at column x, row y
function permute(state: bigint[][]): bigint[][] {
  let a = state;

  for (const roundConstant of ROUND_CONSTANTS) {
    const c = a.map((column) => column[0] ^ column[1] ^ column[2] ^ column[3] ^ column[4]);
    const d = c.map((_, x) => c[(x + 4) % 5] ^ rotate(c[(x + 1) % 5], 1n));
    a = a.map((column, x) => column.map((lane) => lane ^ d[x]));

    const b = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y][(2 * x + 3 * y) % 5] = rotate(a[x][y], ROTATIONS[x][y]);
      }
    }

    a = b.map((column, x) => column.map((lane, y) => lane ^ (~b[(x + 1) % 5][y] & MASK & b[(x + 2) % 5][y])));
    a[0][0] ^= roundConstant;
  }

  return a;
}

export function keccak256(data: Uint8Array): Uint8Array {
  const length = Math.ceil((data.length + 1) / RATE) * RATE;
  const padded = new Uint8Array(length);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[length - 1] ^= 0x80;

  let state = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
  const view = new DataView(padded.buffer);

  for (let offset = 0; offset < length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      state[i % 5][Math.floor(i / 5)] ^= view.getBigUint64(offset + 8 * i, true);
    }
    state = permute(state);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    outView.setBigUint64(8 * i, state[i % 5][Math.floor(i / 5)], true);
  }
  return out;
}
