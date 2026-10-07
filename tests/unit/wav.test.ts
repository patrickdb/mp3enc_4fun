import { describe, expect, it } from 'vitest';
import { parseWav } from '../../src/wav.js';
import { buildWav } from '../helpers/wav-builder.js';

describe('parseWav', () => {
  it('parses mono 16-bit PCM', () => {
    const wav = parseWav(buildWav({ sampleRate: 44100, channels: 1, samples: Int16Array.of(0, 16384, -16384, 32767, -32768) }));
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels).toBe(1);
    expect(wav.frameCount).toBe(5);
    expect(wav.data).toHaveLength(1);
    const ch0 = wav.data[0];
    expect(ch0?.[0]).toBe(0);
    expect(ch0?.[1]).toBeCloseTo(0.5, 6);
    expect(ch0?.[2]).toBeCloseTo(-0.5, 6);
    expect(ch0?.[4]).toBe(-1);
  });

  it('de-interleaves stereo', () => {
    const wav = parseWav(buildWav({ sampleRate: 48000, channels: 2, samples: Int16Array.of(100, -100, 200, -200, 300, -300) }));
    expect(wav.channels).toBe(2);
    expect(wav.frameCount).toBe(3);
    expect(wav.data[0]?.[1]).toBeCloseTo(200 / 32768, 9);
    expect(wav.data[1]?.[1]).toBeCloseTo(-200 / 32768, 9);
  });

  it('skips unknown chunks such as LIST, including odd-sized ones', () => {
    const wav = parseWav(buildWav({
      sampleRate: 32000, channels: 1, samples: Int16Array.of(1, 2, 3),
      extraChunks: [{ id: 'LIST', data: Uint8Array.of(1, 2, 3) }],
    }));
    expect(wav.frameCount).toBe(3);
  });

  it('accepts the three MPEG-1 sample rates only', () => {
    for (const rate of [32000, 44100, 48000]) {
      expect(parseWav(buildWav({ sampleRate: rate, channels: 1, samples: Int16Array.of(0) })).sampleRate).toBe(rate);
    }
    expect(() => parseWav(buildWav({ sampleRate: 22050, channels: 1, samples: Int16Array.of(0) }))).toThrow(/sample rate/i);
  });

  it('rejects more than two channels', () => {
    expect(() => parseWav(buildWav({ sampleRate: 44100, channels: 3, samples: Int16Array.of(0, 0, 0) }))).toThrow(/channel/i);
  });

  it('rejects files that are not RIFF/WAVE', () => {
    expect(() => parseWav(Buffer.from('this is definitely not a wav file at all, honest'))).toThrow(/RIFF|WAVE/);
    expect(() => parseWav(Buffer.alloc(4))).toThrow(/too short|RIFF/i);
  });

  it('rejects non-16-bit or non-PCM data', () => {
    const wav = buildWav({ sampleRate: 44100, channels: 1, samples: Int16Array.of(0, 0) });
    const eightBit = Buffer.from(wav);
    eightBit.writeUInt16LE(8, 34);
    expect(() => parseWav(eightBit)).toThrow(/16-bit/i);
    const floaty = Buffer.from(wav);
    floaty.writeUInt16LE(3, 20);
    expect(() => parseWav(floaty)).toThrow(/PCM/i);
  });

  it('rejects a file without a data chunk', () => {
    const wav = buildWav({ sampleRate: 44100, channels: 1, samples: Int16Array.of(0) });
    const noData = wav.subarray(0, 36);
    expect(() => parseWav(noData)).toThrow(/data chunk/i);
  });

  it('tolerates a data chunk whose declared size exceeds the file (truncated/streamed)', () => {
    const wav = buildWav({ sampleRate: 44100, channels: 1, samples: Int16Array.of(1, 2, 3, 4) });
    wav.writeUInt32LE(0xffffffff, 40);
    expect(parseWav(wav).frameCount).toBe(4);
  });
});
