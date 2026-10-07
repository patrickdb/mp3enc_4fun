export interface WavData {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameCount: number;
  /** One array per channel, samples normalised to [-1, 1). */
  readonly data: readonly Float64Array[];
}

const SUPPORTED_RATES: readonly number[] = [32000, 44100, 48000];
const FORMAT_PCM = 1;
const FORMAT_EXTENSIBLE = 0xfffe;

function tag(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(...buf.subarray(offset, offset + 4));
}

/** Parses a 16-bit PCM RIFF/WAVE file with one or two channels. */
export function parseWav(input: Uint8Array): WavData {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < 12) throw new Error('File too short to be a WAV file (no RIFF header)');
  if (tag(input, 0) !== 'RIFF' || tag(input, 8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');

  let channels = 0;
  let sampleRate = 0;
  let dataStart = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= input.length) {
    const id = tag(input, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > input.length) throw new Error('Truncated fmt chunk');
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
      if (format !== FORMAT_PCM) throw new Error(`Unsupported WAV format ${String(format)}: only PCM is supported`);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (bits !== 16) throw new Error(`Unsupported sample size: only 16-bit PCM is supported, got ${String(bits)}-bit`);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, input.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (channels === 0) throw new Error('Missing fmt chunk');
  if (dataStart < 0) throw new Error('Missing data chunk');
  if (channels > 2) throw new Error(`Unsupported channel count ${String(channels)}: only mono and stereo are supported`);
  if (!SUPPORTED_RATES.includes(sampleRate)) {
    throw new Error(`Unsupported sample rate ${String(sampleRate)} Hz: use 32000, 44100 or 48000`);
  }

  const frameCount = Math.floor(dataLength / (2 * channels));
  const data = Array.from({ length: channels }, () => new Float64Array(frameCount));
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const channel = data[ch];
      if (channel) channel[i] = view.getInt16(dataStart + (i * channels + ch) * 2, true) / 32768;
    }
  }
  return { sampleRate, channels, frameCount, data };
}
