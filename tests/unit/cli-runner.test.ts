import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli-runner.js';
import { buildWav, sineSamples } from '../helpers/wav-builder.js';

function fakeIo(files: Record<string, Uint8Array>, clock: () => number = () => 0): CliIo & { out: string[]; err: string[]; written: Record<string, Uint8Array> } {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, Uint8Array> = {};
  return {
    out, err, written,
    readFile: (p): Uint8Array => {
      const f = files[p];
      if (!f) throw new Error(`ENOENT: no such file ${p}`);
      return f;
    },
    writeFile: (p, d): void => { written[p] = d; },
    log: (m): void => { out.push(m); },
    error: (m): void => { err.push(m); },
    now: clock,
  };
}

const wav = buildWav({ sampleRate: 44100, channels: 1, samples: sineSamples(44100, 0.5, [440]) });

describe('runCli', () => {
  it('encodes the input file and writes an MP3 next to it', () => {
    const io = fakeIo({ 'in.wav': wav });
    expect(runCli(['in.wav'], io)).toBe(0);
    const mp3 = io.written['in.mp3'];
    expect(mp3?.[0]).toBe(0xff);
    expect((mp3?.[1] ?? 0) & 0xe0).toBe(0xe0);
  });

  it('honours -o and -b', () => {
    const io = fakeIo({ 'in.wav': wav });
    expect(runCli(['in.wav', '-o', 'x.mp3', '-b', '64'], io)).toBe(0);
    expect(io.written['x.mp3']?.[2]).toBe(0x50); // bitrate index 5 (64 kbps), 44.1 kHz, no padding
  });

  it('reports duration, encode time and the real-time factor', () => {
    let t = 0;
    const io = fakeIo({ 'in.wav': wav }, () => { const v = t; t += 100; return v; });
    runCli(['in.wav'], io);
    const line = io.out.join('\n');
    expect(line).toMatch(/0\.50 s/);
    expect(line).toMatch(/real.?time/i);
    expect(line).toMatch(/0\.2\d?x|0\.20x/);
    expect(io.err).toHaveLength(0);
  });

  it('warns when encoding is slower than half the audio duration', () => {
    let t = 0;
    const longer = buildWav({ sampleRate: 44100, channels: 1, samples: sineSamples(44100, 1.2, [440]) });
    const io = fakeIo({ 'in.wav': longer }, () => { const v = t; t += 800; return v; }); // 0.8 s for 1.2 s of audio
    expect(runCli(['in.wav'], io)).toBe(0);
    expect(io.err.join('\n')).toMatch(/slower than/i);
  });

  it('does not judge the real-time factor of audio shorter than one second (start-up noise dominates)', () => {
    let t = 0;
    const tiny = buildWav({ sampleRate: 44100, channels: 1, samples: Int16Array.of(1, 2, 3) });
    const io = fakeIo({ 'tiny.wav': tiny }, () => { const v = t; t += 50; return v; });
    expect(runCli(['tiny.wav'], io)).toBe(0);
    expect(io.err).toHaveLength(0);
  });

  it('prints usage and exits 0 for --help', () => {
    const io = fakeIo({});
    expect(runCli(['--help'], io)).toBe(0);
    expect(io.out.join('\n')).toMatch(/Usage: mp3enc/);
  });

  it('exits 2 with the reason for invalid arguments such as bitrate 169', () => {
    const io = fakeIo({ 'in.wav': wav });
    expect(runCli(['in.wav', '-b', '169'], io)).toBe(2);
    expect(io.err.join('\n')).toMatch(/169/);
    expect(Object.keys(io.written)).toHaveLength(0);
  });

  it('exits 1 with a clear message for a missing file or a non-WAV file', () => {
    const missing = fakeIo({});
    expect(runCli(['nope.wav'], missing)).toBe(1);
    expect(missing.err.join('\n')).toMatch(/nope\.wav/);
    const bad = fakeIo({ 'bad.wav': Uint8Array.from(Buffer.from('this is not a wav file, just some text')) });
    expect(runCli(['bad.wav'], bad)).toBe(1);
    expect(bad.err.join('\n')).toMatch(/RIFF|WAVE/);
    expect(Object.keys(bad.written)).toHaveLength(0);
  });
});
