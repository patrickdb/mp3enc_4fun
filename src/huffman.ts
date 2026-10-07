import type { BitWriter } from './bitwriter.js';
import { PAIR_TABLES, QUAD_TABLES } from './tables/huffman-data.js';

const LINES = 576;
const ESCAPE = 15;
const MAX_REGION0 = 15;
const MAX_REGION1 = 7;
const MAX_SFB_INDEX = 22;

interface PairTableInfo {
  readonly index: number;
  readonly size: number;
  readonly linbits: number;
  /** Largest magnitude the table can express (with escape bits for linbits tables). */
  readonly capacity: number;
  readonly lengths: Uint8Array;
  readonly codes: readonly string[];
}

const TABLES: readonly PairTableInfo[] = PAIR_TABLES.flatMap((t, index) =>
  t
    ? [{
      index, size: t.size, linbits: t.linbits, codes: t.codes,
      capacity: t.linbits > 0 ? ESCAPE + 2 ** t.linbits - 1 : t.size - 1,
      lengths: Uint8Array.from(t.codes, (c) => c.length),
    }]
    : []);
const QUAD_LENGTHS: readonly Uint8Array[] = QUAD_TABLES.map((codes) => Uint8Array.from(codes, (c) => c.length));

export interface SpectrumCoding {
  /** Number of (x, y) pairs coded with the big-value tables. */
  readonly bigValues: number;
  /** Number of quadruples in the count1 region. */
  readonly count1Quads: number;
  readonly region0Count: number;
  readonly region1Count: number;
  readonly tableSelect: readonly [number, number, number];
  readonly count1TableSelect: 0 | 1;
  /** Line index where region 0 ends and where region 1 ends (region 2 ends at bigValues * 2). */
  readonly regionEnds: readonly [number, number];
  /** Total Huffman bits for the spectrum (excludes scale-factor bits). */
  readonly bits: number;
}

/** Splits the spectrum into rzero / count1 / big-value parts: returns [bigValueLines, count1Quads]. */
function partition(ix: Int32Array): [number, number] {
  let end = LINES;
  while (end >= 2 && ix[end - 1] === 0 && ix[end - 2] === 0) end -= 2;
  let quads = 0;
  while (
    end >= 4 &&
    Math.abs(ix[end - 1] ?? 0) <= 1 && Math.abs(ix[end - 2] ?? 0) <= 1 &&
    Math.abs(ix[end - 3] ?? 0) <= 1 && Math.abs(ix[end - 4] ?? 0) <= 1
  ) {
    end -= 4;
    quads++;
  }
  return [end, quads];
}

function count1Bits(ix: Int32Array, from: number, quads: number): [0 | 1, number] {
  let nonzero = 0;
  let a = 0;
  const lengths = QUAD_LENGTHS[0];
  for (let q = 0; q < quads; q++) {
    const i = from + q * 4;
    const v = Math.abs(ix[i] ?? 0);
    const w = Math.abs(ix[i + 1] ?? 0);
    const x = Math.abs(ix[i + 2] ?? 0);
    const y = Math.abs(ix[i + 3] ?? 0);
    nonzero += v + w + x + y;
    a += lengths?.[v * 8 + w * 4 + x * 2 + y] ?? 0;
  }
  const b = quads * 4;
  return a <= b ? [0, a + nonzero] : [1, b + nonzero];
}

const byIndex = (n: number): PairTableInfo => {
  const t = TABLES.find((x) => x.index === n);
  if (!t) throw new Error(`missing Huffman table ${String(n)}`);
  return t;
};

/** Plausible tables for regions whose largest magnitude is 0..15 (the cheaper of each family wins). */
const SMALL_CANDIDATES: readonly (readonly PairTableInfo[])[] = [
  [byIndex(0)],
  [byIndex(1)],
  [byIndex(2), byIndex(3)],
  [byIndex(5), byIndex(6)],
  [byIndex(7), byIndex(8), byIndex(9)],
  [byIndex(7), byIndex(8), byIndex(9)],
  [byIndex(10), byIndex(11), byIndex(12)],
  [byIndex(10), byIndex(11), byIndex(12)],
  ...Array.from({ length: 8 }, () => [byIndex(13), byIndex(15)]),
];
const LINBITS_A = [1, 2, 3, 4, 6, 8, 10, 13]; // tables 16..23
const LINBITS_B = [4, 5, 6, 7, 8, 9, 11, 13]; // tables 24..31
/** ESCAPE_CANDIDATES[l] = the cheapest-linbits table of each escape family able to carry l escape bits. */
const ESCAPE_CANDIDATES: readonly (readonly PairTableInfo[])[] = Array.from({ length: 14 }, (_, l) => [
  byIndex(16 + Math.max(0, LINBITS_A.findIndex((b) => b >= l))),
  byIndex(24 + Math.max(0, LINBITS_B.findIndex((b) => b >= l))),
]);

function candidatesFor(max: number): readonly PairTableInfo[] {
  if (max < SMALL_CANDIDATES.length) return SMALL_CANDIDATES[max] ?? [];
  const escapeBits = 32 - Math.clz32(max - ESCAPE);
  return ESCAPE_CANDIDATES[escapeBits] ?? [];
}

/** Bits to code lines [from, to) with table t (values beyond the table's range are the caller's problem). */
function scanCost(ix: Int32Array, t: PairTableInfo, from: number, to: number): number {
  const { lengths, size, linbits } = t;
  let bits = 0;
  for (let k = from; k < to; k += 2) {
    const x = ix[k] ?? 0;
    const y = ix[k + 1] ?? 0;
    let ax = x < 0 ? -x : x;
    let ay = y < 0 ? -y : y;
    if (linbits > 0) {
      if (ax >= ESCAPE) { bits += linbits; ax = ESCAPE; }
      if (ay >= ESCAPE) { bits += linbits; ay = ESCAPE; }
    }
    bits += (lengths[ax * size + ay] ?? 0) + (ax !== 0 ? 1 : 0) + (ay !== 0 ? 1 : 0);
  }
  return bits;
}

function maxMagnitude(ix: Int32Array, from: number, to: number): number {
  let max = 0;
  for (let k = from; k < to; k++) {
    const a = Math.abs(ix[k] ?? 0);
    if (a > max) max = a;
  }
  return max;
}

const SFB_SLOTS = 23;
const MAX_PAIRS = LINES / 2;
const bounds = new Int32Array(SFB_SLOTS);
const bandMax = new Int32Array(SFB_SLOTS);
/** prefix[t][p] = bits of the first p pairs under table t; built lazily, valid while prefixStamp matches. */
const prefix: Int32Array[] = Array.from({ length: 32 }, () => new Int32Array(MAX_PAIRS + 1));
const prefixStamp = new Uint32Array(32);
const memoCost = new Int32Array(SFB_SLOTS * SFB_SLOTS);
const memoTable = new Uint8Array(SFB_SLOTS * SFB_SLOTS);
const memoStamp = new Uint32Array(SFB_SLOTS * SFB_SLOTS);
let stamp = 0;

function prepare(ix: Int32Array, sfbStarts: readonly number[], bigLines: number): void {
  stamp++;
  for (let k = 0; k < SFB_SLOTS; k++) bounds[k] = Math.min(sfbStarts[Math.min(k, MAX_SFB_INDEX)] ?? LINES, bigLines);
  for (let k = 0; k < MAX_SFB_INDEX; k++) bandMax[k] = maxMagnitude(ix, bounds[k] ?? 0, bounds[k + 1] ?? 0);
}

function prefixFor(ix: Int32Array, t: PairTableInfo, pairs: number): Int32Array {
  const cum = prefix[t.index] ?? new Int32Array(0);
  if (prefixStamp[t.index] === stamp) return cum;
  prefixStamp[t.index] = stamp;
  const { lengths, size, linbits } = t;
  for (let p = 0; p < pairs; p++) {
    const x = ix[2 * p] ?? 0;
    const y = ix[2 * p + 1] ?? 0;
    let ax = x < 0 ? -x : x;
    let ay = y < 0 ? -y : y;
    let bits = 0;
    if (linbits > 0) {
      if (ax >= ESCAPE) { bits += linbits; ax = ESCAPE; }
      if (ay >= ESCAPE) { bits += linbits; ay = ESCAPE; }
    } else {
      // out-of-range values only occur in regions this table is never chosen for
      if (ax >= size) ax = size - 1;
      if (ay >= size) ay = size - 1;
    }
    bits += (lengths[ax * size + ay] ?? 0) + (ax !== 0 ? 1 : 0) + (ay !== 0 ? 1 : 0);
    cum[p + 1] = (cum[p] ?? 0) + bits;
  }
  return cum;
}

/** Cheapest coding of the lines between scale-factor-band bounds i and j; records the table in the memo. */
function regionCost(ix: Int32Array, i: number, j: number, pairs: number): number {
  const slot = i * SFB_SLOTS + j;
  if (memoStamp[slot] === stamp) return memoCost[slot] ?? 0;
  const from = (bounds[i] ?? 0) >> 1;
  const to = (bounds[j] ?? 0) >> 1;
  let max = 0;
  for (let k = i; k < j; k++) max = Math.max(max, bandMax[k] ?? 0);
  let bestCost = 0;
  let bestTable = 0;
  if (from < to && max > 0) {
    bestCost = Infinity;
    for (const t of candidatesFor(max)) {
      const cum = prefixFor(ix, t, pairs);
      const bits = (cum[to] ?? 0) - (cum[from] ?? 0);
      if (bits < bestCost) { bestCost = bits; bestTable = t.index; }
    }
  }
  memoStamp[slot] = stamp;
  memoCost[slot] = bestCost;
  memoTable[slot] = bestTable;
  return bestCost;
}

/** Region split used by the estimator; any fixed split is a valid upper bound of the optimum. */
const ESTIMATE_REGION0 = 6;
const ESTIMATE_REGION1 = 4;

/**
 * Cheap upper bound of analyzeSpectrum().bits: one fixed region split instead of a search.
 * Used to steer the quantiser search; the exact analysis then confirms the final choice.
 */
export function estimateSpectrumBits(ix: Int32Array, sfbStarts: readonly number[]): number {
  const [bigLines, count1Quads] = partition(ix);
  const count1 = count1Bits(ix, bigLines, count1Quads)[1];
  if (bigLines === 0) return count1;
  const e0 = Math.min(sfbStarts[ESTIMATE_REGION0 + 1] ?? LINES, bigLines);
  const e1 = Math.min(sfbStarts[ESTIMATE_REGION0 + ESTIMATE_REGION1 + 2] ?? LINES, bigLines);
  let bits = count1;
  const spans: [number, number][] = [[0, e0], [e0, e1], [e1, bigLines]];
  for (const [from, to] of spans) {
    const max = from < to ? maxMagnitude(ix, from, to) : 0;
    if (max === 0) continue;
    let best = Infinity;
    for (const t of candidatesFor(max)) best = Math.min(best, scanCost(ix, t, from, to));
    bits += best;
  }
  return bits;
}

/** Chooses the cheapest legal Huffman layout (regions and tables) for a quantised spectrum. */
export function analyzeSpectrum(ix: Int32Array, sfbStarts: readonly number[]): SpectrumCoding {
  const [bigLines, count1Quads] = partition(ix);
  const [count1TableSelect, count1Cost] = count1Bits(ix, bigLines, count1Quads);
  const pairs = bigLines >> 1;
  if (pairs === 0) {
    return {
      bigValues: 0, count1Quads, region0Count: 0, region1Count: 0, tableSelect: [0, 0, 0],
      count1TableSelect, regionEnds: [0, 0], bits: count1Cost,
    };
  }
  prepare(ix, sfbStarts, bigLines);

  let bestTotal = Infinity;
  let r0Best = 0;
  let r1Best = 0;
  for (let r0 = 0; r0 <= MAX_REGION0; r0++) {
    const i1 = r0 + 1;
    const first = regionCost(ix, 0, i1, pairs);
    for (let r1 = 0; r1 <= MAX_REGION1; r1++) {
      const i2 = Math.min(r0 + r1 + 2, MAX_SFB_INDEX);
      const total = first + regionCost(ix, i1, i2, pairs) + regionCost(ix, i2, MAX_SFB_INDEX, pairs);
      if (total < bestTotal) {
        bestTotal = total;
        r0Best = r0;
        r1Best = r1;
      }
    }
  }
  const i1 = r0Best + 1;
  const i2 = Math.min(r0Best + r1Best + 2, MAX_SFB_INDEX);
  return {
    bigValues: pairs,
    count1Quads,
    region0Count: r0Best,
    region1Count: r1Best,
    tableSelect: [
      memoTable[0 * SFB_SLOTS + i1] ?? 0,
      memoTable[i1 * SFB_SLOTS + i2] ?? 0,
      memoTable[i2 * SFB_SLOTS + MAX_SFB_INDEX] ?? 0,
    ],
    count1TableSelect,
    regionEnds: [bounds[i1] ?? 0, bounds[i2] ?? 0],
    bits: bestTotal + count1Cost,
  };
}

function writePair(w: BitWriter, t: PairTableInfo, x: number, y: number): void {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const cx = t.linbits > 0 ? Math.min(ax, ESCAPE) : ax;
  const cy = t.linbits > 0 ? Math.min(ay, ESCAPE) : ay;
  w.writeCode(t.codes[cx * t.size + cy] ?? '');
  if (t.linbits > 0 && ax >= ESCAPE) w.writeBits(ax - ESCAPE, t.linbits);
  if (ax !== 0) w.writeBits(x < 0 ? 1 : 0, 1);
  if (t.linbits > 0 && ay >= ESCAPE) w.writeBits(ay - ESCAPE, t.linbits);
  if (ay !== 0) w.writeBits(y < 0 ? 1 : 0, 1);
}

export function writeSpectrum(w: BitWriter, ix: Int32Array, coding: SpectrumCoding): void {
  const end = coding.bigValues * 2;
  const bounds = [0, coding.regionEnds[0], coding.regionEnds[1], end];
  for (let region = 0; region < 3; region++) {
    const table = TABLES.find((t) => t.index === coding.tableSelect[region]);
    if (!table) continue;
    for (let i = bounds[region] ?? 0; i < (bounds[region + 1] ?? 0); i += 2) {
      writePair(w, table, ix[i] ?? 0, ix[i + 1] ?? 0);
    }
  }
  const quadCodes = QUAD_TABLES[coding.count1TableSelect] ?? [];
  for (let q = 0; q < coding.count1Quads; q++) {
    const i = end + q * 4;
    const v = ix[i] ?? 0;
    const x = ix[i + 1] ?? 0;
    const y = ix[i + 2] ?? 0;
    const z = ix[i + 3] ?? 0;
    const code = Math.abs(v) * 8 + Math.abs(x) * 4 + Math.abs(y) * 2 + Math.abs(z);
    w.writeCode(quadCodes[code] ?? '');
    for (const s of [v, x, y, z]) if (s !== 0) w.writeBits(s < 0 ? 1 : 0, 1);
  }
}
