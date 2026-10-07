import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWav } from '../../src/wav.js';
import { validateMp3 } from '../helpers/bitstream-validator.js';
import { decodeMp3 } from '../helpers/decode.js';
import { bestSnrDb, dominantFrequency, toneAmplitude } from '../helpers/fidelity.js';
import { parseFrames } from '../helpers/mp3-parser.js';
import { buildWav, musicLikeSamples, sineSamples } from '../helpers/wav-builder.js';
import { runCli, workspace, type Workspace } from './helpers.js';

let ws: Workspace;
beforeAll(() => { ws = workspace(); });
afterAll(() => { ws.cleanup(); });

const RATE = 44100;
const bitrateOf = (mp3: Uint8Array): number[] => parseFrames(mp3).map((f) => f.bitrateKbps);

/** Encodes `samples` through the CLI and returns the produced MP3 bytes. */
function encode(name: string, rate: number, channels: number, samples: Int16Array, ...args: string[]): Uint8Array {
  ws.write(`${name}.wav`, buildWav({ sampleRate: rate, channels, samples }));
  const run = runCli([ws.path(`${name}.wav`), '-o', ws.path(`${name}.mp3`), ...args]);
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return ws.read(`${name}.mp3`);
}

describe('AC-1: command-line encoding', () => {
  it('writes <input>.mp3 next to the input, exits 0 and prints a summary', () => {
    ws.write('basic.wav', buildWav({ sampleRate: RATE, channels: 2, samples: musicLikeSamples(RATE, 1, 2) }));
    const run = runCli([ws.path('basic.wav')]);
    expect(run.status).toBe(0);
    expect(ws.exists('basic.mp3')).toBe(true);
    expect(ws.read('basic.mp3').length).toBeGreaterThan(1000);
    expect(run.stdout).toMatch(/Encoded .*basic\.wav -> .*basic\.mp3/);
    expect(run.stdout).toMatch(/128 kbps CBR/);
  });

  it('uses -o for the output name', () => {
    ws.write('named.wav', buildWav({ sampleRate: RATE, channels: 1, samples: sineSamples(RATE, 0.3, [440]) }));
    expect(runCli([ws.path('named.wav'), '-o', ws.path('custom-name.mp3')]).status).toBe(0);
    expect(ws.exists('custom-name.mp3')).toBe(true);
  });

  it('prints help', () => {
    const run = runCli(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Usage: mp3enc/);
  });
});

describe('AC-2: constant bitrates', () => {
  const seconds = 3;
  const samples = musicLikeSamples(RATE, seconds, 2);
  it.each([128, 160, 192, 256])('encodes at exactly %i kbps', (kbps) => {
    const mp3 = encode(`cbr${String(kbps)}`, RATE, 2, samples, '-b', String(kbps));
    const frames = parseFrames(mp3);
    expect(frames.every((f) => f.bitrateKbps === kbps)).toBe(true);
    expect(frames.every((f) => f.sampleRate === RATE && f.channels === 2)).toBe(true);
    const encodedSeconds = (frames.length * 1152) / RATE;
    const expectedBytes = (kbps * 1000 * encodedSeconds) / 8;
    expect(Math.abs(mp3.length - expectedBytes)).toBeLessThanOrEqual(420); // within one frame
    expect(encodedSeconds).toBeGreaterThanOrEqual(seconds);
    expect(encodedSeconds).toBeLessThan(seconds + 0.1);
  });
});

describe('AC-3: variable bitrate', () => {
  const quiet = new Int16Array(RATE * 2 * 2);
  const busy = musicLikeSamples(RATE, 2, 2);
  const tone = sineSamples(RATE, 2, [330, 330], 0.4);
  const mixed = new Int16Array(quiet.length + busy.length + tone.length);
  mixed.set(quiet, 0);
  mixed.set(busy, quiet.length);
  mixed.set(tone, quiet.length + busy.length);

  it('produces a Xing header with the right frame count and bitrates that follow the content', () => {
    const mp3 = encode('vbr', RATE, 2, mixed, '-b', 'vbr');
    const frames = parseFrames(mp3);
    const view = new DataView(mp3.buffer, mp3.byteOffset, mp3.byteLength);
    const tagAt = 4 + 32;
    expect(String.fromCharCode(...mp3.slice(tagAt, tagAt + 4))).toBe('Xing');
    expect(view.getUint32(tagAt + 8)).toBe(frames.length - 1);
    expect(view.getUint32(tagAt + 12)).toBe(mp3.length);

    const rates = bitrateOf(mp3).slice(1);
    expect(new Set(rates).size).toBeGreaterThanOrEqual(3);
    const seconds = (rates.length * 1152) / RATE;
    const average = (mp3.length * 8) / seconds / 1000;
    expect(average).toBeGreaterThan(32);
    expect(average).toBeLessThan(320);
    const perSecond = Math.floor(RATE / 1152);
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(rates.slice(4, perSecond * 2 - 4))).toBeLessThan(mean(rates.slice(perSecond * 2 + 4, perSecond * 4 - 4)));
  });

  it('spends more bits at quality 0 than at quality 9', () => {
    const best = encode('vbr-q0', RATE, 2, busy, '-b', 'vbr', '-q', '0');
    const worst = encode('vbr-q9', RATE, 2, busy, '-b', 'vbr', '-q', '9');
    expect(best.length).toBeGreaterThan(worst.length * 1.3);
  });
});

describe('AC-4: bitstream conformance (strict validator)', () => {
  const cases: [string, number, number, string[]][] = [
    ['cbr128 stereo 44.1k', 44100, 2, ['-b', '128']],
    ['cbr160 stereo 44.1k', 44100, 2, ['-b', '160']],
    ['cbr192 stereo 48k', 48000, 2, ['-b', '192']],
    ['cbr256 stereo 32k', 32000, 2, ['-b', '256']],
    ['cbr320 mono 44.1k', 44100, 1, ['-b', '320']],
    ['cbr64 mono 32k', 32000, 1, ['-b', '64']],
    ['vbr stereo 44.1k', 44100, 2, ['-b', 'vbr']],
    ['vbr mono 48k', 48000, 1, ['-b', 'vbr', '-q', '1']],
  ];
  it.each(cases)('%s has no violations', (name, rate, channels, args) => {
    const mp3 = encode(`conf-${name.replace(/\W+/g, '-')}`, rate, channels, musicLikeSamples(rate, 1.5, channels), ...args);
    const report = validateMp3(mp3);
    expect(report.problems).toEqual([]);
    expect(report.frames).toBeGreaterThan(20);
  });
});

describe('AC-5 and AC-8: playable in an independent decoder, for every supported input format', () => {
  const rates = [32000, 44100, 48000];
  const layouts = [1, 2];
  for (const rate of rates) {
    for (const channels of layouts) {
      it(`${String(channels)} channel(s) at ${String(rate)} Hz decode cleanly with the right duration`, async () => {
        const seconds = 1.2;
        const mp3 = encode(`play-${String(rate)}-${String(channels)}`, rate, channels, musicLikeSamples(rate, seconds, channels), '-b', '128');
        const decoded = await decodeMp3(mp3);
        expect(decoded.errorCount).toBe(0);
        expect(decoded.sampleRate).toBe(rate);
        expect(parseFrames(mp3).every((f) => f.channels === channels)).toBe(true);
        // mpg123-decoder up-mixes mono to two identical channels
        const [first, second] = decoded.channelData;
        if (channels === 1 && first && second) expect(second.every((v, i) => v === first[i])).toBe(true);
        expect(decoded.samplesPerChannel).toBeGreaterThanOrEqual(seconds * rate);
        expect(decoded.samplesPerChannel).toBeLessThanOrEqual(seconds * rate + 2 * 1152 + 1105);
      });
    }
  }

  it('decodes a VBR file (Xing header) cleanly', async () => {
    const decoded = await decodeMp3(encode('play-vbr', RATE, 2, musicLikeSamples(RATE, 1.5, 2), '-b', 'vbr'));
    expect(decoded.errorCount).toBe(0);
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.samplesPerChannel).toBeGreaterThan(1.4 * RATE);
  });
});

describe('AC-6: fidelity of the decoded audio', () => {
  it('keeps tone frequency and level, and keeps stereo channels apart', async () => {
    const samples = sineSamples(RATE, 1.5, [440, 1760], 0.5);
    const decoded = await decodeMp3(encode('tones', RATE, 2, samples, '-b', '128'));
    const [left, right] = decoded.channelData;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (!left || !right) return;
    const from = 8000;
    const length = 22050;
    expect(Math.abs(dominantFrequency(left, RATE, from, length) - 440)).toBeLessThanOrEqual(20);
    expect(Math.abs(dominantFrequency(right, RATE, from, length) - 1760)).toBeLessThanOrEqual(20);
    // level within 0.5 dB of the 0.5 amplitude input
    for (const [x, f] of [[left, 440], [right, 1760]] as const) {
      const db = 20 * Math.log10(toneAmplitude(x, RATE, f, from, length) / 0.5);
      expect(Math.abs(db)).toBeLessThan(0.5);
    }
    // crosstalk: the other channel's tone is at least 40 dB down
    expect(toneAmplitude(left, RATE, 1760, from, length)).toBeLessThan(0.5 / 100);
    expect(toneAmplitude(right, RATE, 440, from, length)).toBeLessThan(0.5 / 100);
  });

  it('reproduces music-like audio with a high signal-to-noise ratio that improves with bitrate', async () => {
    const samples = musicLikeSamples(RATE, 2, 2);
    const original = parseWav(buildWav({ sampleRate: RATE, channels: 2, samples }));
    const snr: Record<number, number> = {};
    for (const kbps of [128, 160, 192, 256]) {
      const decoded = await decodeMp3(encode(`snr${String(kbps)}`, RATE, 2, samples, '-b', String(kbps)));
      const left = decoded.channelData[0];
      const ref = original.data[0];
      if (!left || !ref) throw new Error('missing channel');
      snr[kbps] = bestSnrDb(ref, left).snrDb;
      expect(snr[kbps]).toBeGreaterThan(30);
    }
    expect(snr[256]).toBeGreaterThan(snr[128] ?? Infinity);
  });
});

describe('AC-7: performance (encode in under half of the audio duration)', () => {
  const seconds = 20;
  const samples = musicLikeSamples(RATE, seconds, 2);
  it.each(['128', '160', '192', '256', 'vbr'])('bitrate %s', (bitrate) => {
    const wavName = `perf-${bitrate}.wav`;
    ws.write(wavName, buildWav({ sampleRate: RATE, channels: 2, samples }));
    const run = runCli([ws.path(wavName), '-b', bitrate]);
    expect(run.status).toBe(0);
    expect(run.stderr).not.toMatch(/slower than/);
    expect(run.wallSeconds).toBeLessThan(seconds * 0.5);
    const reported = /: ([\d.]+)x real time/.exec(run.stdout);
    expect(Number(reported?.[1])).toBeLessThan(0.5);
  }, 60_000);
});

describe('AC-9: error handling', () => {
  it.each(['169', '296', '0', '321', 'abc'])('rejects bitrate %s and names the valid ones', (bad) => {
    ws.write('err.wav', buildWav({ sampleRate: RATE, channels: 1, samples: sineSamples(RATE, 0.2, [440]) }));
    const run = runCli([ws.path('err.wav'), '-o', ws.path('err.mp3'), '-b', bad]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/128, 160, 192/);
    expect(run.stderr).toMatch(/256/);
    expect(ws.exists('err.mp3')).toBe(false);
  });

  it('reports a missing input file', () => {
    const run = runCli([ws.path('does-not-exist.wav')]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/does-not-exist\.wav/);
  });

  it('refuses a file that is not a WAV', () => {
    const input = ws.write('notwav.wav', Buffer.from('this is plain text pretending to be audio'));
    const run = runCli([input, '-o', ws.path('notwav.mp3')]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/RIFF|WAVE/);
    expect(ws.exists('notwav.mp3')).toBe(false);
  });

  it('refuses unsupported WAV content (8-bit, 22.05 kHz, 6 channels) with an explanation', () => {
    const good = buildWav({ sampleRate: RATE, channels: 1, samples: Int16Array.of(1, 2, 3, 4) });
    const eightBit = Buffer.from(good); eightBit.writeUInt16LE(8, 34);
    expect(runCli([ws.write('eight.wav', eightBit), '-o', ws.path('eight.mp3')]).stderr).toMatch(/16-bit/);
    const slow = buildWav({ sampleRate: 22050, channels: 1, samples: Int16Array.of(1, 2, 3, 4) });
    expect(runCli([ws.write('slow.wav', slow), '-o', ws.path('slow.mp3')]).stderr).toMatch(/sample rate/i);
    const surround = buildWav({ sampleRate: RATE, channels: 6, samples: new Int16Array(12) });
    expect(runCli([ws.write('six.wav', surround), '-o', ws.path('six.mp3')]).stderr).toMatch(/channel/i);
    for (const n of ['eight', 'slow', 'six']) expect(ws.exists(`${n}.mp3`)).toBe(false);
  });

  it('shows usage hints for unknown options', () => {
    const run = runCli(['x.wav', '--turbo']);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/Unknown option --turbo/);
  });
});

describe('AC-10: robustness', () => {
  it('encodes digital silence to a valid stream that decodes to silence', async () => {
    const mp3 = encode('silence', RATE, 2, new Int16Array(RATE * 2), '-b', '128');
    expect(validateMp3(mp3).problems).toEqual([]);
    const decoded = await decodeMp3(mp3);
    expect(decoded.errorCount).toBe(0);
    expect(Math.max(...(decoded.channelData[0] ?? []).map(Math.abs))).toBeLessThan(1e-4);
  });

  it('encodes full-scale white noise at 128 and 320 kbps', async () => {
    let seed = 1;
    const noise = Int16Array.from({ length: RATE * 2 * 2 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.round((seed / 2 ** 32 - 0.5) * 65534);
    });
    for (const kbps of ['128', '320']) {
      const mp3 = encode(`noise${kbps}`, RATE, 2, noise, '-b', kbps);
      expect(validateMp3(mp3).problems).toEqual([]);
      const decoded = await decodeMp3(mp3);
      expect(decoded.errorCount).toBe(0);
      expect((decoded.channelData[0] ?? []).every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('encodes a clipped full-scale square wave without producing non-finite audio', async () => {
    const square = Int16Array.from({ length: RATE * 2 }, (_, i) => (Math.floor(i / 50) % 2 === 0 ? 32767 : -32768));
    const mp3 = encode('square', RATE, 1, square, '-b', '192');
    expect(validateMp3(mp3).problems).toEqual([]);
    const decoded = await decodeMp3(mp3);
    expect(decoded.errorCount).toBe(0);
    expect((decoded.channelData[0] ?? []).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('encodes a very short file (a few samples) and an empty data chunk', async () => {
    for (const [name, samples] of [['tiny', Int16Array.of(100, -100, 50)], ['empty', new Int16Array(0)]] as const) {
      const mp3 = encode(name, RATE, 1, samples);
      expect(validateMp3(mp3).problems).toEqual([]);
      expect((await decodeMp3(mp3)).errorCount).toBe(0);
    }
  });
});
