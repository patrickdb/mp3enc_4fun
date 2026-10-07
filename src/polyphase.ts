import { ANALYSIS_WINDOW } from './tables/window-data.js';

const BANDS = 32;
const TAPS = 512;

const WINDOW = Float64Array.from(ANALYSIS_WINDOW);
/** MATRIX[i * 64 + k] = cos((2i + 1)(k - 16) pi / 64), ISO/IEC 11172-3 Annex C.1.3. */
const MATRIX = new Float64Array(BANDS * 64);
for (let i = 0; i < BANDS; i++) {
  for (let k = 0; k < 64; k++) MATRIX[i * 64 + k] = Math.cos(((2 * i + 1) * (k - 16) * Math.PI) / 64);
}

/** 32-band polyphase analysis filterbank; each call consumes 32 PCM samples and yields 32 subband samples. */
export class PolyphaseAnalyzer {
  private readonly x = new Float64Array(TAPS);
  private readonly y = new Float64Array(64);

  process(samples: ArrayLike<number>, out: Float64Array): void {
    const { x, y } = this;
    x.copyWithin(BANDS, 0, TAPS - BANDS);
    for (let i = 0; i < BANDS; i++) x[BANDS - 1 - i] = samples[i] ?? 0;
    for (let i = 0; i < 64; i++) {
      let sum = 0;
      for (let j = 0; j < 8; j++) sum += (WINDOW[i + 64 * j] ?? 0) * (x[i + 64 * j] ?? 0);
      y[i] = sum;
    }
    for (let i = 0; i < BANDS; i++) {
      let sum = 0;
      const row = i * 64;
      for (let k = 0; k < 64; k++) sum += (MATRIX[row + k] ?? 0) * (y[k] ?? 0);
      out[i] = sum;
    }
  }
}
