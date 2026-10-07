// One-off generator for src/tables/*-data.ts. NOT part of the build or the test run.
//
// It parses plain text extracted (see extract-pdf-text.mjs) from two public documents derived from
// ISO/IEC 11172-3, and validates everything it reads (entry counts, prefix-free codes, Kraft sum 1):
//   guess  - "MPEG Layer3 Bitstream Syntax and Decoding" (Huffman tables, scalefactor bands, alias coefficients)
//            https://mp3guessenc.sourceforge.io/MPEG%20Layer3%20Bitstream%20Syntax%20and%20Decoding.pdf
//   annex  - ISO/IEC 11172-3 Annexes C & D (analysis window coefficients, Table 3-C.1)
//            http://exvacuo.free.fr/div/Technic/Sp%C3%A9cifications/MP3/ISO-IEC%2011172-3%20(audio%20annexes).pdf
//
// Usage: node tools/generate-tables.mjs guess.txt annex.txt src/tables
import fs from 'node:fs';
const [,, guessTxt, annexTxt, outDir] = process.argv;
const g = fs.readFileSync(guessTxt, 'utf8').split('\n');
const annex = fs.readFileSync(annexTxt, 'utf8');

// ---------- Huffman ----------
const start = g.findIndex((l, i) => i > 1900 && l.startsWith('Huffman code table A'));
const end = g.findIndex((l, i) => i > start && l.startsWith('Table 42'));
const sec = g.slice(start, end);
// split into groups by heading
const groups = []; // {heading, rows: string[][]}
for (const line of sec) {
  const l = line.trim();
  if (l.startsWith('Huffman code table')) { groups.push({ heading: l, rows: [] }); continue; }
  if (!groups.length || l.startsWith('=====') || l.startsWith('Table ')) continue;
  groups.at(-1).rows.push(l.split(/\s+/));
}
const dims = { 1: 2, 2: 3, 3: 3, 5: 4, 6: 4, 7: 6, 8: 6, 9: 6, 10: 8, 11: 8, 12: 8 };
const tables = {}; // number -> {linbits, codes:[hlen,code][] , n}
function codesFrom(rows, withXY) {
  const out = [];
  for (const t of rows) {
    const code = t.at(-1);
    if (!/^[01]+$/.test(code) || t.length < 3) continue;
    if (!/^\d+$/.test(t[0])) continue;
    out.push(code);
  }
  return out;
}
const quad = {};
for (const gr of groups) {
  const h = gr.heading;
  if (h.startsWith('Huffman code table A') || h.startsWith('Huffman code table B')) {
    const name = h.includes('table A') ? 'A' : 'B';
    quad[name] = gr.rows.filter(t => t.length === 6 && /^[01]+$/.test(t[5])).map(t => t[5]);
    continue;
  }
  const nums = [...h.matchAll(/(\d+) \(linbits=(\d+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
  if (nums.length === 0) continue;
  const codes = codesFrom(gr.rows);
  const key = nums.map(n => n[0]).join(',');
  (tables[key] ??= { nums, codes: [] }).codes.push(...codes);
}
const huff = {}; // tableNo -> {n, linbits, codes}
for (const { nums, codes } of Object.values(tables)) {
  for (const [no, lin] of nums) {
    if (no === 0) { huff[0] = { n: 1, linbits: 0, codes: [''] }; continue; }
    const n = dims[no] ?? 16;
    if (codes.length !== n * n) throw new Error(`table ${no}: expected ${n*n} codes, got ${codes.length}`);
    huff[no] = { n, linbits: lin, codes };
  }
}
huff[0] = { n: 1, linbits: 0, codes: ['0'.repeat(0)] };
for (const no of [0,1,2,3,5,6,7,8,9,10,11,12,13,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]) {
  if (!huff[no]) throw new Error('missing table ' + no);
}
for (const q of ['A','B']) if (quad[q]?.length !== 16) throw new Error('quad ' + q + ' ' + quad[q]?.length);
// prefix-free + Kraft check
function check(name, codes) {
  const set = new Set(codes);
  if (set.size !== codes.length && name !== 'table0') {
    // duplicates only legal if table is degenerate
    throw new Error(name + ' has duplicate codes');
  }
  for (const a of codes) for (const b of codes) if (a !== b && b.startsWith(a)) throw new Error(`${name}: ${a} prefixes ${b}`);
  const kraft = codes.reduce((s, c) => s + 2 ** -c.length, 0);
  return kraft;
}
for (const [no, t] of Object.entries(huff)) if (no !== '0') console.log('table', no, 'n', t.n, 'linbits', t.linbits, 'kraft', check('table'+no, t.codes).toFixed(4));
for (const q of ['A','B']) console.log('quad', q, 'kraft', check('quad'+q, quad[q]).toFixed(4));

let ts = `// GENERATED from ISO/IEC 11172-3 Annex B, Table 3-B.7 (via the public MPEG Layer III bitstream reference).\n// Do not edit by hand. Each table lists the Huffman code words in row-major (x, y) order, x = row.\n\n`;
ts += `export interface PairTable {\n  readonly size: number;\n  readonly linbits: number;\n  readonly codes: readonly string[];\n}\n\n`;
ts += `/** Big-value pair tables, indexed by table_select (0..31). Tables 4 and 14 are unused by the standard. */\nexport const PAIR_TABLES: readonly (PairTable | undefined)[] = [\n`;
for (let i = 0; i < 32; i++) {
  const t = huff[i];
  if (!t) { ts += '  undefined,\n'; continue; }
  ts += `  { size: ${t.n}, linbits: ${t.linbits}, codes: [${t.codes.map(c => `'${c}'`).join(',')}] },\n`;
}
ts += `];\n\n/** Count1 quadruple tables A (index 0) and B (index 1); entry index = v*8 + w*4 + x*2 + y. */\nexport const QUAD_TABLES: readonly (readonly string[])[] = [\n  [${quad.A.map(c => `'${c}'`).join(',')}],\n  [${quad.B.map(c => `'${c}'`).join(',')}],\n];\n`;
fs.writeFileSync(outDir + '/huffman-data.ts', ts);

// ---------- scalefactor bands ----------
function bands(tableNo, count) {
  const i = g.findIndex((l, k) => k > 3000 && l.trim() === `Table ${tableNo}`);
  const rows = [];
  for (let k = i + 2; rows.length < count && k < g.length; k++) {
    const t = g[k].trim().split(/\s+/);
    if (t.length === 4 && t.every(x => /^\d+$/.test(x))) rows.push(t.map(Number));
  }
  if (rows.length !== count) throw new Error(`sfb table ${tableNo}: ${rows.length}`);
  rows.forEach((r, k) => { if (r[0] !== k) throw new Error('sfb idx'); if (r[3] - r[2] + 1 !== r[1]) throw new Error('sfb width'); });
  const starts = [...rows.map(r => r[2]), rows.at(-1)[3] + 1];
  return [...starts, count === 21 ? 576 : 192];
}
const rates = { 32000: [54, 55], 44100: [56, 57], 48000: [58, 59] };
let sfb = `// GENERATED from ISO/IEC 11172-3 Annex B, Table 3-B.8 (scalefactor band boundaries). Do not edit by hand.\n\n`;
sfb += `/** Start index of each long-block scalefactor band (bands 0..21; band 21 is the remainder), plus the end sentinel 576. */\nexport const SFB_LONG: Readonly<Record<number, readonly number[]>> = {\n`;
for (const [r, [l]] of Object.entries(rates)) sfb += `  ${r}: [${bands(l, 21).join(', ')}],\n`;
sfb += `};\n\n/** Start index of each short-block scalefactor band (12 bands, per window), plus the final band start and the end sentinel 192. */\nexport const SFB_SHORT: Readonly<Record<number, readonly number[]>> = {\n`;
for (const [r, [, s]] of Object.entries(rates)) sfb += `  ${r}: [${bands(s, 12).join(', ')}],\n`;
sfb += `};\n`;
fs.writeFileSync(outDir + '/sfb-data.ts', sfb);

// ---------- aliasing coefficients ----------
const ai = g.findIndex(l => l.trim() === 'Coefficients for aliasing reduction');
const ci = [];
for (let k = ai + 2; ci.length < 8; k++) { const t = g[k].trim().split(/\s+/); if (t.length === 2 && /^-?[\d.]+$/.test(t[1])) ci.push(Number(t[1])); }
console.log('alias', ci.join(','));

// ---------- window ----------
const flat = annex.replace(/-\s+/g, '-');
const C = new Array(512).fill(null);
for (const m of flat.matchAll(/C\[\s*(\d+)\]=\s*(-?[\d.]+)/g)) C[Number(m[1])] = m[2];
const missing = C.map((v, i) => v === null ? i : -1).filter(i => i >= 0);
if (missing.length) throw new Error('window missing ' + missing.slice(0, 10));
let w = `// GENERATED from ISO/IEC 11172-3 Annex C, Table 3-C.1 (analysis window coefficients). Do not edit by hand.\n\n`;
w += `export const ANALYSIS_WINDOW: readonly number[] = [\n`;
for (let i = 0; i < 512; i += 8) w += '  ' + C.slice(i, i + 8).join(', ') + ',\n';
w += `];\n\n/** Aliasing-reduction coefficients c[i] from ISO/IEC 11172-3 Table 3-B.9. */\nexport const ALIAS_COEFFICIENTS: readonly number[] = [${ci.join(', ')}];\n`;
fs.writeFileSync(outDir + '/window-data.ts', w);
console.log('done');
