import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../src/bitwriter.js';
import { analyzeSpectrum, estimateSpectrumBits, writeSpectrum } from '../../src/huffman.js';
import { PAIR_TABLES, QUAD_TABLES } from '../../src/tables/huffman-data.js';
import { SFB_LONG } from '../../src/tables/sfb-data.js';
import { decodeSpectrum } from '../helpers/huffman-decoder.js';
import { exhaustiveBits } from '../helpers/huffman-reference.js';

const SFB = SFB_LONG[44100] ?? [];

function spectrum(values: Record<number, number>): Int32Array {
  const ix = new Int32Array(576);
  for (const [i, v] of Object.entries(values)) ix[Number(i)] = v;
  return ix;
}

function roundTrip(ix: Int32Array): { decoded: Int32Array; bits: number; coding: ReturnType<typeof analyzeSpectrum> } {
  const coding = analyzeSpectrum(ix, SFB);
  const w = new BitWriter();
  writeSpectrum(w, ix, coding);
  const decoded = decodeSpectrum(w.toBytes(), {
    bigValues: coding.bigValues, count1Quads: coding.count1Quads, region0Count: coding.region0Count,
    region1Count: coding.region1Count, tableSelect: coding.tableSelect, count1TableSelect: coding.count1TableSelect,
  }, SFB);
  expect(w.bitLength).toBe(coding.bits);
  return { decoded, bits: w.bitLength, coding };
}

describe('Huffman table data (ISO Table 3-B.7)', () => {
  it('provides pair tables with valid dimensions and the standard linbits', () => {
    const lin = [0, 1, 2, 3, 4, 6, 8, 10, 13];
    expect(PAIR_TABLES).toHaveLength(32);
    expect(PAIR_TABLES[4]).toBeUndefined();
    expect(PAIR_TABLES[14]).toBeUndefined();
    expect(PAIR_TABLES[1]?.size).toBe(2);
    expect(PAIR_TABLES[13]?.size).toBe(16);
    expect(PAIR_TABLES.map((t) => t?.linbits ?? 0).slice(16, 24)).toEqual(lin.slice(1));
    expect(PAIR_TABLES.map((t) => t?.linbits ?? 0).slice(24, 32)).toEqual([4, 5, 6, 7, 8, 9, 11, 13]);
    for (const t of PAIR_TABLES) if (t) expect(t.codes).toHaveLength(t.size * t.size);
  });

  it('has prefix-free, complete codes (Kraft sum 1) for every table', () => {
    const all = [...PAIR_TABLES.filter((t) => t !== undefined).slice(1).map((t) => t.codes), ...QUAD_TABLES];
    for (const codes of all) {
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes.reduce((s, c) => s + 2 ** -c.length, 0)).toBeCloseTo(1, 10);
    }
  });

  it('matches well-known entries: table 1 pair (1,0) is 01 and quad table A (0,0,0,0) is 1', () => {
    expect(PAIR_TABLES[1]?.codes[2]).toBe('01');
    expect(QUAD_TABLES[0]?.[0]).toBe('1');
    expect(QUAD_TABLES[1]?.[15]).toBe('0000');
  });
});

describe('analyzeSpectrum / writeSpectrum', () => {
  it('codes an all-zero spectrum with no bits', () => {
    const coding = analyzeSpectrum(new Int32Array(576), SFB);
    expect(coding.bigValues).toBe(0);
    expect(coding.count1Quads).toBe(0);
    expect(coding.bits).toBe(0);
  });

  it('codes a single +1 as table-1 pair (1,0): code 01 then sign 0', () => {
    const ix = spectrum({ 0: 1 });
    const coding = analyzeSpectrum(ix, SFB);
    expect(coding.bigValues).toBe(1);
    expect(coding.tableSelect[0]).toBe(1);
    expect(coding.bits).toBe(3);
    const w = new BitWriter();
    writeSpectrum(w, ix, coding);
    expect([...w.toBytes()]).toEqual([0b01000000]);
  });

  it('splits a spectrum into big values, count1 quadruples and a zero tail', () => {
    const ix = spectrum({ 0: 5, 1: 3, 4: 1, 6: -1, 9: 1 });
    const { coding, decoded } = roundTrip(ix);
    expect(coding.bigValues).toBe(1);
    expect(coding.count1Quads).toBe(2);
    expect([...decoded]).toEqual([...ix]);
  });

  it('round-trips escape values using linbits tables, up to the maximum 8206', () => {
    const ix = spectrum({ 0: 8206, 1: -8206, 2: 15, 3: -16, 4: 100, 5: 0, 6: -300, 7: 17, 40: 1234, 41: -2 });
    const { coding, decoded } = roundTrip(ix);
    expect(coding.tableSelect.some((t) => t >= 16)).toBe(true);
    expect([...decoded]).toEqual([...ix]);
  });

  it('round-trips random spectra shaped like music (decaying magnitudes)', () => {
    let seed = 99;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 60; trial++) {
      const ix = new Int32Array(576);
      const bandwidth = 40 + Math.floor(rnd() * 536);
      const peak = 1 + Math.floor(rnd() * 400 * rnd());
      for (let i = 0; i < bandwidth; i++) {
        const mag = Math.floor(peak * rnd() * (1 - i / bandwidth) ** 2);
        ix[i] = rnd() < 0.5 ? -mag : mag;
      }
      const { decoded } = roundTrip(ix);
      expect([...decoded]).toEqual([...ix]);
    }
  });

  it('chooses cheaper tables for small values than for large ones', () => {
    const small = analyzeSpectrum(Int32Array.from({ length: 576 }, (_, i) => (i < 100 ? (i % 3) - 1 : 0)), SFB);
    const large = analyzeSpectrum(Int32Array.from({ length: 576 }, (_, i) => (i < 100 ? 40 : 0)), SFB);
    expect(small.bits).toBeLessThan(large.bits);
  });

  it('keeps region counts within their 4-bit and 3-bit fields', () => {
    const ix = Int32Array.from({ length: 576 }, (_, i) => Math.round(30 * Math.sin(i / 7)));
    const c = analyzeSpectrum(ix, SFB);
    expect(c.region0Count).toBeGreaterThanOrEqual(0);
    expect(c.region0Count).toBeLessThanOrEqual(15);
    expect(c.region1Count).toBeGreaterThanOrEqual(0);
    expect(c.region1Count).toBeLessThanOrEqual(7);
    expect(c.bigValues).toBeLessThanOrEqual(288);
  });

  it('stays within 2% of the exhaustive optimum over all tables and region splits', () => {
    let seed = 4242;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    let chosen = 0;
    let optimum = 0;
    for (let trial = 0; trial < 40; trial++) {
      const ix = new Int32Array(576);
      const bandwidth = 30 + Math.floor(rnd() * 546);
      const peak = 1 + Math.floor(rnd() * 600 * rnd());
      for (let i = 0; i < bandwidth; i++) {
        const mag = Math.floor(peak * rnd() * (1 - i / bandwidth) ** 3);
        ix[i] = rnd() < 0.5 ? -mag : mag;
      }
      const bits = analyzeSpectrum(ix, SFB).bits;
      const best = exhaustiveBits(ix, SFB);
      expect(bits).toBeGreaterThanOrEqual(best);
      chosen += bits;
      optimum += best;
    }
    expect(chosen / optimum).toBeLessThan(1.02);
  });

  it('estimateSpectrumBits is a cheap upper bound of the exact result, never off by much', () => {
    let seed = 777;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    let estimated = 0;
    let exact = 0;
    for (let trial = 0; trial < 60; trial++) {
      const ix = new Int32Array(576);
      const bandwidth = 20 + Math.floor(rnd() * 556);
      const peak = 1 + Math.floor(rnd() * 500 * rnd());
      for (let i = 0; i < bandwidth; i++) {
        const mag = Math.floor(peak * rnd() * (1 - i / bandwidth) ** 2);
        ix[i] = rnd() < 0.5 ? -mag : mag;
      }
      const est = estimateSpectrumBits(ix, SFB);
      const bits = analyzeSpectrum(ix, SFB).bits;
      expect(est).toBeGreaterThanOrEqual(bits);
      estimated += est;
      exact += bits;
    }
    expect(estimated / exact).toBeLessThan(1.15);
  });
});
