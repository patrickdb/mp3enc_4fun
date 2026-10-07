import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../src/bitwriter.js';
import { FrameAssembler } from '../../src/frame-assembler.js';
import { frameSizeBytes, type GranuleChannelInfo } from '../../src/frame-format.js';
import { mainDataStreams, parseFrames } from '../helpers/mp3-parser.js';

const info: GranuleChannelInfo = {
  part23Length: 0, bigValues: 0, globalGain: 0, scalefacCompress: 0,
  tableSelect: [0, 0, 0], region0Count: 0, region1Count: 0,
  preflag: false, scalefacScale: false, count1TableSelect: 0,
};

function payload(bytes: number, fill: number): BitWriter {
  const w = new BitWriter();
  for (let i = 0; i < bytes; i++) w.writeBits((fill + i) & 0xff, 8);
  return w;
}

function add(a: FrameAssembler, bytes: number, fill: number, kbps = 128): void {
  const granules = [[info], [info]];
  a.addFrame({ bitrateKbps: kbps, padding: false, granules, mainData: payload(bytes, fill) });
}

describe('FrameAssembler', () => {
  it('emits complete frames of the right size with header and zero main_data_begin first', () => {
    const a = new FrameAssembler(44100, 1);
    add(a, 20, 1);
    const out = a.finish();
    expect(out).toHaveLength(frameSizeBytes(44100, 128, false));
    const [f] = parseFrames(out);
    expect(f?.mainDataBegin).toBe(0);
    expect([...out.slice(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
    expect([...out.slice(21, 25)]).toEqual([1, 2, 3, 4]);
  });

  it('reports the free bytes left in a frame as reservoir for the next frame', () => {
    const a = new FrameAssembler(44100, 2);
    const slot = a.slotBytes(128, false);
    expect(slot).toBe(417 - 4 - 32);
    add(a, 100, 0);
    expect(a.reservoirBytes).toBe(slot - 100);
  });

  it('lets a big frame borrow from the reservoir, and the pointers resolve correctly', () => {
    const a = new FrameAssembler(44100, 2);
    const slot = a.slotBytes(128, false);
    const sizes = [100, 50, slot + 150, 300, slot + 20, 10, 10, slot + 200];
    const expected = sizes.map((n, i) => payload(n, i * 17).toBytes());
    sizes.forEach((n, i) => { add(a, n, i * 17); });
    const frames = parseFrames(a.finish());
    expect(frames).toHaveLength(sizes.length);
    const streams = mainDataStreams(frames);
    expected.forEach((want, i) => {
      expect([...(streams[i] ?? []).slice(0, want.length)]).toEqual([...want]);
    });
    // 281 + 331 free bytes would be 612, but the 9-bit pointer caps the reservoir at 511
    expect(frames[2]?.mainDataBegin).toBe(511);
  });

  it('caps the reservoir at 511 bytes by stuffing, so main_data_begin always fits 9 bits', () => {
    const a = new FrameAssembler(44100, 2);
    for (let i = 0; i < 10; i++) add(a, 5, i);
    expect(a.reservoirBytes).toBe(511);
    const frames = parseFrames(a.finish());
    for (const f of frames) expect(f.mainDataBegin).toBeLessThanOrEqual(511);
  });

  it('rejects main data that cannot fit in reservoir plus slot', () => {
    const a = new FrameAssembler(44100, 2);
    const slot = a.slotBytes(128, false);
    expect(() => { add(a, slot + 1, 0); }).toThrow(/capacity|fit/i);
  });

  it('flushes all data by the end of the stream', () => {
    const a = new FrameAssembler(32000, 2);
    const slot = a.slotBytes(64, false);
    add(a, 20, 3, 64);
    add(a, slot + 15, 9, 64);
    const frames = parseFrames(a.finish());
    const streams = mainDataStreams(frames);
    expect([...(streams[1] ?? []).slice(0, slot + 15)]).toEqual([...payload(slot + 15, 9).toBytes()]);
  });

  it('writes the side-info granule parameters into each frame', () => {
    const a = new FrameAssembler(44100, 1);
    a.addFrame({
      bitrateKbps: 128, padding: false,
      granules: [[{ ...info, globalGain: 0xa5 }], [{ ...info, globalGain: 0x5a }]],
      mainData: payload(4, 0),
    });
    const out = a.finish();
    const bit = (start: number, n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + (((out[4 + ((start + i) >> 3)] ?? 0) >> (7 - ((start + i) & 7))) & 1);
      return v;
    };
    expect(bit(39, 8)).toBe(0xa5);
    expect(bit(39 + 59, 8)).toBe(0x5a);
  });
});
