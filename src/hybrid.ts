import { ALIAS_COEFFICIENTS } from './tables/window-data.js';

const LINES = 576;
const SUBBANDS = 32;
const LINES_PER_BAND = 18;

/** MDCT_TABLE[k * 36 + n] = sin window * cos((2n + 19)(2k + 1) pi / 72) / 9; the 1/9 makes the ISO IMDCT an exact inverse. */
const MDCT_TABLE = new Float64Array(LINES_PER_BAND * 36);
for (let k = 0; k < LINES_PER_BAND; k++) {
  for (let n = 0; n < 36; n++) {
    MDCT_TABLE[k * 36 + n] =
      (Math.sin((Math.PI / 36) * (n + 0.5)) * Math.cos((Math.PI / 72) * (2 * n + 19) * (2 * k + 1))) / 9;
  }
}
const ALIAS_CS = ALIAS_COEFFICIENTS.map((c) => 1 / Math.sqrt(1 + c * c));
const ALIAS_CA = ALIAS_COEFFICIENTS.map((c) => c / Math.sqrt(1 + c * c));

/** Long-block-only hybrid filterbank stage: frequency inversion, 36-point MDCT with overlap, alias reduction. */
export class HybridAnalyzer {
  private previous = new Float64Array(LINES);
  private readonly current = new Float64Array(LINES);
  private readonly block = new Float64Array(36);

  /**
   * @param subbandSamples 576 polyphase outputs laid out as [subband * 18 + time]
   * @param xr receives the 576 spectral lines
   */
  process(subbandSamples: Float64Array, xr: Float64Array): void {
    const { current, block } = this;
    current.set(subbandSamples);
    for (let sb = 1; sb < SUBBANDS; sb += 2) {
      for (let t = 1; t < LINES_PER_BAND; t += 2) current[sb * LINES_PER_BAND + t] = -(current[sb * LINES_PER_BAND + t] ?? 0);
    }
    for (let sb = 0; sb < SUBBANDS; sb++) {
      const base = sb * LINES_PER_BAND;
      for (let n = 0; n < LINES_PER_BAND; n++) {
        block[n] = this.previous[base + n] ?? 0;
        block[n + LINES_PER_BAND] = current[base + n] ?? 0;
      }
      for (let k = 0; k < LINES_PER_BAND; k++) {
        let sum = 0;
        const row = k * 36;
        for (let n = 0; n < 36; n++) sum += (MDCT_TABLE[row + n] ?? 0) * (block[n] ?? 0);
        xr[base + k] = sum;
      }
    }
    [this.previous] = [current.slice()];
    for (let sb = 1; sb < SUBBANDS; sb++) {
      for (let i = 0; i < 8; i++) {
        const lo = LINES_PER_BAND * sb - 1 - i;
        const up = LINES_PER_BAND * sb + i;
        const a = xr[lo] ?? 0;
        const b = xr[up] ?? 0;
        const cs = ALIAS_CS[i] ?? 1;
        const ca = ALIAS_CA[i] ?? 0;
        xr[lo] = a * cs + b * ca;
        xr[up] = b * cs - a * ca;
      }
    }
  }
}
