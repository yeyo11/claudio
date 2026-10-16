import assert from 'node:assert/strict';
import test from 'node:test';
import { alignmentPositions, dataCodewords, encodeQr, formatBits, MAX_QR_VERSION, reedSolomon, versionBits } from '../src/lib/qr.ts';

// The QR encoder of docs/plans/collaborators.md §8: byte mode, level M, versions 1 to 40. Every code
// is read back by a decoder written from the standard's tables, not from the encoder's layout code,
// so a module drawn in the wrong place fails the Reed-Solomon check of its block.

// ISO/IEC 18004 Annex E: the alignment centres of the versions read back below
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  7: [6, 22, 38],
  10: [6, 28, 50],
  15: [6, 26, 48, 70],
  25: [6, 32, 58, 84, 110],
  32: [6, 34, 60, 86, 112, 138],
  40: [6, 30, 58, 86, 114, 142, 170],
};
// Table 9, level M: error correction codewords per block, and the number of blocks
const BLOCKS_M: Record<number, [number, number]> = {
  1: [10, 1],
  2: [16, 1],
  7: [18, 4],
  10: [26, 5],
  15: [24, 10],
  25: [28, 21],
  32: [28, 33],
  40: [28, 49],
};

const MASKS = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Reads a code back: unmask, walk the zigzag, de-interleave, check every block, parse byte mode. */
function decode(modules: boolean[][]): string {
  const size = modules.length;
  const version = (size - 17) / 4;
  const align = ALIGNMENT[version];
  const blocks = BLOCKS_M[version];
  assert.ok(align && blocks, `no table for version ${version}`);
  const last = align.length - 1;
  const inAlignment = (x: number, y: number) =>
    align.some((cx, i) =>
      align.some((cy, j) => !((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) && Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2),
    );
  const reserved = (x: number, y: number) =>
    (x < 9 && y < 9) ||
    (x >= size - 8 && y < 9) ||
    (x < 9 && y >= size - 8) ||
    x === 6 ||
    y === 6 ||
    inAlignment(x, y) ||
    (version >= 7 && ((x >= size - 11 && x < size - 8 && y < 6) || (y >= size - 11 && y < size - 8 && x < 6)));

  let format = 0;
  for (let i = 0; i <= 5; i++) format |= (modules[i]?.[8] ? 1 : 0) << i;
  format |= (modules[7]?.[8] ? 1 : 0) << 6;
  format |= (modules[8]?.[8] ? 1 : 0) << 7;
  format |= (modules[8]?.[7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) format |= (modules[8]?.[14 - i] ? 1 : 0) << i;
  format ^= 0x5412;
  assert.equal(format >>> 13, 0, 'level M');
  const mask = (format >>> 10) & 7;

  const stream: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (reserved(x, y)) continue;
        stream.push((modules[y]?.[x] ? 1 : 0) ^ (MASKS[mask]?.(x, y) ? 1 : 0));
      }
    }
  }
  const byteAt = (bits: readonly number[], i: number) => bits.slice(i * 8, i * 8 + 8).reduce((acc, bit) => (acc << 1) | bit, 0);
  const raw = Math.floor(stream.length / 8);
  const codewords = Array.from({ length: raw }, (_, i) => byteAt(stream, i));

  const [ecc, count] = blocks;
  const short = count - (raw % count);
  const shortData = Math.floor(raw / count) - ecc;
  const lengths = Array.from({ length: count }, (_, i) => shortData + (i < short ? 0 : 1));
  const data: number[][] = lengths.map(() => []);
  let at = 0;
  for (let i = 0; i <= shortData; i++) {
    lengths.forEach((length, b) => {
      if (i < length) data[b]?.push(codewords[at++] ?? 0);
    });
  }
  data.forEach((block, b) => {
    const check = Array.from({ length: ecc }, (_, i) => codewords[at + i * count + b] ?? 0);
    assert.deepEqual(check, reedSolomon(block, ecc), `block ${b} of version ${version}`);
  });

  const bits = data.flat().flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  const read = (from: number, length: number) => bits.slice(from, from + length).reduce((acc, bit) => acc * 2 + bit, 0);
  assert.equal(read(0, 4), 0b0100, 'byte mode');
  const countBits = version <= 9 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = Array.from({ length }, (_, i) => read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

test('the error correction matches the standard worked example', () => {
  // "HELLO WORLD" at 1-M, from the standard's own walk-through of the Reed-Solomon step
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('the format and version information are the values of the standard tables', () => {
  assert.equal(formatBits(0).toString(2).padStart(15, '0'), '101010000010010');
  assert.equal(formatBits(5).toString(2).padStart(15, '0'), '100000011001110');
  // Annex D
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(21), 0x15683);
  assert.equal(versionBits(40), 0x28c69);
});

test('the alignment centres follow Annex E, version 32 included', () => {
  for (const [version, centres] of Object.entries(ALIGNMENT)) assert.deepEqual(alignmentPositions(Number(version)), centres, version);
  assert.deepEqual(alignmentPositions(36), [6, 24, 50, 76, 102, 128, 154]);
});

test('the byte capacity at level M is the standard figure at both ends', () => {
  // Table 7: 14 bytes in version 1, 2,331 in version 40
  assert.equal(dataCodewords(1), 16);
  assert.equal(dataCodewords(40), 2334);
  assert.equal(encodeQr('x'.repeat(14))?.version, 1);
  assert.equal(encodeQr('x'.repeat(15))?.version, 2);
  assert.equal(encodeQr('x'.repeat(213))?.version, 10);
  assert.equal(encodeQr('x'.repeat(2331))?.version, MAX_QR_VERSION);
  assert.equal(encodeQr('x'.repeat(2332)), null);
});

test('a caller can cap the version, and a text that does not fit gets no code', () => {
  assert.equal(encodeQr('x'.repeat(214), 10), null);
  assert.equal(encodeQr('x'.repeat(214), 11)?.version, 11);
  assert.equal(encodeQr('x', 0)?.version, 1);
});

test('codes of every size read back as their text', () => {
  const samples = [
    'claudio',
    'https://claudio-test.tail0000.ts.net:8443',
    // An invite: a ticket, the group, the owner and a one-time secret, about what the API hands out
    `claudio-invite:${'a1b2c3d4e5f6'.repeat(40)}`,
    'ñ · 漢字 · ✓ '.repeat(30),
    'z'.repeat(1200),
    'q'.repeat(2331),
  ];
  for (const text of samples) {
    const qr = encodeQr(text);
    assert.ok(qr, text.slice(0, 20));
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.modules.length, qr.size);
    if (!(qr.version in BLOCKS_M)) continue;
    assert.equal(decode(qr.modules), text, `version ${qr.version}`);
  }
  // Pinned to the versions the decoder has tables for, so each one is really read back
  const versions = [1, 2, 7, 10, 15, 25, 32, 40];
  for (const version of versions) {
    const length = dataCodewords(version) - (version <= 9 ? 2 : 3);
    const text = Array.from({ length }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('');
    const qr = encodeQr(text);
    assert.equal(qr?.version, version, `${length} bytes`);
    assert.equal(decode(qr.modules), text, `version ${version}`);
  }
});

test('the finders, the timing lines and the dark module are where the standard puts them', () => {
  const qr = encodeQr('x'.repeat(1000));
  assert.ok(qr);
  const at = (x: number, y: number) => qr.modules[y]?.[x] === true;
  for (const [ox, oy] of [
    [0, 0],
    [qr.size - 7, 0],
    [0, qr.size - 7],
  ] as const) {
    for (let i = 0; i < 7; i++) assert.ok(at(ox + i, oy) && at(ox, oy + i) && at(ox + 6, oy + i) && at(ox + i, oy + 6));
    assert.ok(at(ox + 3, oy + 3));
  }
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(at(i, 6), i % 2 === 0);
    assert.equal(at(6, i), i % 2 === 0);
  }
  assert.ok(at(8, qr.size - 8), 'the dark module');
});
