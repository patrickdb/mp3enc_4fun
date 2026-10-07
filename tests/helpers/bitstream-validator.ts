/**
 * Strict MPEG-1 Layer III bitstream validator, written from the ISO/IEC 11172-3 syntax independently of
 * the encoder. Decoders are lenient; this checks what the standard actually requires, including that
 * every granule's part2_3_length is consumed exactly by its scale factors and Huffman data.
 */
import { BITRATES_KBPS, frameSizeBytes, sideInfoBytes } from '../../src/frame-format.js';
import { PAIR_TABLES, QUAD_TABLES } from '../../src/tables/huffman-data.js';
import { SFB_LONG } from '../../src/tables/sfb-data.js';
import { mainDataStreams, parseFrames, type ParsedFrame } from './mp3-parser.js';

const SLEN: readonly (readonly [number, number])[] = [
  [0, 0], [0, 1], [0, 2], [0, 3], [3, 0], [1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3], [4, 2], [4, 3],
];
const MAX_REPORTED = 20;

/** MSB-first bit reader limited to [pos, end). */
class Bits {
  constructor(private readonly bytes: Uint8Array, public pos: number, readonly end: number) {}
  get remaining(): number { return this.end - this.pos; }
  bit(): number {
    if (this.pos >= this.end) throw new Error('read past end of granule data');
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

const pairMaps = PAIR_TABLES.map((t) => (t ? new Map(t.codes.map((c, i) => [c, i])) : undefined));
const quadMaps = QUAD_TABLES.map((codes) => new Map(codes.map((c, i) => [c, i])));

function readSymbol(r: Bits, map: Map<string, number>): number {
  let code = '';
  for (let i = 0; i < 20; i++) {
    code += String(r.bit());
    const v = map.get(code);
    if (v !== undefined) return v;
  }
  throw new Error('invalid Huffman code');
}

interface GranuleInfo {
  part23: number; big: number; gain: number; compress: number;
  windowSwitching: number; tables: number[]; region0: number; region1: number; count1Table: number;
}

interface SideInfo { mainDataBegin: number; scfsi: number; granules: GranuleInfo[][] }

function readSideInfo(bytes: Uint8Array, frame: ParsedFrame): SideInfo {
  const r = new Bits(bytes, (frame.offset + 4) * 8, bytes.length * 8);
  const mainDataBegin = r.bits(9);
  r.bits(frame.channels === 1 ? 5 : 3);
  const scfsi = r.bits(4 * frame.channels);
  const granules = [0, 1].map(() =>
    Array.from({ length: frame.channels }, (): GranuleInfo => {
      const part23 = r.bits(12);
      const big = r.bits(9);
      const gain = r.bits(8);
      const compress = r.bits(4);
      const windowSwitching = r.bits(1);
      const tables = [r.bits(5), r.bits(5), r.bits(5)];
      const region0 = r.bits(4);
      const region1 = r.bits(3);
      r.bits(2); // preflag, scalefac_scale
      const count1Table = r.bits(1);
      return { part23, big, gain, compress, windowSwitching, tables, region0, region1, count1Table };
    }));
  return { mainDataBegin, scfsi, granules };
}

/** Reads one pair-coded region [from, to) with the given table, consuming exactly its bits. */
function readRegion(r: Bits, tableNo: number, from: number, to: number): void {
  if (tableNo === 0) return; // table 0 holds only zeros and carries no bits
  const t = PAIR_TABLES[tableNo];
  const map = pairMaps[tableNo];
  if (!t || !map) throw new Error(`table ${String(tableNo)} does not exist`);
  for (let i = from; i < to; i += 2) {
    const idx = readSymbol(r, map);
    const x = Math.floor(idx / t.size);
    const y = idx % t.size;
    if (t.linbits > 0 && x === t.size - 1) r.bits(t.linbits);
    if (x !== 0) r.bit();
    if (t.linbits > 0 && y === t.size - 1) r.bits(t.linbits);
    if (y !== 0) r.bit();
  }
}

function checkParameters(g: GranuleInfo): string[] {
  const problems: string[] = [];
  if (g.big > 288) problems.push('big_values > 288');
  if (g.windowSwitching !== 0) problems.push('window switching is not expected');
  if (g.tables.some((t) => t === 4 || t === 14)) problems.push('invalid table_select');
  return problems;
}

/** Decodes one granule/channel's main data; returns problem descriptions (empty when exact). */
function checkGranule(stream: Uint8Array, bitPos: number, g: GranuleInfo, sfb: readonly number[]): string[] {
  const problems = checkParameters(g);
  const r = new Bits(stream, bitPos, bitPos + g.part23);
  try {
    const [slen1, slen2] = SLEN[g.compress] ?? [0, 0];
    for (let b = 0; b < 21; b++) r.bits(b < 11 ? slen1 : slen2);
    const end = g.big * 2;
    const e0 = Math.min(sfb[g.region0 + 1] ?? 576, end);
    const e1 = Math.min(sfb[Math.min(g.region0 + g.region1 + 2, 22)] ?? 576, end);
    const edges = [0, e0, e1, end];
    for (let region = 0; region < 3; region++) {
      readRegion(r, g.tables[region] ?? 0, edges[region] ?? 0, edges[region + 1] ?? 0);
    }
    const quadMap = quadMaps[g.count1Table];
    for (let lines = end; quadMap && r.remaining > 0 && lines + 4 <= 576; lines += 4) {
      const idx = readSymbol(r, quadMap);
      for (let k = 0; k < 4; k++) if (((idx >> (3 - k)) & 1) !== 0) r.bit();
    }
    if (r.remaining !== 0) problems.push(`${String(r.remaining)} unread bits of part2_3_length`);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return problems;
}

function checkHeader(f: ParsedFrame, first: ParsedFrame): string[] {
  const problems: string[] = [];
  if (f.sampleRate !== first.sampleRate || f.channels !== first.channels) problems.push('stream parameters change');
  if (!BITRATES_KBPS.includes(f.bitrateKbps)) problems.push('invalid bitrate');
  if (f.size !== frameSizeBytes(f.sampleRate, f.bitrateKbps, f.padding)) problems.push('wrong size');
  if (f.mainDataBegin > 511) problems.push('main_data_begin too large');
  return problems;
}

function checkFrame(bytes: Uint8Array, f: ParsedFrame, first: ParsedFrame, stream: Uint8Array, sfb: readonly number[]): string[] {
  const problems = checkHeader(f, first);
  const side = readSideInfo(bytes, f);
  if (side.scfsi !== 0) problems.push('unexpected scfsi');
  if (side.mainDataBegin !== f.mainDataBegin) problems.push('inconsistent main_data_begin');
  const total = side.granules.flat().reduce((s, g) => s + g.part23, 0);
  if (total > stream.length * 8) {
    problems.push(`main data (${String(total)} bits) exceeds what is reachable (${String(stream.length * 8)} bits)`);
    return problems;
  }
  let bitPos = 0;
  side.granules.forEach((row, gr) => {
    row.forEach((g, ch) => {
      for (const p of checkGranule(stream, bitPos, g, sfb)) problems.push(`gr${String(gr)} ch${String(ch)}: ${p}`);
      bitPos += g.part23;
    });
  });
  return problems;
}

export interface ValidationReport {
  readonly frames: number;
  readonly problems: string[];
}

function hasXingTag(bytes: Uint8Array, f: ParsedFrame): boolean {
  const at = f.offset + 4 + sideInfoBytes(f.channels);
  return String.fromCharCode(...bytes.slice(at, at + 4)) === 'Xing';
}

export function validateMp3(bytes: Uint8Array): ValidationReport {
  let frames: ParsedFrame[];
  try {
    frames = parseFrames(bytes);
  } catch (e) {
    return { frames: 0, problems: [e instanceof Error ? e.message : String(e)] };
  }
  const first = frames[0];
  if (!first) return { frames: 0, problems: ['no frames'] };

  const problems: string[] = [];
  const trailing = bytes.length - frames.reduce((n, f) => n + f.size, 0);
  if (trailing !== 0) problems.push(`${String(trailing)} trailing bytes after the last complete frame`);

  const skip = hasXingTag(bytes, first) ? 1 : 0;
  const audio = frames.slice(skip);
  const streams = mainDataStreams(audio);
  const sfb = SFB_LONG[first.sampleRate];
  if (!sfb) return { frames: frames.length, problems: [...problems, `unexpected sample rate ${String(first.sampleRate)}`] };
  audio.forEach((f, n) => {
    for (const p of checkFrame(bytes, f, first, streams[n] ?? new Uint8Array(0), sfb)) problems.push(`frame ${String(n + skip)}: ${p}`);
  });
  return { frames: frames.length, problems: problems.slice(0, MAX_REPORTED) };
}
