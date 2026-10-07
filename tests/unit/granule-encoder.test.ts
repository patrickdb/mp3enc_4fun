import { describe, expect, it } from 'vitest';
import { encodeGranule } from '../../src/granule-encoder.js';
import { computeThresholds } from '../../src/psycho.js';
import { bandNoise, dequantize } from '../../src/quantize.js';
import { chooseScalefacCompress, scalefactorBits } from '../../src/scalefactors.js';
import { SFB_LONG } from '../../src/tables/sfb-data.js';

const SFB = SFB_LONG[44100] ?? [];
const SR = 44100;

/** Music-like spectrum: strong low end decaying to a quiet top, with some peaks. */
function musicSpectrum(seed = 5, level = 1): Float64Array {
  let s = seed;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
  return Float64Array.from({ length: 576 }, (_, i) => {
    const envelope = level * 0.8 * Math.exp(-i / 90);
    const peak = i % 37 === 0 ? 4 : 1;
    return rnd() * envelope * peak;
  });
}

function thresholdsFor(xr: Float64Array): Float64Array {
  const t = new Float64Array(22);
  computeThresholds(xr, SFB, SR, t);
  return t;
}

function totalNoise(xr: Float64Array, r: ReturnType<typeof encodeGranule>): number {
  const noise = new Float64Array(22);
  bandNoise(xr, r.ix, r.globalGain, r.scalefacs, SFB, noise);
  return noise.reduce((a, b) => a + b, 0);
}

describe('encodeGranule', () => {
  it('codes silence with a valid, tiny result', () => {
    const xr = new Float64Array(576);
    const r = encodeGranule(xr, thresholdsFor(xr), SFB, { maxBits: 500 });
    expect(r.ix.every((v) => v === 0)).toBe(true);
    expect(r.part23Bits).toBeLessThanOrEqual(500);
    expect(r.part23Bits).toBe(r.coding.bits + r.scalefacBits);
  });

  it('never exceeds the bit budget', () => {
    const xr = musicSpectrum();
    for (const maxBits of [150, 400, 900, 2000, 4095]) {
      const r = encodeGranule(xr, thresholdsFor(xr), SFB, { maxBits });
      expect(r.part23Bits).toBeLessThanOrEqual(maxBits);
    }
  });

  it('spends more bits for lower noise when the budget grows', () => {
    const xr = musicSpectrum(7);
    const t = thresholdsFor(xr);
    const small = encodeGranule(xr, t, SFB, { maxBits: 300 });
    const large = encodeGranule(xr, t, SFB, { maxBits: 1800 });
    expect(totalNoise(xr, large)).toBeLessThan(totalNoise(xr, small));
    expect(large.globalGain).toBeLessThan(small.globalGain);
  });

  it('with tighten, stops spending once every band is below its threshold', () => {
    const xr = musicSpectrum(3, 0.5);
    const t = thresholdsFor(xr);
    const r = encodeGranule(xr, t, SFB, { maxBits: 4000, tighten: true });
    const noise = new Float64Array(22);
    bandNoise(xr, r.ix, r.globalGain, r.scalefacs, SFB, noise);
    noise.forEach((n, b) => { expect(n).toBeLessThanOrEqual((t[b] ?? 0) * 1.0000001); });
    expect(r.part23Bits).toBeLessThan(4000);
  });

  it('amplifies scale factors on bands whose noise exceeds the threshold', () => {
    const xr = musicSpectrum(11);
    const t = new Float64Array(22).fill(1e3);
    t[5] = 1e-7;
    const withSf = encodeGranule(xr, t, SFB, { maxBits: 700 });
    const without = encodeGranule(xr, t, SFB, { maxBits: 700, scalefactors: false });
    expect(withSf.scalefacs[5] ?? 0).toBeGreaterThan(0);
    const n = (r: ReturnType<typeof encodeGranule>): number => {
      const noise = new Float64Array(22);
      bandNoise(xr, r.ix, r.globalGain, r.scalefacs, SFB, noise);
      return noise[5] ?? 0;
    };
    expect(n(withSf)).toBeLessThan(n(without));
  });

  it('keeps side parameters inside their bitstream limits and consistent with each other', () => {
    const xr = musicSpectrum(13);
    const r = encodeGranule(xr, thresholdsFor(xr), SFB, { maxBits: 1200 });
    expect(r.globalGain).toBeGreaterThanOrEqual(0);
    expect(r.globalGain).toBeLessThanOrEqual(255);
    expect(Number.isInteger(r.globalGain)).toBe(true);
    r.scalefacs.forEach((v, b) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(b < 11 ? 15 : 7);
    });
    expect(r.scalefacs[21]).toBe(0);
    expect(chooseScalefacCompress(r.scalefacs)?.bits).toBeLessThanOrEqual(r.scalefacBits);
    expect(scalefactorBits(r.scalefacCompress)).toBe(r.scalefacBits);
    expect(r.part23Bits).toBeLessThanOrEqual(4095);
  });

  it('reproduces the spectrum closely when the budget is generous and thresholds are tight', () => {
    const xr = musicSpectrum(17);
    const t = new Float64Array(22).fill(1e-12);
    const r = encodeGranule(xr, t, SFB, { maxBits: 4095 });
    const back = new Float64Array(576);
    dequantize(r.ix, r.globalGain, r.scalefacs, SFB, back);
    let err = 0;
    let sig = 0;
    for (let i = 0; i < 576; i++) { err += ((xr[i] ?? 0) - (back[i] ?? 0)) ** 2; sig += (xr[i] ?? 0) ** 2; }
    expect(10 * Math.log10(sig / err)).toBeGreaterThan(30);
  });

  it('never lets quantised values saturate, however generous the budget (regression)', () => {
    const xr = new Float64Array(576);
    xr[27] = 0.85;
    xr[26] = 0.3;
    xr[28] = -0.2;
    const t = new Float64Array(22).fill(1e-30);
    const r = encodeGranule(xr, t, SFB, { maxBits: 4095 });
    expect(Math.max(...r.ix.map(Math.abs))).toBeLessThan(8206);
    const back = new Float64Array(576);
    dequantize(r.ix, r.globalGain, r.scalefacs, SFB, back);
    expect(back[27]).toBeCloseTo(0.85, 3);
    expect(back[28]).toBeCloseTo(-0.2, 3);
  });

  it('accepts a gain hint without losing budget compliance, whatever the hint', () => {
    const xr = musicSpectrum(21);
    const t = thresholdsFor(xr);
    const reference = encodeGranule(xr, t, SFB, { maxBits: 900 });
    for (const gainHint of [0, 120, 255]) {
      const r = encodeGranule(xr, t, SFB, { maxBits: 900, gainHint });
      expect(r.part23Bits).toBeLessThanOrEqual(900);
      // the hint only steers the search; the outcome must stay (almost) as good
      expect(Math.abs(r.globalGain - reference.globalGain)).toBeLessThanOrEqual(2);
    }
  });
});
