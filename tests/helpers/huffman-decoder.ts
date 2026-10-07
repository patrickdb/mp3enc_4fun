import { PAIR_TABLES, QUAD_TABLES } from '../../src/tables/huffman-data.js';

/** Test-side Huffman decoder following ISO/IEC 11172-3 clause 2.4.3.4.7, used to round-trip the encoder. */
export interface DecodeParams {
  readonly bigValues: number;
  readonly count1Quads: number;
  readonly region0Count: number;
  readonly region1Count: number;
  readonly tableSelect: readonly number[];
  readonly count1TableSelect: number;
}

class BitReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  bit(): number {
    const b = ((this.bytes[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
}

function lookup(codes: readonly string[]): Map<string, number> {
  return new Map(codes.map((c, i) => [c, i]));
}

function readCode(r: BitReader, map: Map<string, number>): number {
  let code = '';
  for (let i = 0; i < 40; i++) {
    code += String(r.bit());
    const hit = map.get(code);
    if (hit !== undefined) return hit;
  }
  throw new Error('no matching Huffman code');
}

const pairMaps = PAIR_TABLES.map((t) => (t ? lookup(t.codes) : undefined));
const quadMaps = QUAD_TABLES.map((codes) => lookup(codes));

/** Reads one (x, y) pair with its escape bits and signs. */
function readPair(r: BitReader, tableNo: number): [number, number] {
  const table = PAIR_TABLES[tableNo];
  const map = pairMaps[tableNo];
  if (!table || !map) throw new Error(`table ${String(tableNo)} does not exist`);
  const idx = readCode(r, map);
  let x = Math.floor(idx / table.size);
  let y = idx % table.size;
  const max = table.size - 1;
  if (table.linbits > 0 && x === max) x += r.bits(table.linbits);
  if (x !== 0 && r.bit() === 1) x = -x;
  if (table.linbits > 0 && y === max) y += r.bits(table.linbits);
  if (y !== 0 && r.bit() === 1) y = -y;
  return [x, y];
}

function readQuad(r: BitReader, tableNo: number, out: Int32Array, at: number): void {
  const idx = readCode(r, quadMaps[tableNo] ?? new Map<string, number>());
  for (let j = 0; j < 4; j++) {
    const bit = (idx >> (3 - j)) & 1;
    out[at + j] = bit !== 0 && r.bit() === 1 ? -1 : bit;
  }
}

export function decodeSpectrum(bytes: Uint8Array, p: DecodeParams, sfb: readonly number[]): Int32Array {
  const r = new BitReader(bytes);
  const out = new Int32Array(576);
  const end = p.bigValues * 2;
  const e0 = Math.min(sfb[p.region0Count + 1] ?? 576, end);
  const e1 = Math.min(sfb[Math.min(p.region0Count + p.region1Count + 2, 22)] ?? 576, end);
  const bounds = [0, e0, e1, end];
  for (let region = 0; region < 3; region++) {
    const tableNo = p.tableSelect[region] ?? 0;
    if (tableNo === 0) continue; // table 0 carries no bits
    for (let i = bounds[region] ?? 0; i < (bounds[region + 1] ?? 0); i += 2) {
      [out[i], out[i + 1]] = readPair(r, tableNo);
    }
  }
  for (let q = 0; q < p.count1Quads; q++) readQuad(r, p.count1TableSelect, out, end + q * 4);
  return out;
}
