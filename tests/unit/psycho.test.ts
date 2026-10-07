import { describe, expect, it } from 'vitest';
import { absoluteThreshold, computeThresholds, perceptualEntropy } from '../../src/psycho.js';
import { SFB_LONG } from '../../src/tables/sfb-data.js';

const SFB = SFB_LONG[44100] ?? [];
const SR = 44100;

function thresholds(xr: Float64Array): Float64Array {
  const out = new Float64Array(22);
  computeThresholds(xr, SFB, SR, out);
  return out;
}

function bandEnergy(xr: Float64Array, b: number): number {
  let e = 0;
  for (let i = SFB[b] ?? 0; i < (SFB[b + 1] ?? 0); i++) e += (xr[i] ?? 0) ** 2;
  return e;
}

describe('absoluteThreshold (ATH)', () => {
  it('is positive and finite in every band, lowest in the 2-5 kHz region', () => {
    const ath = absoluteThreshold(SFB, SR);
    expect(ath).toHaveLength(22);
    ath.forEach((v) => { expect(v).toBeGreaterThan(0); expect(Number.isFinite(v)).toBe(true); });
    // per-line threshold density, normalised by band width
    const density = (b: number): number => (ath[b] ?? 0) / ((SFB[b + 1] ?? 0) - (SFB[b] ?? 0));
    expect(density(0)).toBeGreaterThan(density(14));
    expect(density(21)).toBeGreaterThan(density(14));
  });
});

describe('computeThresholds', () => {
  it('falls back to the ATH for silence', () => {
    const t = thresholds(new Float64Array(576));
    const ath = absoluteThreshold(SFB, SR);
    t.forEach((v, b) => { expect(v).toBeCloseTo(ath[b] ?? 0, 15); });
  });

  it('masks 18-20 dB below a pure tone and spreads upward more than downward', () => {
    const xr = new Float64Array(576);
    xr[(SFB[10] ?? 0) + 3] = 0.8;
    const t = thresholds(xr);
    const e = bandEnergy(xr, 10);
    expect((t[10] ?? 0) / e).toBeGreaterThan(0.004);
    expect((t[10] ?? 0) / e).toBeLessThan(0.05);
    expect(t[11] ?? 0).toBeLessThan(t[10] ?? 0);
    expect(t[11] ?? 0).toBeGreaterThan(t[9] ?? 0);
    expect(t[11] ?? 0).toBeGreaterThan(absoluteThreshold(SFB, SR)[11] ?? 0);
  });

  it('allows more noise under a noise-like band than under a tonal band of equal energy', () => {
    const tonal = new Float64Array(576);
    const noisy = new Float64Array(576);
    const w = (SFB[11] ?? 0) - (SFB[10] ?? 0);
    tonal[SFB[10] ?? 0] = 0.5 * Math.sqrt(w);
    for (let i = SFB[10] ?? 0; i < (SFB[11] ?? 0); i++) noisy[i] = 0.5;
    const ratio = (xr: Float64Array): number => (thresholds(xr)[10] ?? 0) / bandEnergy(xr, 10);
    expect(ratio(noisy)).toBeGreaterThan(ratio(tonal) * 5);
  });

  it('scales with signal level once above the ATH (x10 amplitude -> x100 energy)', () => {
    const base = new Float64Array(576);
    base[SFB[10] ?? 0] = 0.1;
    const loud = base.map((v) => v * 10);
    const ratio = (thresholds(loud)[10] ?? 0) / (thresholds(base)[10] ?? 1);
    expect(ratio).toBeGreaterThan(50);
    expect(ratio).toBeLessThan(150);
  });
});

describe('perceptualEntropy', () => {
  it('is zero for silence and grows with the amount of audible spectral content', () => {
    const quiet = new Float64Array(576);
    expect(perceptualEntropy(quiet, SFB, thresholds(quiet))).toBe(0);
    const oneTone = new Float64Array(576);
    oneTone[(SFB[10] ?? 0) + 2] = 0.3;
    const manyTones = new Float64Array(576);
    for (let b = 0; b < 21; b++) manyTones[(SFB[b] ?? 0) + 1] = 0.3;
    expect(perceptualEntropy(manyTones, SFB, thresholds(manyTones))).toBeGreaterThan(
      perceptualEntropy(oneTone, SFB, thresholds(oneTone)),
    );
  });
});
