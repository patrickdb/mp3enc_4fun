/**
 * Minimal decoder-side filterbank pieces written straight from ISO/IEC 11172-3 clause 2.4.3,
 * used only to verify that the encoder's analysis stages are invertible.
 */
import { ALIAS_COEFFICIENTS, ANALYSIS_WINDOW } from '../../src/tables/window-data.js';

/** ISO synthesis subband filter: D[i] = 32 * C[i]. */
export class ReferenceSynthesis {
  private readonly v = new Float64Array(1024);
  private readonly cosTable: Float64Array[];
  constructor() {
    this.cosTable = Array.from({ length: 64 }, (_, i) =>
      Float64Array.from({ length: 32 }, (_, k) => Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64)));
  }

  /** Consumes 32 subband samples and returns 32 PCM samples. */
  process(s: ArrayLike<number>): Float64Array {
    this.v.copyWithin(64, 0, 960);
    for (let i = 0; i < 64; i++) {
      let sum = 0;
      const row = this.cosTable[i];
      if (!row) throw new Error('table');
      for (let k = 0; k < 32; k++) sum += (row[k] ?? 0) * (s[k] ?? 0);
      this.v[i] = sum;
    }
    const out = new Float64Array(32);
    for (let j = 0; j < 32; j++) {
      let sum = 0;
      for (let i = 0; i < 8; i++) {
        sum += (this.v[128 * i + j] ?? 0) * 32 * (ANALYSIS_WINDOW[64 * i + j] ?? 0);
        sum += (this.v[128 * i + 96 + j] ?? 0) * 32 * (ANALYSIS_WINDOW[64 * i + 32 + j] ?? 0);
      }
      out[j] = sum;
    }
    return out;
  }
}

/** ISO hybrid synthesis for long blocks: alias reduction, 36-point IMDCT with overlap-add, frequency inversion. */
export class ReferenceHybridSynthesis {
  private readonly overlap = new Float64Array(576);

  /** xr: 576 dequantised lines -> 576 subband samples laid out as [subband * 18 + time]. */
  process(xrIn: ArrayLike<number>): Float64Array {
    const xr = Float64Array.from(xrIn as ArrayLike<number> & Iterable<number>);
    for (let sb = 1; sb < 32; sb++) {
      for (let i = 0; i < 8; i++) {
        const c = ALIAS_COEFFICIENTS[i] ?? 0;
        const cs = 1 / Math.sqrt(1 + c * c);
        const ca = c / Math.sqrt(1 + c * c);
        const lo = 18 * sb - 1 - i;
        const up = 18 * sb + i;
        const a = xr[lo] ?? 0;
        const b = xr[up] ?? 0;
        xr[lo] = a * cs - b * ca;
        xr[up] = b * cs + a * ca;
      }
    }
    const out = new Float64Array(576);
    for (let sb = 0; sb < 32; sb++) {
      for (let i = 0; i < 36; i++) {
        let x = 0;
        for (let k = 0; k < 18; k++) {
          x += (xr[sb * 18 + k] ?? 0) * Math.cos((Math.PI / 72) * (2 * i + 1 + 18) * (2 * k + 1));
        }
        x *= Math.sin((Math.PI / 36) * (i + 0.5));
        if (i < 18) out[sb * 18 + i] = x + (this.overlap[sb * 18 + i] ?? 0);
        else this.overlap[sb * 18 + i - 18] = x;
      }
    }
    for (let sb = 1; sb < 32; sb += 2) {
      for (let t = 1; t < 18; t += 2) out[sb * 18 + t] = -(out[sb * 18 + t] ?? 0);
    }
    return out;
  }
}
