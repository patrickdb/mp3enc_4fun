import { describe, expect, it } from 'vitest';
import { encodeMp3 } from '../../src/encoder.js';
import { frameSizeBytes } from '../../src/frame-format.js';
import { parseWav } from '../../src/wav.js';
import { mainDataStreams, parseFrames } from '../helpers/mp3-parser.js';
import { buildWav, musicLikeSamples, sineSamples } from '../helpers/wav-builder.js';

const wavOf = (rate: number, channels: number, samples: Int16Array): ReturnType<typeof parseWav> =>
  parseWav(buildWav({ sampleRate: rate, channels, samples }));

describe('encodeMp3 (CBR)', () => {
  it('produces the expected number of equally sized frames for mono 128 kbps', () => {
    const wav = wavOf(44100, 1, sineSamples(44100, 0.5, [440]));
    const out = encodeMp3(wav, { kind: 'cbr', kbps: 128 });
    const frames = parseFrames(out);
    expect(frames.length).toBe(Math.ceil((wav.frameCount + 1105) / 1152));
    expect(frames.every((f) => f.bitrateKbps === 128 && f.sampleRate === 44100 && f.channels === 1)).toBe(true);
    const sizes = new Set(frames.map((f) => f.size));
    expect([...sizes].every((s) => s === 417 || s === 418)).toBe(true);
    expect(out.length).toBe(frames.reduce((n, f) => n + f.size, 0));
  });

  it('keeps the average bitrate exact through padding, at all supported bitrates and rates', () => {
    for (const [rate, kbps] of [[44100, 160], [48000, 192], [32000, 256]] as const) {
      const wav = wavOf(rate, 2, sineSamples(rate, 0.6, [300, 500]));
      const out = encodeMp3(wav, { kind: 'cbr', kbps });
      const frames = parseFrames(out);
      const seconds = (frames.length * 1152) / rate;
      expect((out.length * 8) / seconds / 1000).toBeCloseTo(kbps, 0);
      expect(frames.every((f) => f.bitrateKbps === kbps && f.channels === 2)).toBe(true);
      expect(frames[0]?.size).toBeGreaterThanOrEqual(frameSizeBytes(rate, kbps, false));
    }
  });

  it('writes bit-reservoir pointers that always resolve inside the stream', () => {
    const wav = wavOf(44100, 2, musicLikeSamples(44100, 1.2, 2));
    const frames = parseFrames(encodeMp3(wav, { kind: 'cbr', kbps: 128 }));
    expect(() => mainDataStreams(frames)).not.toThrow();
    expect(frames.every((f) => f.mainDataBegin <= 511)).toBe(true);
  });

  it('rejects bitrates that MPEG-1 Layer III does not define', () => {
    const wav = wavOf(44100, 1, sineSamples(44100, 0.1, [440]));
    expect(() => encodeMp3(wav, { kind: 'cbr', kbps: 169 })).toThrow(/bitrate/i);
    expect(() => encodeMp3(wav, { kind: 'cbr', kbps: 296 })).toThrow(/bitrate/i);
  });

  it('encodes an empty file as valid (single flush frame) output', () => {
    const wav = wavOf(44100, 1, new Int16Array(0));
    const frames = parseFrames(encodeMp3(wav, { kind: 'cbr', kbps: 128 }));
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });
});

describe('encodeMp3 (VBR)', () => {
  it('starts with a Xing header frame that counts the audio frames', () => {
    const wav = wavOf(44100, 2, musicLikeSamples(44100, 1, 2));
    const out = encodeMp3(wav, { kind: 'vbr', quality: 4 });
    const frames = parseFrames(out);
    const first = frames[0];
    expect(first).toBeDefined();
    const tagAt = 4 + 32;
    const tag = String.fromCharCode(...out.slice(tagAt, tagAt + 4));
    expect(tag).toBe('Xing');
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const flags = view.getUint32(tagAt + 4);
    expect(flags & 0b111).toBe(0b111);
    expect(view.getUint32(tagAt + 8)).toBe(frames.length - 1);
    expect(view.getUint32(tagAt + 12)).toBe(out.length);
  });

  it('uses low bitrates for silence and higher ones for dense content', () => {
    const quiet = new Int16Array(44100 * 2);
    const loud = musicLikeSamples(44100, 1, 2);
    const samples = new Int16Array(quiet.length + loud.length);
    samples.set(quiet, 0);
    samples.set(loud, quiet.length);
    const frames = parseFrames(encodeMp3(wavOf(44100, 2, samples), { kind: 'vbr', quality: 2 })).slice(1);
    const rates = frames.map((f) => f.bitrateKbps);
    expect(Math.min(...rates)).toBeLessThan(Math.max(...rates));
    expect(rates.slice(2, 8).every((r) => r <= 64)).toBe(true);
    expect(new Set(rates).size).toBeGreaterThan(2);
  });

  it('spends more bits at a better quality setting', () => {
    const wav = wavOf(44100, 2, musicLikeSamples(44100, 1, 2));
    const best = encodeMp3(wav, { kind: 'vbr', quality: 0 }).length;
    const worst = encodeMp3(wav, { kind: 'vbr', quality: 9 }).length;
    expect(best).toBeGreaterThan(worst);
  });

  it('rejects out-of-range quality', () => {
    const wav = wavOf(44100, 1, sineSamples(44100, 0.1, [440]));
    expect(() => encodeMp3(wav, { kind: 'vbr', quality: 10 })).toThrow(/quality/i);
    expect(() => encodeMp3(wav, { kind: 'vbr', quality: -1 })).toThrow(/quality/i);
  });
});
