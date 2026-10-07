import type { BitWriter } from './bitwriter.js';

/** MPEG-1 Layer III bitrates in kbps (ISO/IEC 11172-3 Table 3-B.2); index 0 (free format) and 15 are unused. */
export const BITRATES_KBPS: readonly number[] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATE_CODES: Readonly<Record<number, number>> = { 44100: 0, 48000: 1, 32000: 2 };
export const SAMPLES_PER_FRAME = 1152;
const MAX_MAIN_DATA_BEGIN = 511;

export function bitrateIndex(kbps: number): number {
  const i = BITRATES_KBPS.indexOf(kbps);
  if (i < 0) throw new Error(`Invalid MP3 bitrate ${String(kbps)} kbps; valid: ${BITRATES_KBPS.join(', ')}`);
  return i + 1;
}

export interface HeaderParams {
  readonly sampleRate: number;
  readonly bitrateKbps: number;
  readonly padding: boolean;
  readonly channels: number;
}

/** Encodes the 4-byte frame header: MPEG-1, Layer III, no CRC, plain stereo or mono. */
export function encodeHeader(p: HeaderParams): Uint8Array {
  const rate = SAMPLE_RATE_CODES[p.sampleRate];
  if (rate === undefined) throw new Error(`Unsupported sample rate ${String(p.sampleRate)}`);
  const mode = p.channels === 1 ? 0b11 : 0b00;
  return Uint8Array.of(
    0xff,
    0xfb, // sync(3) + MPEG-1 + Layer III + protection bit 1 (no CRC)
    (bitrateIndex(p.bitrateKbps) << 4) | (rate << 2) | (p.padding ? 0b10 : 0),
    mode << 6,
  );
}

export function frameSizeBytes(sampleRate: number, bitrateKbps: number, padding: boolean): number {
  return Math.floor((144000 * bitrateKbps) / sampleRate) + (padding ? 1 : 0);
}

export function sideInfoBytes(channels: number): number {
  return channels === 1 ? 17 : 32;
}

/** Decides when to add a padding byte so that the average bitrate is exact. */
export class FramePadder {
  private remainder = 0;
  constructor(private readonly sampleRate: number) {}

  nextPadding(bitrateKbps: number): boolean {
    this.remainder += (144000 * bitrateKbps) % this.sampleRate;
    if (this.remainder >= this.sampleRate) {
      this.remainder -= this.sampleRate;
      return true;
    }
    return false;
  }
}

export interface GranuleChannelInfo {
  readonly part23Length: number;
  readonly bigValues: number;
  readonly globalGain: number;
  readonly scalefacCompress: number;
  readonly tableSelect: readonly [number, number, number];
  readonly region0Count: number;
  readonly region1Count: number;
  readonly preflag: boolean;
  readonly scalefacScale: boolean;
  readonly count1TableSelect: number;
}

/**
 * Writes the side information. `granules[gr][ch]` holds the per-granule, per-channel
 * parameters; scale-factor sharing (scfsi) is never used, and block switching is off.
 */
export function writeSideInfo(
  w: BitWriter,
  channels: number,
  mainDataBegin: number,
  granules: readonly (readonly GranuleChannelInfo[])[],
): void {
  if (mainDataBegin < 0 || mainDataBegin > MAX_MAIN_DATA_BEGIN) {
    throw new RangeError(`main_data_begin out of range: ${String(mainDataBegin)}`);
  }
  w.writeBits(mainDataBegin, 9);
  w.writeBits(0, channels === 1 ? 5 : 3);
  w.writeBits(0, 4 * channels); // scfsi
  for (const granule of granules) {
    for (const g of granule) {
      w.writeBits(g.part23Length, 12);
      w.writeBits(g.bigValues, 9);
      w.writeBits(g.globalGain, 8);
      w.writeBits(g.scalefacCompress, 4);
      w.writeBits(0, 1); // window_switching_flag
      for (const t of g.tableSelect) w.writeBits(t, 5);
      w.writeBits(g.region0Count, 4);
      w.writeBits(g.region1Count, 3);
      w.writeBits(g.preflag ? 1 : 0, 1);
      w.writeBits(g.scalefacScale ? 1 : 0, 1);
      w.writeBits(g.count1TableSelect, 1);
    }
  }
}
