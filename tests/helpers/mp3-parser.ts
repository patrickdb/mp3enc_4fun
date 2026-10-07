import { BITRATES_KBPS, frameSizeBytes, sideInfoBytes } from '../../src/frame-format.js';

export interface ParsedFrame {
  readonly offset: number;
  readonly size: number;
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly padding: boolean;
  readonly mainDataBegin: number;
  /** Bytes of this frame's slot (after header and side info). */
  readonly slot: Uint8Array;
}

const RATES = [44100, 48000, 32000];

/** Minimal independent MP3 frame walker used to check the muxer's output structure. */
export function parseFrames(bytes: Uint8Array): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const b0 = bytes[pos] ?? 0;
    const b1 = bytes[pos + 1] ?? 0;
    const b2 = bytes[pos + 2] ?? 0;
    const b3 = bytes[pos + 3] ?? 0;
    if (b0 !== 0xff || (b1 & 0xfe) !== 0xfa) throw new Error(`lost sync at byte ${String(pos)}`);
    const bitrateKbps = BITRATES_KBPS[(b2 >> 4) - 1];
    const sampleRate = RATES[(b2 >> 2) & 3];
    if (bitrateKbps === undefined || sampleRate === undefined) throw new Error(`bad header at ${String(pos)}`);
    const padding = ((b2 >> 1) & 1) === 1;
    const channels = (b3 >> 6) === 3 ? 1 : 2;
    const size = frameSizeBytes(sampleRate, bitrateKbps, padding);
    if (pos + size > bytes.length) break;
    const side = sideInfoBytes(channels);
    const mainDataBegin = ((bytes[pos + 4] ?? 0) << 1) | ((bytes[pos + 5] ?? 0) >> 7);
    frames.push({
      offset: pos, size, bitrateKbps, sampleRate, channels, padding, mainDataBegin,
      slot: bytes.slice(pos + 4 + side, pos + size),
    });
    pos += size;
  }
  return frames;
}

/** Resolves bit-reservoir pointers: returns the main-data bytes available at the start of each frame's data. */
export function mainDataStreams(frames: readonly ParsedFrame[]): Uint8Array[] {
  const stream: number[] = [];
  const out: Uint8Array[] = [];
  for (const f of frames) {
    const start = stream.length - f.mainDataBegin;
    if (start < 0) throw new Error('main_data_begin points before the start of the stream');
    stream.push(...f.slot);
    out.push(Uint8Array.from(stream.slice(start)));
  }
  return out;
}
