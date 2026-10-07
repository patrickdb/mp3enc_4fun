/** Builds canonical 16-bit PCM WAV files for tests. */
export interface WavSpec {
  readonly sampleRate: number;
  readonly channels: number;
  /** Interleaved samples as 16-bit integers. */
  readonly samples: Int16Array;
  /** Extra RIFF chunks placed between fmt and data (id must be 4 chars). */
  readonly extraChunks?: readonly { id: string; data: Uint8Array }[];
}

export function buildWav(spec: WavSpec): Buffer {
  const extras = spec.extraChunks ?? [];
  const extraBytes = extras.reduce((n, c) => n + 8 + c.data.length + (c.data.length % 2), 0);
  const dataBytes = spec.samples.length * 2;
  const buf = Buffer.alloc(44 + extraBytes + dataBytes);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(36 + extraBytes + dataBytes, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(spec.channels, o); o += 2;
  buf.writeUInt32LE(spec.sampleRate, o); o += 4;
  buf.writeUInt32LE(spec.sampleRate * spec.channels * 2, o); o += 4;
  buf.writeUInt16LE(spec.channels * 2, o); o += 2;
  buf.writeUInt16LE(16, o); o += 2;
  for (const c of extras) {
    buf.write(c.id, o); o += 4;
    buf.writeUInt32LE(c.data.length, o); o += 4;
    Buffer.from(c.data).copy(buf, o); o += c.data.length + (c.data.length % 2);
  }
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataBytes, o); o += 4;
  for (const s of spec.samples) { buf.writeInt16LE(s, o); o += 2; }
  return buf;
}

/** Interleaved sine tones, one frequency per channel, amplitude 0..1. */
export function sineSamples(
  sampleRate: number,
  seconds: number,
  freqs: readonly number[],
  amplitude = 0.5,
): Int16Array {
  const frames = Math.round(sampleRate * seconds);
  const out = new Int16Array(frames * freqs.length);
  for (let i = 0; i < frames; i++) {
    freqs.forEach((f, ch) => {
      out[i * freqs.length + ch] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * f * i) / sampleRate));
    });
  }
  return out;
}

/** Deterministic music-like test signal: harmonics with vibrato plus low-passed (tilted, not white) noise. */
export function musicLikeSamples(sampleRate: number, seconds: number, channels: number): Int16Array {
  const frames = Math.round(sampleRate * seconds);
  const out = new Int16Array(frames * channels);
  let seed = 12345;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const tilt = new Float64Array(channels);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const base = 220 * (1 + 0.5 * Math.floor(t * 2) / 2);
    for (let ch = 0; ch < channels; ch++) {
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * base * h * t + ch * 0.3) / h;
      tilt[ch] = (tilt[ch] ?? 0) * 0.92 + rnd() * 0.08;
      v = v * 0.25 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) + 0.004 * (tilt[ch] ?? 0);
      out[i * channels + ch] = Math.round(Math.max(-1, Math.min(1, v)) * 30000);
    }
  }
  return out;
}
