import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../src/bitwriter.js';
import {
  BITRATES_KBPS, FramePadder, bitrateIndex, encodeHeader, frameSizeBytes, sideInfoBytes, writeSideInfo,
  type GranuleChannelInfo,
} from '../../src/frame-format.js';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('frame header', () => {
  it('encodes 44.1 kHz / 128 kbps stereo as the classic FF FB 90 00', () => {
    expect(hex(encodeHeader({ sampleRate: 44100, bitrateKbps: 128, padding: false, channels: 2 }))).toBe('fffb9000');
  });

  it('encodes mono (mode 11), padding and other sample rates', () => {
    expect(hex(encodeHeader({ sampleRate: 48000, bitrateKbps: 192, padding: true, channels: 1 }))).toBe('fffbb6c0');
    expect(hex(encodeHeader({ sampleRate: 32000, bitrateKbps: 32, padding: false, channels: 2 }))).toBe('fffb1800');
  });

  it('maps every valid MPEG-1 Layer III bitrate to its table index', () => {
    expect(BITRATES_KBPS).toEqual([32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]);
    expect(bitrateIndex(32)).toBe(1);
    expect(bitrateIndex(128)).toBe(9);
    expect(bitrateIndex(320)).toBe(14);
    expect(() => bitrateIndex(169)).toThrow(/bitrate/i);
    expect(() => bitrateIndex(296)).toThrow(/bitrate/i);
  });

  it('computes frame sizes: floor(144000*kbps/rate) + padding', () => {
    expect(frameSizeBytes(44100, 128, false)).toBe(417);
    expect(frameSizeBytes(44100, 128, true)).toBe(418);
    expect(frameSizeBytes(48000, 192, false)).toBe(576);
    expect(frameSizeBytes(32000, 256, false)).toBe(1152);
  });

  it('has 17 side-info bytes for mono and 32 for stereo', () => {
    expect(sideInfoBytes(1)).toBe(17);
    expect(sideInfoBytes(2)).toBe(32);
  });
});

describe('FramePadder', () => {
  it('reaches the exact bitrate on average at 44.1 kHz', () => {
    const padder = new FramePadder(44100);
    let total = 0;
    const frames = 4410;
    for (let i = 0; i < frames; i++) total += frameSizeBytes(44100, 128, padder.nextPadding(128));
    const seconds = (frames * 1152) / 44100;
    expect((total * 8) / seconds / 1000).toBeCloseTo(128, 1);
  });

  it('never pads when the frame size is an integer (48 kHz / 128 kbps = 384 B)', () => {
    const padder = new FramePadder(48000);
    for (let i = 0; i < 100; i++) expect(padder.nextPadding(128)).toBe(false);
  });
});

function granule(overrides: Partial<GranuleChannelInfo> = {}): GranuleChannelInfo {
  return {
    part23Length: 0, bigValues: 0, globalGain: 0, scalefacCompress: 0,
    tableSelect: [0, 0, 0], region0Count: 0, region1Count: 0,
    preflag: false, scalefacScale: false, count1TableSelect: 0, ...overrides,
  };
}

describe('writeSideInfo', () => {
  it('writes 17 bytes for mono and 32 for stereo', () => {
    const mono = new BitWriter();
    writeSideInfo(mono, 1, 0, [[granule()], [granule()]]);
    expect(mono.toBytes()).toHaveLength(17);
    const stereo = new BitWriter();
    writeSideInfo(stereo, 2, 0, [[granule(), granule()], [granule(), granule()]]);
    expect(stereo.toBytes()).toHaveLength(32);
  });

  it('places fields at their ISO bit positions (mono, granule 0)', () => {
    const w = new BitWriter();
    const g = granule({
      part23Length: 0xabc, bigValues: 0x1ff, globalGain: 0xa5, scalefacCompress: 0x9,
      tableSelect: [0x1f, 0x00, 0x15], region0Count: 0xa, region1Count: 0x5,
      preflag: true, scalefacScale: false, count1TableSelect: 1,
    });
    writeSideInfo(w, 1, 0x155, [[g], [granule()]]);
    const bytes = w.toBytes();
    const read = (start: number, n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + (((bytes[(start + i) >> 3] ?? 0) >> (7 - ((start + i) & 7))) & 1);
      return v;
    };
    expect(read(0, 9)).toBe(0x155); // main_data_begin
    expect(read(9, 5)).toBe(0); // private bits (mono)
    expect(read(14, 4)).toBe(0); // scfsi
    expect(read(18, 12)).toBe(0xabc); // part2_3_length
    expect(read(30, 9)).toBe(0x1ff); // big_values
    expect(read(39, 8)).toBe(0xa5); // global_gain
    expect(read(47, 4)).toBe(0x9); // scalefac_compress
    expect(read(51, 1)).toBe(0); // window_switching_flag
    expect(read(52, 5)).toBe(0x1f); // table_select[0]
    expect(read(57, 5)).toBe(0x00);
    expect(read(62, 5)).toBe(0x15);
    expect(read(67, 4)).toBe(0xa); // region0_count
    expect(read(71, 3)).toBe(0x5); // region1_count
    expect(read(74, 1)).toBe(1); // preflag
    expect(read(75, 1)).toBe(0); // scalefac_scale
    expect(read(76, 1)).toBe(1); // count1table_select
  });

  it('rejects main_data_begin beyond 9 bits', () => {
    expect(() => { writeSideInfo(new BitWriter(), 1, 512, [[granule()], [granule()]]); }).toThrow(RangeError);
  });
});
