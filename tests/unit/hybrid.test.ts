import { describe, expect, it } from 'vitest';
import { HybridAnalyzer } from '../../src/hybrid.js';
import { ReferenceHybridSynthesis } from '../helpers/reference-decoder.js';

function randomGranule(seed: number): Float64Array {
  let s = seed;
  return Float64Array.from({ length: 576 }, () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32 - 0.5;
  });
}

describe('HybridAnalyzer (MDCT + alias reduction)', () => {
  it('reconstructs subband samples through the ISO hybrid synthesis, one granule late', () => {
    const analyzer = new HybridAnalyzer();
    const synth = new ReferenceHybridSynthesis();
    const input = Array.from({ length: 6 }, (_, g) => randomGranule(100 + g));
    const decoded: Float64Array[] = [];
    for (const g of input) {
      const xr = new Float64Array(576);
      analyzer.process(g, xr);
      decoded.push(synth.process(xr));
    }
    for (let g = 1; g < input.length; g++) {
      const want = input[g - 1];
      const got = decoded[g];
      expect(want && got).toBeTruthy();
      let maxErr = 0;
      for (let i = 0; i < 576; i++) maxErr = Math.max(maxErr, Math.abs((got?.[i] ?? 0) - (want?.[i] ?? 0)));
      expect(maxErr).toBeLessThan(1e-9);
    }
  });

  it('maps a constant (DC) even-subband signal to the lines at the start of that subband', () => {
    const analyzer = new HybridAnalyzer();
    const g = new Float64Array(576);
    g.fill(1, 2 * 18, 3 * 18);
    const xr = new Float64Array(576);
    analyzer.process(g, xr);
    analyzer.process(g, xr);
    // lines 2*18-8 .. 2*18+8 cover the DC lines plus the alias-reduction butterflies at the subband edge
    const nearStart = xr.slice(2 * 18 - 8, 2 * 18 + 8).reduce((a, b) => a + b * b, 0);
    const total = xr.reduce((a, b) => a + b * b, 0);
    expect(nearStart / total).toBeGreaterThan(0.95);
  });

  it('outputs zeros for silence', () => {
    const analyzer = new HybridAnalyzer();
    const xr = new Float64Array(576).fill(9);
    analyzer.process(new Float64Array(576), xr);
    expect(xr.every((v) => v === 0)).toBe(true);
  });
});
