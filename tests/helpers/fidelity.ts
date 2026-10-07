/** Signal-to-noise ratio (dB) of `decoded` against `original` at the best alignment within `maxDelay` samples. */
export function bestSnrDb(
  original: ArrayLike<number>,
  decoded: ArrayLike<number>,
  options: { maxDelay?: number; from?: number; length?: number } = {},
): { snrDb: number; delay: number } {
  const maxDelay = options.maxDelay ?? 2400;
  const from = options.from ?? 4000;
  const length = Math.min(options.length ?? 16384, original.length - from);
  let best = { snrDb: -Infinity, delay: 0 };
  for (let delay = 0; delay <= maxDelay; delay++) {
    let signal = 0;
    let noise = 0;
    for (let i = from; i < from + length; i++) {
      const a = original[i] ?? 0;
      const d = (decoded[i + delay] ?? 0) - a;
      signal += a * a;
      noise += d * d;
    }
    const snrDb = noise === 0 ? Infinity : 10 * Math.log10(signal / noise);
    if (snrDb > best.snrDb) best = { snrDb, delay };
  }
  return best;
}

/** Magnitude of the DFT of x at frequency f (Hz), normalised to the amplitude of a sine at that frequency. */
export function toneAmplitude(x: ArrayLike<number>, sampleRate: number, f: number, from: number, length: number): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < from + length; i++) {
    const phase = (2 * Math.PI * f * i) / sampleRate;
    re += (x[i] ?? 0) * Math.cos(phase);
    im += (x[i] ?? 0) * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / length;
}

/** Frequency (Hz, searched on a 10 Hz grid) with the strongest component. */
export function dominantFrequency(x: ArrayLike<number>, sampleRate: number, from: number, length: number): number {
  let best = { f: 0, a: -1 };
  for (let f = 100; f < sampleRate / 2 - 100; f += 10) {
    const a = toneAmplitude(x, sampleRate, f, from, length);
    if (a > best.a) best = { f, a };
  }
  return best.f;
}
