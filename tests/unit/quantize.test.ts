import { describe, expect, it } from 'vitest';
import { MAX_QUANT, bandNoise, dequantize, minGain, quantize } from '../../src/quantize.js';
import { SFB_LONG } from '../../src/tables/sfb-data.js';

const SFB = SFB_LONG[44100] ?? [];
const noScale = new Int32Array(22);

function run(xr: Float64Array, gain: number, sf = noScale): Int32Array {
  const ix = new Int32Array(576);
  quantize(xr, gain, sf, SFB, ix);
  return ix;
}

describe('quantize', () => {
  it('uses unit step size at global_gain 210 and the 0.4054 rounding offset', () => {
    const xr = new Float64Array(576);
    xr[0] = 1;
    xr[1] = 8; // 8^0.75 = 4.757 -> 5
    xr[2] = -27; // 27^0.75 = 11.84 -> 12
    xr[3] = 0.1; // 0.1^0.75 = 0.178 -> 0
    const ix = run(xr, 210);
    expect([ix[0], ix[1], ix[2], ix[3]]).toEqual([1, 5, -12, 0]);
  });

  it('halves the step (x 2^-0.25) per global_gain decrement, so values grow as gain falls', () => {
    const xr = new Float64Array(576).fill(100);
    const coarse = run(xr, 210)[0] ?? 0;
    const fine = run(xr, 190)[0] ?? 0;
    expect(fine).toBeGreaterThan(coarse);
    expect(run(xr, 220)[0] ?? 0).toBeLessThan(coarse);
  });

  it('applies scale factors: +2 on a band refines it by 2^1 in amplitude (multiplier 0.5)', () => {
    const xr = new Float64Array(576).fill(50);
    const sf = new Int32Array(22);
    sf[0] = 2;
    const ix = run(xr, 210, sf);
    const plain = run(xr, 210);
    // amplitude doubles -> |ix| grows by 2^(3/4)
    expect((ix[0] ?? 0) / (plain[0] ?? 1)).toBeCloseTo(2 ** 0.75, 1);
    expect(ix[SFB[1] ?? 0]).toBe(plain[SFB[1] ?? 0]);
  });

  it('clamps to the largest codable magnitude', () => {
    const xr = new Float64Array(576).fill(1e12);
    expect(run(xr, 0)[0]).toBe(MAX_QUANT);
    expect(MAX_QUANT).toBe(8206);
  });
});

describe('dequantize / bandNoise', () => {
  it('inverts quantization up to the step size (ISO requantisation formula)', () => {
    const xr = Float64Array.from({ length: 576 }, (_, i) => Math.sin(i) * 5);
    const ix = run(xr, 200);
    const back = new Float64Array(576);
    dequantize(ix, 200, noScale, SFB, back);
    for (let i = 0; i < 576; i++) {
      const step = 2 ** ((200 - 210) / 4) * Math.max(1, Math.abs(ix[i] ?? 0)) ** (1 / 3) * 1.4;
      expect(Math.abs((back[i] ?? 0) - (xr[i] ?? 0))).toBeLessThan(step);
    }
  });

  it('dequantizes exactly as sign * |is|^(4/3) * 2^((gain-210)/4)', () => {
    const ix = new Int32Array(576);
    ix[0] = 8;
    ix[1] = -27;
    const out = new Float64Array(576);
    dequantize(ix, 214, noScale, SFB, out);
    expect(out[0]).toBeCloseTo(16 * 2, 9);
    expect(out[1]).toBeCloseTo(-81 * 2, 9);
  });

  it('sums the squared quantisation error per scale-factor band', () => {
    const xr = Float64Array.from({ length: 576 }, (_, i) => Math.cos(i * 0.3) * 40);
    const ix = run(xr, 205);
    const back = new Float64Array(576);
    dequantize(ix, 205, noScale, SFB, back);
    const noise = new Float64Array(22);
    bandNoise(xr, ix, 205, noScale, SFB, noise);
    for (let b = 0; b < 22; b++) {
      let expected = 0;
      for (let i = SFB[b] ?? 0; i < (SFB[b + 1] ?? 0); i++) expected += ((xr[i] ?? 0) - (back[i] ?? 0)) ** 2;
      expect(noise[b]).toBeCloseTo(expected, 9);
    }
  });
});

describe('minGain', () => {
  it('is the lowest global_gain at which no value exceeds the codable maximum', () => {
    const xr = new Float64Array(576);
    xr[27] = 0.85;
    xr[300] = -3;
    const g = minGain(xr, noScale, SFB);
    expect(Math.max(...run(xr, g).map(Math.abs))).toBeLessThanOrEqual(MAX_QUANT - 1);
    expect(g).toBeGreaterThan(0);
    // one step finer would clip the larger value
    expect(Math.max(...run(xr, g - 1).map(Math.abs))).toBe(MAX_QUANT);
  });

  it('accounts for scale factors, which make the step finer', () => {
    const xr = new Float64Array(576).fill(1);
    const sf = new Int32Array(22);
    sf[3] = 6;
    expect(minGain(xr, sf, SFB)).toBe(minGain(xr, noScale, SFB) + 12);
  });

  it('returns 0 for silence', () => {
    expect(minGain(new Float64Array(576), noScale, SFB)).toBe(0);
  });
});
