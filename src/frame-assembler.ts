import { BitWriter } from './bitwriter.js';
import { encodeHeader, frameSizeBytes, sideInfoBytes, writeSideInfo, type GranuleChannelInfo } from './frame-format.js';

/** main_data_begin is a 9-bit field, so the reservoir never holds more than this many bytes. */
const MAX_RESERVOIR_BYTES = 511;

export interface FrameInput {
  readonly bitrateKbps: number;
  readonly padding: boolean;
  /** granules[gr][ch] side-info parameters. */
  readonly granules: readonly (readonly GranuleChannelInfo[])[];
  /** Scale factors and Huffman codes of both granules and all channels, in bitstream order. */
  readonly mainData: BitWriter;
}

interface PendingFrame {
  readonly head: Uint8Array;
  readonly slotStart: number;
  readonly slotLength: number;
}

/**
 * Muxes frames. Main data of all frames forms one continuous byte stream that is cut into the
 * frames' slots; a frame's data may therefore begin in the unused tail of earlier slots
 * (the bit reservoir), which main_data_begin points back to.
 */
export class FrameAssembler {
  private readonly frames: PendingFrame[] = [];
  private stream = new Uint8Array(4096);
  private streamLength = 0;
  private slotTotal = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {}

  /** Bytes of earlier slots not yet filled with data: what the next frame may borrow. */
  get reservoirBytes(): number {
    return this.slotTotal - this.streamLength;
  }

  slotBytes(bitrateKbps: number, padding: boolean): number {
    return frameSizeBytes(this.sampleRate, bitrateKbps, padding) - 4 - sideInfoBytes(this.channels);
  }

  frameSizes(): number[] {
    return this.frames.map((f) => f.head.length + f.slotLength);
  }

  addFrame(frame: FrameInput): void {
    const slot = this.slotBytes(frame.bitrateKbps, frame.padding);
    const reservoir = this.reservoirBytes;
    const data = frame.mainData.toBytes();
    if (data.length > reservoir + slot) {
      throw new RangeError(`Main data of ${String(data.length)} bytes does not fit the capacity of ${String(reservoir + slot)} bytes`);
    }
    const leftover = reservoir + slot - data.length;
    const stuffing = Math.max(0, leftover - MAX_RESERVOIR_BYTES);

    const side = new BitWriter();
    writeSideInfo(side, this.channels, reservoir, frame.granules);
    const header = encodeHeader({
      sampleRate: this.sampleRate, bitrateKbps: frame.bitrateKbps, padding: frame.padding, channels: this.channels,
    });
    const head = new Uint8Array(4 + sideInfoBytes(this.channels));
    head.set(header);
    head.set(side.toBytes(), 4);

    this.frames.push({ head, slotStart: this.slotTotal, slotLength: slot });
    this.slotTotal += slot;
    this.append(data, stuffing);
  }

  finish(): Uint8Array {
    const total = this.frames.reduce((n, f) => n + f.head.length + f.slotLength, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const f of this.frames) {
      out.set(f.head, pos);
      pos += f.head.length;
      const end = Math.min(f.slotStart + f.slotLength, this.streamLength);
      if (end > f.slotStart) out.set(this.stream.subarray(f.slotStart, end), pos);
      pos += f.slotLength;
    }
    return out;
  }

  private append(data: Uint8Array, stuffing: number): void {
    const needed = this.streamLength + data.length + stuffing;
    if (needed > this.stream.length) {
      const grown = new Uint8Array(Math.max(needed, this.stream.length * 2));
      grown.set(this.stream.subarray(0, this.streamLength));
      this.stream = grown;
    }
    this.stream.set(data, this.streamLength);
    this.streamLength = needed;
  }
}
