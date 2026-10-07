import { describe, expect, it } from 'vitest';
import { PolyphaseAnalyzer } from '../../src/polyphase.js';
import { ANALYSIS_WINDOW } from '../../src/tables/window-data.js';
import { ReferenceSynthesis } from '../helpers/reference-decoder.js';

function analyze(signal: Float64Array): Float64Array[] {
  const analyzer = new PolyphaseAnalyzer();
  const blocks: Float64Array[] = [];
  for (let i = 0; i + 32 <= signal.length; i += 32) {
    const out = new Float64Array(32);
    analyzer.process(signal.subarray(i, i + 32), out);
    blocks.push(out);
  }
  return blocks;
}

describe('analysis window table', () => {
  it('has 512 coefficients with the known centre peak C[256] = 0.035780907', () => {
    expect(ANALYSIS_WINDOW).toHaveLength(512);
    expect(ANALYSIS_WINDOW[256]).toBeCloseTo(0.035780907, 9);
    expect(ANALYSIS_WINDOW[0]).toBe(0);
  });
});

describe('PolyphaseAnalyzer', () => {
  it('concentrates a tone at a subband centre in that subband', () => {
    const sr = 44100;
    const target = 5;
    const f = ((target + 0.5) * sr) / 64;
    const signal = Float64Array.from({ length: 32 * 40 }, (_, n) => Math.sin((2 * Math.PI * f * n) / sr));
    const blocks = analyze(signal).slice(20);
    const energy = new Float64Array(32);
    for (const b of blocks) b.forEach((v, k) => { energy[k] = (energy[k] ?? 0) + v * v; });
    const total = energy.reduce((a, b) => a + b, 0);
    expect((energy[target] ?? 0) / total).toBeGreaterThan(0.98);
  });

  it('is invertible by the ISO synthesis filterbank with a delay of 481 samples', () => {
    let seed = 7;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 - 0.5; };
    const signal = Float64Array.from({ length: 32 * 64 }, () => rnd());
    const synth = new ReferenceSynthesis();
    const decoded: number[] = [];
    for (const block of analyze(signal)) decoded.push(...synth.process(block));
    let maxErr = 0;
    for (let n = 0; n < signal.length - 481; n++) {
      maxErr = Math.max(maxErr, Math.abs((decoded[n + 481] ?? 0) - (signal[n] ?? 0)));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('outputs silence for silence', () => {
    const blocks = analyze(new Float64Array(320));
    for (const b of blocks) for (const v of b) expect(v).toBe(0);
  });
});
