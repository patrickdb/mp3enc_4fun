/** Largest magnitude representable in the bitstream: 15 + (2^13 - 1) via table 23/31 escape bits. */
export const MAX_QUANT = 8206;
const ROUNDING = 0.4054;
const SCALEFAC_MULTIPLIER = 0.5; // scalefac_scale = 0

const POW43 = Float64Array.from({ length: MAX_QUANT + 1 }, (_, i) => i ** (4 / 3));

/** Step exponent (base 2) of a band: (global_gain - 210) / 4 - multiplier * scalefac. */
function stepExponent(gain: number, scalefac: number): number {
  return (gain - 210) / 4 - SCALEFAC_MULTIPLIER * scalefac;
}

/** ix = nint(|xr|^(3/4) / step^(3/4) - 0.0946), written with the ISO-suggested 0.4054 offset. */
export function quantize(
  xr: Float64Array,
  gain: number,
  scalefacs: Int32Array,
  sfb: readonly number[],
  out: Int32Array,
): void {
  for (let b = 0; b < sfb.length - 1; b++) {
    const mul = 2 ** (-0.75 * stepExponent(gain, scalefacs[b] ?? 0));
    for (let i = sfb[b] ?? 0; i < (sfb[b + 1] ?? 0); i++) {
      const v = xr[i] ?? 0;
      const a = Math.abs(v);
      const q = Math.min(MAX_QUANT, Math.floor(Math.sqrt(a * Math.sqrt(a)) * mul + ROUNDING));
      out[i] = v < 0 ? -q : q;
    }
  }
}

/** xr = sign(is) * |is|^(4/3) * 2^((global_gain - 210)/4 - multiplier * scalefac), per ISO/IEC 11172-3. */
export function dequantize(
  ix: Int32Array,
  gain: number,
  scalefacs: Int32Array,
  sfb: readonly number[],
  out: Float64Array,
): void {
  for (let b = 0; b < sfb.length - 1; b++) {
    const step = 2 ** stepExponent(gain, scalefacs[b] ?? 0);
    for (let i = sfb[b] ?? 0; i < (sfb[b + 1] ?? 0); i++) {
      const q = ix[i] ?? 0;
      const mag = (POW43[Math.abs(q)] ?? 0) * step;
      out[i] = q < 0 ? -mag : mag;
    }
  }
}

/** Squared quantisation error summed over each scale-factor band. */
export function bandNoise(
  xr: Float64Array,
  ix: Int32Array,
  gain: number,
  scalefacs: Int32Array,
  sfb: readonly number[],
  out: Float64Array,
): void {
  for (let b = 0; b < sfb.length - 1; b++) {
    const step = 2 ** stepExponent(gain, scalefacs[b] ?? 0);
    let sum = 0;
    for (let i = sfb[b] ?? 0; i < (sfb[b + 1] ?? 0); i++) {
      const err = Math.abs(xr[i] ?? 0) - (POW43[Math.abs(ix[i] ?? 0)] ?? 0) * step;
      sum += err * err;
    }
    out[b] = sum;
  }
}

/** Lowest global_gain (0..255) at which no line of the spectrum saturates at MAX_QUANT. */
export function minGain(xr: Float64Array, scalefacs: Int32Array, sfb: readonly number[]): number {
  const limit = (MAX_QUANT + 1 - ROUNDING) ** (4 / 3);
  let gain = 0;
  for (let b = 0; b < sfb.length - 1; b++) {
    let peak = 0;
    for (let i = sfb[b] ?? 0; i < (sfb[b + 1] ?? 0); i++) peak = Math.max(peak, Math.abs(xr[i] ?? 0));
    if (peak === 0) continue;
    // step = 2^((gain - 210)/4 - 0.5 sf) must exceed peak / limit
    const needed = 210 + 4 * (Math.log2(peak / limit) + SCALEFAC_MULTIPLIER * (scalefacs[b] ?? 0));
    gain = Math.max(gain, Math.floor(needed) + 1);
  }
  return Math.min(255, gain);
}
