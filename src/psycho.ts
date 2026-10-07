/**
 * Simplified psychoacoustic model working directly on the MDCT spectrum (one threshold per
 * scale-factor band). It combines the absolute threshold of hearing with a spread masking
 * threshold whose offset below the masker depends on how tonal the masker is.
 */

/** Level, in dB SPL, assumed for a full-scale sine; only the ATH calibration depends on it. */
const FULL_SCALE_DB = 84;
/** Energy of the spectrum per unit PCM power (a full-scale sine has 0.5 power and ~0.785 spectral energy). */
const SPECTRAL_GAIN = 1.57;
const LINES = 576;
const MAX_ATH_FREQ_KHZ = 16;
/** Masker offset below its energy: noise-like 6 dB, fully tonal 20 dB. */
const NOISE_OFFSET_DB = 6;
const TONAL_EXTRA_DB = 14;
const TONALITY_SPAN_DB = 30;
/** Spreading per band (target above masker falls slowly, target below falls steeply), in dB. */
const SPREAD_UP_DB = 10;
const SPREAD_DOWN_DB = 27;
const SPREAD_REACH = 6;

/** Terhardt's approximation of the threshold in quiet, in dB SPL. */
function athDb(freqKhz: number): number {
  const f = Math.min(Math.max(freqKhz, 0.02), MAX_ATH_FREQ_KHZ);
  return 3.64 * f ** -0.8 - 6.5 * Math.exp(-0.6 * (f - 3.3) ** 2) + 1e-3 * f ** 4;
}

/** ATH expressed as allowed noise energy per scale-factor band. */
export function absoluteThreshold(sfb: readonly number[], sampleRate: number): Float64Array {
  const bands = sfb.length - 1;
  const out = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    const lo = sfb[b] ?? 0;
    const hi = sfb[b + 1] ?? 0;
    const freqKhz = (((lo + hi) / 2) * (sampleRate / 2)) / LINES / 1000;
    out[b] = SPECTRAL_GAIN * 10 ** ((athDb(freqKhz) - FULL_SCALE_DB) / 10) * ((hi - lo) / LINES);
  }
  return out;
}

function tonality(xr: Float64Array, lo: number, hi: number, energy: number): number {
  const width = hi - lo;
  let logSum = 0;
  for (let i = lo; i < hi; i++) logSum += Math.log((xr[i] ?? 0) ** 2 + 1e-30);
  const sfmDb = 10 * Math.log10(Math.exp(logSum / width) / (energy / width));
  return Math.min(1, Math.max(0, -sfmDb / TONALITY_SPAN_DB));
}

/** Fills `out` with the allowed noise energy for each band of one granule. */
export function computeThresholds(xr: Float64Array, sfb: readonly number[], sampleRate: number, out: Float64Array): void {
  const bands = sfb.length - 1;
  const ath = absoluteThreshold(sfb, sampleRate);
  const maskerDensity = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    const lo = sfb[b] ?? 0;
    const hi = sfb[b + 1] ?? 0;
    let energy = 0;
    for (let i = lo; i < hi; i++) energy += (xr[i] ?? 0) ** 2;
    if (energy > 0) {
      const offset = NOISE_OFFSET_DB + TONAL_EXTRA_DB * tonality(xr, lo, hi, energy);
      maskerDensity[b] = (energy / (hi - lo)) * 10 ** (-offset / 10);
    }
  }
  for (let b = 0; b < bands; b++) {
    let masked = 0;
    for (let j = Math.max(0, b - SPREAD_REACH); j <= Math.min(bands - 1, b + SPREAD_REACH); j++) {
      const d = b - j;
      const spread = 10 ** (-(d >= 0 ? SPREAD_UP_DB * d : SPREAD_DOWN_DB * -d) / 10);
      masked = Math.max(masked, (maskerDensity[j] ?? 0) * spread);
    }
    out[b] = Math.max(ath[b] ?? 0, masked * ((sfb[b + 1] ?? 0) - (sfb[b] ?? 0)));
  }
}

/** Approximate number of bits needed to code the granule transparently (sum of width * log2(1 + SMR)). */
export function perceptualEntropy(xr: Float64Array, sfb: readonly number[], thresholds: Float64Array): number {
  let pe = 0;
  for (let b = 0; b < sfb.length - 1; b++) {
    const lo = sfb[b] ?? 0;
    const hi = sfb[b + 1] ?? 0;
    let energy = 0;
    for (let i = lo; i < hi; i++) energy += (xr[i] ?? 0) ** 2;
    pe += (hi - lo) * Math.log2(1 + energy / (thresholds[b] ?? 1));
  }
  return pe;
}
