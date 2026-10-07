import type { BitWriter } from './bitwriter.js';

/** ISO/IEC 11172-3 Table 16: [slen1, slen2] for each scalefac_compress value. */
export const SCALEFAC_SLEN: readonly (readonly [number, number])[] = [
  [0, 0], [0, 1], [0, 2], [0, 3], [3, 0], [1, 1], [1, 2], [1, 3],
  [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3], [4, 2], [4, 3],
];
const LOW_BANDS = 11; // bands 0..10 use slen1
const HIGH_BANDS = 10; // bands 11..20 use slen2; band 21 carries no scale factor

export function scalefactorBits(compress: number): number {
  const [slen1, slen2] = SCALEFAC_SLEN[compress] ?? [0, 0];
  return LOW_BANDS * slen1 + HIGH_BANDS * slen2;
}

/** Finds the cheapest scalefac_compress able to carry the given scale factors, or undefined if none can. */
export function chooseScalefacCompress(sf: Int32Array): { compress: number; bits: number } | undefined {
  let maxLow = 0;
  let maxHigh = 0;
  for (let b = 0; b < LOW_BANDS; b++) maxLow = Math.max(maxLow, sf[b] ?? 0);
  for (let b = LOW_BANDS; b < LOW_BANDS + HIGH_BANDS; b++) maxHigh = Math.max(maxHigh, sf[b] ?? 0);
  let best: { compress: number; bits: number } | undefined;
  SCALEFAC_SLEN.forEach(([slen1, slen2], compress) => {
    if (maxLow >= 2 ** slen1 || maxHigh >= 2 ** slen2) return;
    const bits = scalefactorBits(compress);
    if (!best || bits < best.bits) best = { compress, bits };
  });
  return best;
}

export function writeScalefactors(w: BitWriter, sf: Int32Array, compress: number): void {
  const [slen1, slen2] = SCALEFAC_SLEN[compress] ?? [0, 0];
  for (let b = 0; b < LOW_BANDS; b++) w.writeBits(sf[b] ?? 0, slen1);
  for (let b = LOW_BANDS; b < LOW_BANDS + HIGH_BANDS; b++) w.writeBits(sf[b] ?? 0, slen2);
}
