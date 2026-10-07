import { describe, expect, it } from 'vitest';
import { frameSizeBytes } from '../../src/frame-format.js';
import { buildTableOfContents, buildXingFrame } from '../../src/xing.js';
import { parseFrames } from '../helpers/mp3-parser.js';

describe('buildTableOfContents', () => {
  it('maps each percent of playback time to a byte position out of 256', () => {
    const toc = buildTableOfContents(Array.from({ length: 200 }, () => 400));
    expect(toc).toHaveLength(100);
    expect(toc[0]).toBe(0);
    expect(toc[50]).toBe(128);
    expect(toc[99]).toBeLessThanOrEqual(255);
    for (let i = 1; i < 100; i++) expect(toc[i]).toBeGreaterThanOrEqual(toc[i - 1] ?? 0);
  });

  it('follows uneven frame sizes', () => {
    const sizes = [...Array.from({ length: 50 }, () => 100), ...Array.from({ length: 50 }, () => 300)];
    const toc = buildTableOfContents(sizes);
    // the first half of the time holds 5000 of 20000 bytes = 25 %
    expect(toc[50]).toBe(64);
  });

  it('copes with very few frames', () => {
    expect(buildTableOfContents([400])).toHaveLength(100);
    expect(buildTableOfContents([])).toHaveLength(100);
  });
});

describe('buildXingFrame', () => {
  const toc = Array.from({ length: 100 }, (_, i) => Math.floor((i * 256) / 100));

  it('is a valid, silent 128 kbps frame carrying the Xing tag, counts and TOC', () => {
    const frame = buildXingFrame({ sampleRate: 44100, channels: 2, frames: 1234, bytes: 987654, toc });
    expect(frame).toHaveLength(frameSizeBytes(44100, 128, false));
    const [parsed] = parseFrames(frame);
    expect(parsed?.bitrateKbps).toBe(128);
    expect(parsed?.mainDataBegin).toBe(0);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const at = 4 + 32;
    expect(String.fromCharCode(...frame.slice(at, at + 4))).toBe('Xing');
    expect(view.getUint32(at + 4)).toBe(0b111);
    expect(view.getUint32(at + 8)).toBe(1234);
    expect(view.getUint32(at + 12)).toBe(987654);
    expect([...frame.slice(at + 16, at + 116)]).toEqual(toc);
    expect(frame.slice(4, at).every((b) => b === 0)).toBe(true);
  });

  it('places the tag after 17 side-info bytes for mono', () => {
    const frame = buildXingFrame({ sampleRate: 48000, channels: 1, frames: 1, bytes: 2, toc });
    expect(String.fromCharCode(...frame.slice(21, 25))).toBe('Xing');
  });
});
