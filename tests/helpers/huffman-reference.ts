import { PAIR_TABLES, QUAD_TABLES } from '../../src/tables/huffman-data.js';

const ESCAPE = 15;

/** Bits for one pair under a table, or Infinity if a value does not fit. */
function pairBits(t: NonNullable<(typeof PAIR_TABLES)[number]>, x: number, y: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const capacity = t.linbits > 0 ? ESCAPE + 2 ** t.linbits - 1 : t.size - 1;
  if (ax > capacity || ay > capacity) return Infinity;
  const cx = t.linbits > 0 ? Math.min(ax, ESCAPE) : ax;
  const cy = t.linbits > 0 ? Math.min(ay, ESCAPE) : ay;
  const escapes = t.linbits > 0 ? (ax >= ESCAPE ? t.linbits : 0) + (ay >= ESCAPE ? t.linbits : 0) : 0;
  return (t.codes[cx * t.size + cy]?.length ?? 0) + (ax !== 0 ? 1 : 0) + (ay !== 0 ? 1 : 0) + escapes;
}

/** Brute-force reference: the cheapest Huffman bit count over every table and every region split. */
export function exhaustiveBits(ix: Int32Array, sfb: readonly number[]): number {
  let end = 576;
  while (end >= 2 && ix[end - 1] === 0 && ix[end - 2] === 0) end -= 2;
  let quads = 0;
  while (end >= 4 && [1, 2, 3, 4].every((k) => Math.abs(ix[end - k] ?? 0) <= 1)) { end -= 4; quads++; }
  const quadCost = (table: number): number => {
    let bits = 0;
    for (let q = 0; q < quads; q++) {
      const v = [0, 1, 2, 3].map((k) => Math.abs(ix[end + q * 4 + k] ?? 0));
      bits += table === 0 ? (QUAD_TABLES[0]?.[(v[0] ?? 0) * 8 + (v[1] ?? 0) * 4 + (v[2] ?? 0) * 2 + (v[3] ?? 0)]?.length ?? 0) : 4;
      bits += v.reduce((a, b) => a + b, 0);
    }
    return bits;
  };
  const count1 = Math.min(quadCost(0), quadCost(1));
  const regionCost = (from: number, to: number): number => {
    let best = Infinity;
    for (const t of PAIR_TABLES) {
      if (!t) continue;
      let bits = 0;
      for (let i = from; i < to && bits < best; i += 2) bits += pairBits(t, ix[i] ?? 0, ix[i + 1] ?? 0);
      best = Math.min(best, bits);
    }
    return best;
  };
  let best = Infinity;
  for (let r0 = 0; r0 <= 15; r0++) {
    for (let r1 = 0; r1 <= 7; r1++) {
      const e0 = Math.min(sfb[Math.min(r0 + 1, 22)] ?? 576, end);
      const e1 = Math.min(sfb[Math.min(r0 + r1 + 2, 22)] ?? 576, end);
      best = Math.min(best, regionCost(0, e0) + regionCost(e0, e1) + regionCost(e1, end));
    }
  }
  return (end === 0 ? 0 : best) + count1;
}
