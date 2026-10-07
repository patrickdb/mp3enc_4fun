import { describe, expect, it } from 'vitest';
import { encodeMp3 } from '../../src/encoder.js';
import { parseWav } from '../../src/wav.js';
import { validateMp3 } from '../helpers/bitstream-validator.js';
import { buildWav, musicLikeSamples } from '../helpers/wav-builder.js';

const wav = parseWav(buildWav({ sampleRate: 44100, channels: 2, samples: musicLikeSamples(44100, 0.6, 2) }));
const good = encodeMp3(wav, { kind: 'cbr', kbps: 128 });

describe('validateMp3 (test helper sanity)', () => {
  it('accepts an encoder-produced CBR stream', () => {
    const report = validateMp3(good);
    expect(report.problems).toEqual([]);
    expect(report.frames).toBeGreaterThan(10);
  });

  it('accepts an encoder-produced VBR stream including its Xing frame', () => {
    expect(validateMp3(encodeMp3(wav, { kind: 'vbr', quality: 3 })).problems).toEqual([]);
  });

  it('flags trailing garbage', () => {
    const bad = new Uint8Array(good.length + 7);
    bad.set(good);
    expect(validateMp3(bad).problems.join('\n')).toMatch(/trailing|sync/);
  });

  /** Byte offset of frame number n, found by walking the headers. */
  const frameOffset = (bytes: Uint8Array, n: number): number => {
    let pos = 0;
    for (let i = 0; i < n; i++) pos += ((bytes[pos + 2] ?? 0) & 2) !== 0 ? 418 : 417; // 128 kbps @ 44.1 kHz
    return pos;
  };

  it('flags a corrupted part2_3_length (bit accounting no longer matches)', () => {
    const bad = Uint8Array.from(good);
    const at = frameOffset(bad, 5) + 4 + 2; // inside granule 0 / channel 0 part2_3_length
    bad[at] = (bad[at] ?? 0) ^ 0x3c;
    expect(validateMp3(bad).problems.length).toBeGreaterThan(0);
  });

  it('flags corrupted table selections as undecodable or misaccounted', () => {
    let flagged = 0;
    for (let frame = 3; frame < 9; frame++) {
      const bad = Uint8Array.from(good);
      const at = frameOffset(bad, frame) + 4 + 11;
      bad[at] = (bad[at] ?? 0) ^ 0xff;
      if (validateMp3(bad).problems.length > 0) flagged++;
    }
    expect(flagged).toBeGreaterThanOrEqual(4);
  });

  it('handles granules whose regions use the bit-free table 0 (regression)', () => {
    let seed = 1;
    const noise = Int16Array.from({ length: 44100 * 2 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.round((seed / 2 ** 32 - 0.5) * 65534);
    });
    const stream = encodeMp3(parseWav(buildWav({ sampleRate: 44100, channels: 2, samples: noise })), { kind: 'cbr', kbps: 128 });
    expect(validateMp3(stream).problems).toEqual([]);
  });
});
