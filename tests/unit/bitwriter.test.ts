import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../src/bitwriter.js';

describe('BitWriter', () => {
  it('starts empty', () => {
    const w = new BitWriter();
    expect(w.bitLength).toBe(0);
    expect(w.toBytes()).toEqual(new Uint8Array(0));
  });

  it('writes bits most-significant first', () => {
    const w = new BitWriter();
    w.writeBits(0b101, 3);
    w.writeBits(0b11001, 5);
    expect([...w.toBytes()]).toEqual([0b10111001]);
    expect(w.bitLength).toBe(8);
  });

  it('pads the last byte with zero bits', () => {
    const w = new BitWriter();
    w.writeBits(0b1, 1);
    expect([...w.toBytes()]).toEqual([0b10000000]);
  });

  it('writes values spanning multiple bytes', () => {
    const w = new BitWriter();
    w.writeBits(0xabcdef, 24);
    expect([...w.toBytes()]).toEqual([0xab, 0xcd, 0xef]);
  });

  it('writes up to 32 bits at once', () => {
    const w = new BitWriter();
    w.writeBits(0xdeadbeef, 32);
    expect([...w.toBytes()]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('writes code strings such as Huffman codes', () => {
    const w = new BitWriter();
    w.writeCode('0101');
    w.writeCode('1');
    w.writeCode('');
    expect(w.bitLength).toBe(5);
    expect([...w.toBytes()]).toEqual([0b01011000]);
  });

  it('ignores high bits of the value beyond n', () => {
    const w = new BitWriter();
    w.writeBits(0b1111, 2);
    expect([...w.toBytes()]).toEqual([0b11000000]);
  });

  it('appends another writer bit-exactly', () => {
    const a = new BitWriter();
    a.writeBits(0b101, 3);
    const b = new BitWriter();
    b.writeBits(0b0110011, 7);
    a.append(b);
    expect(a.bitLength).toBe(10);
    expect([...a.toBytes()]).toEqual([0b10101100, 0b11000000]);
  });

  it('rejects invalid widths', () => {
    const w = new BitWriter();
    expect(() => { w.writeBits(1, 33); }).toThrow(RangeError);
    expect(() => { w.writeBits(1, -1); }).toThrow(RangeError);
  });
});
