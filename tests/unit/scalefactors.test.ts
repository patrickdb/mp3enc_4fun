import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../src/bitwriter.js';
import { SCALEFAC_SLEN, chooseScalefacCompress, scalefactorBits, writeScalefactors } from '../../src/scalefactors.js';

describe('scalefac_compress', () => {
  it('matches ISO Table 16 (slen1/slen2 per scalefac_compress)', () => {
    expect(SCALEFAC_SLEN).toEqual([
      [0, 0], [0, 1], [0, 2], [0, 3], [3, 0], [1, 1], [1, 2], [1, 3],
      [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3], [4, 2], [4, 3],
    ]);
  });

  it('picks compress 0 (no scale-factor bits) when all scale factors are zero', () => {
    const c = chooseScalefacCompress(new Int32Array(22));
    expect(c).toEqual({ compress: 0, bits: 0 });
  });

  it('picks the cheapest entry able to hold the largest values per band group', () => {
    const sf = new Int32Array(22);
    sf[2] = 1; // low group needs 1 bit
    sf[15] = 3; // high group needs 2 bits
    const c = chooseScalefacCompress(sf);
    expect(c?.compress).toBe(6); // slen1=1, slen2=2
    expect(c?.bits).toBe(11 * 1 + 10 * 2);
  });

  it('handles the maxima 15 (4 bits) and 7 (3 bits), and refuses what no entry can hold', () => {
    const sf = new Int32Array(22);
    sf[0] = 15;
    sf[11] = 7;
    expect(chooseScalefacCompress(sf)).toEqual({ compress: 15, bits: 44 + 30 });
    sf[11] = 8;
    expect(chooseScalefacCompress(sf)).toBeUndefined();
    sf[11] = 0;
    sf[0] = 16;
    expect(chooseScalefacCompress(sf)).toBeUndefined();
  });

  it('never needs bits for band 21, which has no scale factor', () => {
    const sf = new Int32Array(22);
    sf[21] = 5;
    expect(chooseScalefacCompress(sf)?.compress).toBe(0);
  });
});

describe('writeScalefactors', () => {
  it('writes bands 0-10 with slen1 bits and bands 11-20 with slen2 bits', () => {
    const sf = new Int32Array(22);
    sf[0] = 1;
    sf[10] = 1;
    sf[11] = 3;
    sf[20] = 2;
    const w = new BitWriter();
    writeScalefactors(w, sf, 6);
    expect(w.bitLength).toBe(scalefactorBits(6));
    expect(w.bitLength).toBe(31);
    const bytes = w.toBytes();
    const bit = (i: number): number => ((bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
    expect(bit(0)).toBe(1);
    expect(bit(10)).toBe(1);
    expect(bit(1)).toBe(0);
    expect([bit(11), bit(12)]).toEqual([1, 1]);
    expect([bit(29), bit(30)]).toEqual([1, 0]);
  });
});
