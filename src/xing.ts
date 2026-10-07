import { encodeHeader, frameSizeBytes, sideInfoBytes } from './frame-format.js';

const TOC_ENTRIES = 100;
const XING_FRAME_KBPS = 128;
const FLAG_FRAMES = 1;
const FLAG_BYTES = 2;
const FLAG_TOC = 4;

/** Seek table: byte position (out of 256) of each percent of the stream. */
export function buildTableOfContents(frameSizes: readonly number[]): number[] {
  const total = frameSizes.reduce((a, b) => a + b, 0);
  const offsets: number[] = [];
  let sum = 0;
  for (const size of frameSizes) {
    offsets.push(sum);
    sum += size;
  }
  return Array.from({ length: TOC_ENTRIES }, (_, i) => {
    const frame = Math.floor((i * frameSizes.length) / TOC_ENTRIES);
    return total === 0 ? 0 : Math.min(255, Math.floor(((offsets[frame] ?? 0) / total) * 256));
  });
}

export interface XingParams {
  readonly sampleRate: number;
  readonly channels: number;
  /** Number of audio frames (the Xing frame itself is not counted). */
  readonly frames: number;
  /** Total size of the file in bytes. */
  readonly bytes: number;
  readonly toc: readonly number[];
}

/** A silent frame that carries the VBR header so players can show duration and seek. */
export function buildXingFrame(p: XingParams): Uint8Array {
  const frame = new Uint8Array(frameSizeBytes(p.sampleRate, XING_FRAME_KBPS, false));
  frame.set(encodeHeader({ sampleRate: p.sampleRate, bitrateKbps: XING_FRAME_KBPS, padding: false, channels: p.channels }));
  const view = new DataView(frame.buffer);
  let at = 4 + sideInfoBytes(p.channels);
  frame.set([0x58, 0x69, 0x6e, 0x67], at); // "Xing"
  view.setUint32(at + 4, FLAG_FRAMES | FLAG_BYTES | FLAG_TOC);
  view.setUint32(at + 8, p.frames);
  view.setUint32(at + 12, p.bytes);
  at += 16;
  p.toc.forEach((v, i) => { frame[at + i] = v; });
  return frame;
}
