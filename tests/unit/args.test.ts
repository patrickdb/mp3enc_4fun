import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/args.js';

describe('parseArgs', () => {
  it('defaults to 128 kbps CBR and derives the output name from the input', () => {
    expect(parseArgs(['song.wav'])).toEqual({
      kind: 'encode', input: 'song.wav', output: 'song.mp3', mode: { kind: 'cbr', kbps: 128 },
    });
  });

  it('replaces only a trailing .wav extension, case-insensitively', () => {
    expect(parseArgs(['dir/My.Song.WAV'])).toMatchObject({ output: 'dir/My.Song.mp3' });
    expect(parseArgs(['noext'])).toMatchObject({ output: 'noext.mp3' });
  });

  it('accepts every supported CBR bitrate via -b / --bitrate', () => {
    for (const kbps of [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]) {
      expect(parseArgs(['a.wav', '-b', String(kbps)])).toMatchObject({ mode: { kind: 'cbr', kbps } });
      expect(parseArgs(['a.wav', `--bitrate=${String(kbps)}`])).toMatchObject({ mode: { kind: 'cbr', kbps } });
    }
  });

  it('accepts vbr, with an optional quality 0-9 (default 4)', () => {
    expect(parseArgs(['a.wav', '-b', 'vbr'])).toMatchObject({ mode: { kind: 'vbr', quality: 4 } });
    expect(parseArgs(['a.wav', '--bitrate', 'vbr', '-q', '2'])).toMatchObject({ mode: { kind: 'vbr', quality: 2 } });
    expect(parseArgs(['a.wav', '--vbr-quality=9', '-b', 'vbr'])).toMatchObject({ mode: { kind: 'vbr', quality: 9 } });
  });

  it('takes an explicit output with -o / --output', () => {
    expect(parseArgs(['a.wav', '-o', 'out/b.mp3'])).toMatchObject({ output: 'out/b.mp3' });
    expect(parseArgs(['--output=x.mp3', 'a.wav'])).toMatchObject({ output: 'x.mp3' });
  });

  it('reports help for -h / --help, and when called with nothing', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs(['-h']).kind).toBe('help');
    expect(parseArgs([]).kind).toBe('help');
  });

  it('explains which bitrates are valid when given one that is not (169, 296, ...)', () => {
    for (const bad of ['169', '296', '0', 'abc', '321']) {
      const r = parseArgs(['a.wav', '-b', bad]);
      expect(r.kind).toBe('error');
      if (r.kind === 'error') expect(r.message).toMatch(/128/);
    }
  });

  it('rejects bad quality, unknown options, missing values and extra inputs', () => {
    expect(parseArgs(['a.wav', '-b', 'vbr', '-q', '10']).kind).toBe('error');
    expect(parseArgs(['a.wav', '-q', 'x']).kind).toBe('error');
    expect(parseArgs(['a.wav', '--nope']).kind).toBe('error');
    expect(parseArgs(['a.wav', '-b']).kind).toBe('error');
    expect(parseArgs(['a.wav', 'b.wav']).kind).toBe('error');
    expect(parseArgs(['-b', '128']).kind).toBe('error');
  });
});
