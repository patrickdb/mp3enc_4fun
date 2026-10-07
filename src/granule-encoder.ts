import { analyzeSpectrum, estimateSpectrumBits, type SpectrumCoding } from './huffman.js';
import { bandNoise, minGain, quantize } from './quantize.js';
import { chooseScalefacCompress } from './scalefactors.js';

const MAX_GAIN = 255;
const MAX_PART23_BITS = 4095;
const MAX_ITERATIONS = 10;
const LOW_BANDS = 11;
const AMPLIFIABLE_BANDS = 21;
const MAX_SCALEFAC_LOW = 15;
const MAX_SCALEFAC_HIGH = 7;

export interface GranuleOptions {
  /** Upper bound for scale-factor bits plus Huffman bits (capped at 4095 by the 12-bit field). */
  readonly maxBits: number;
  /** After meeting the thresholds, coarsen the quantiser as far as they allow to save bits. */
  readonly tighten?: boolean;
  /** Linear factor applied to the allowed noise (below 1 asks for more precision than the mask needs). */
  readonly noiseScale?: number;
  /** Set to false to skip the scale-factor (noise shaping) loop. */
  readonly scalefactors?: boolean;
  /** Where to start the gain search (typically the previous granule's gain); never affects correctness. */
  readonly gainHint?: number;
}

export interface GranuleResult {
  readonly ix: Int32Array;
  readonly globalGain: number;
  readonly scalefacs: Int32Array;
  readonly scalefacCompress: number;
  readonly scalefacBits: number;
  readonly coding: SpectrumCoding;
  readonly part23Bits: number;
}

/** Exact-analysis steps tried below the gain the estimator accepted (the estimate is a safe upper bound). */
const REFINE_STEPS = 3;
const MAX_STALLS = 2;

/**
 * Inner loop: the finest global gain (>= floor) whose estimated Huffman bits fit in the budget.
 * The estimate never undercounts, so the gain is always safe. A galloping search starts from `hint`.
 */
function searchGain(
  xr: Float64Array, sf: Int32Array, sfb: readonly number[], budget: number, hint: number, scratch: Int32Array,
): number {
  const floor = minGain(xr, sf, sfb);
  const fits = (gain: number): boolean => {
    quantize(xr, gain, sf, sfb, scratch);
    return estimateSpectrumBits(scratch, sfb) <= budget;
  };
  const start = Math.min(MAX_GAIN, Math.max(floor, hint));
  let lo: number; // does not fit (or below the floor)
  let hi: number; // fits (or the maximum)
  if (fits(start)) {
    hi = start;
    lo = start - 1;
    for (let step = 1; lo >= floor && fits(lo); step *= 2) {
      hi = lo;
      lo -= step;
    }
    lo = Math.max(lo, floor - 1);
  } else {
    lo = start;
    hi = Math.min(MAX_GAIN, start + 1);
    for (let step = 2; hi < MAX_GAIN && !fits(hi); step *= 2) {
      lo = hi;
      hi = Math.min(MAX_GAIN, hi + step);
    }
  }
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function distortion(
  xr: Float64Array, ix: Int32Array, gain: number, sf: Int32Array, sfb: readonly number[],
  allowed: Float64Array, noise: Float64Array,
): { distorted: boolean[]; score: number } {
  quantize(xr, gain, sf, sfb, ix);
  bandNoise(xr, ix, gain, sf, sfb, noise);
  let score = 0;
  const distorted = Array.from(noise, (n, b) => {
    const over = n > (allowed[b] ?? Infinity);
    if (over) score += 1 + Math.log2(n / (allowed[b] ?? 1)) / 64;
    return over;
  });
  return { distorted, score };
}

function allBandsPass(
  xr: Float64Array, gain: number, sf: Int32Array, sfb: readonly number[], allowed: Float64Array,
  ix: Int32Array, noise: Float64Array,
): boolean {
  quantize(xr, gain, sf, sfb, ix);
  bandNoise(xr, ix, gain, sf, sfb, noise);
  return noise.every((n, b) => n <= (allowed[b] ?? Infinity));
}

interface Candidate {
  readonly sf: Int32Array;
  readonly gain: number;
  readonly compress: number;
  readonly scalefacBits: number;
  readonly score: number;
}

interface Problem {
  readonly xr: Float64Array;
  readonly sfb: readonly number[];
  readonly allowed: Float64Array;
  readonly maxBits: number;
  readonly scratch: Int32Array;
  readonly noise: Float64Array;
}

/** Raises the scale factor of every distorted band that still has headroom; returns whether any changed. */
function amplifyDistorted(sf: Int32Array, distorted: readonly boolean[]): boolean {
  let changed = false;
  for (let b = 0; b < AMPLIFIABLE_BANDS; b++) {
    const limit = b < LOW_BANDS ? MAX_SCALEFAC_LOW : MAX_SCALEFAC_HIGH;
    if (distorted[b] === true && (sf[b] ?? 0) < limit) {
      sf[b] = (sf[b] ?? 0) + 1;
      changed = true;
    }
  }
  return changed;
}

/** Outer loop: shape the noise with scale factors, remembering the least distorted state that fits. */
function shapeNoise(p: Problem, hint: number, iterations: number): Candidate | undefined {
  const sf = new Int32Array(p.sfb.length - 1);
  let best: Candidate | undefined;
  let gainHint = hint;
  let stalls = 0;
  for (let it = 0; it < iterations; it++) {
    const chosen = chooseScalefacCompress(sf);
    if (!chosen || chosen.bits >= p.maxBits) break;
    const gain = searchGain(p.xr, sf, p.sfb, p.maxBits - chosen.bits, gainHint, p.scratch);
    const { distorted, score } = distortion(p.xr, p.scratch, gain, sf, p.sfb, p.allowed, p.noise);
    if (!best || score < best.score) {
      best = { sf: sf.slice(), gain, compress: chosen.compress, scalefacBits: chosen.bits, score };
      stalls = 0;
    } else if (++stalls >= MAX_STALLS) {
      break;
    }
    gainHint = gain;
    if (score === 0 || !amplifyDistorted(sf, distorted)) break;
  }
  return best;
}

/** Exact analysis: tries a few finer gains the safe estimate may have rejected. */
function refineGain(p: Problem, best: Candidate): { gain: number; coding: SpectrumCoding | undefined } {
  const budget = p.maxBits - best.scalefacBits;
  const floor = minGain(p.xr, best.sf, p.sfb);
  let gain = best.gain;
  let coding: SpectrumCoding | undefined;
  for (let tries = 0; tries < REFINE_STEPS && gain > floor; tries++) {
    quantize(p.xr, gain - 1, best.sf, p.sfb, p.scratch);
    const finer = analyzeSpectrum(p.scratch, p.sfb);
    if (finer.bits > budget) break;
    gain--;
    coding = finer;
  }
  return { gain, coding };
}

/** Coarsest gain at or above `from` at which every band still meets its allowed noise. */
function tightenGain(p: Problem, sf: Int32Array, from: number): number {
  let lo = from;
  let hi = MAX_GAIN;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (allBandsPass(p.xr, mid, sf, p.sfb, p.allowed, p.scratch, p.noise)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Quantises and Huffman-codes one granule of one channel with the classic two nested loops:
 * the inner loop meets the bit budget, the outer loop raises scale factors of distorted bands.
 */
export function encodeGranule(
  xr: Float64Array,
  thresholds: Float64Array,
  sfb: readonly number[],
  options: GranuleOptions,
): GranuleResult {
  const scale = options.noiseScale ?? 1;
  const problem: Problem = {
    xr, sfb,
    allowed: thresholds.map((t) => t * scale),
    maxBits: Math.min(options.maxBits, MAX_PART23_BITS),
    scratch: new Int32Array(576),
    noise: new Float64Array(sfb.length - 1),
  };
  const hint = options.gainHint ?? 0;
  const shaped = shapeNoise(problem, hint, options.scalefactors === false ? 1 : MAX_ITERATIONS);
  const bare = new Int32Array(sfb.length - 1);
  const best: Candidate = shaped ?? {
    sf: bare,
    gain: searchGain(xr, bare, sfb, problem.maxBits, hint, problem.scratch),
    compress: 0, scalefacBits: 0, score: Infinity,
  };

  let { gain, coding } = refineGain(problem, best);
  if (options.tighten === true && best.score === 0) {
    const tighter = tightenGain(problem, best.sf, gain);
    if (tighter !== gain) {
      gain = tighter;
      coding = undefined;
    }
  }
  const ix = new Int32Array(576);
  quantize(xr, gain, best.sf, sfb, ix);
  coding ??= analyzeSpectrum(ix, sfb);
  return {
    ix,
    globalGain: gain,
    scalefacs: best.sf,
    scalefacCompress: best.compress,
    scalefacBits: best.scalefacBits,
    coding,
    part23Bits: coding.bits + best.scalefacBits,
  };
}
