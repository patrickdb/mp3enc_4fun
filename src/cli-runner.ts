import { USAGE, parseArgs } from './args.js';
import { encodeMp3, type BitrateMode } from './encoder.js';
import { parseWav } from './wav.js';

/** Real-time factor the encoder must stay under: encoding may take at most half the audio's duration. */
export const MAX_REALTIME_FACTOR = 0.5;
/** Shorter audio is not judged: process start-up and JIT warm-up would dominate the measurement. */
const MIN_SECONDS_TO_JUDGE = 1;

export interface CliIo {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  log(message: string): void;
  error(message: string): void;
  /** Monotonic clock in milliseconds. */
  now(): number;
}

function describeMode(mode: BitrateMode): string {
  return mode.kind === 'cbr' ? `${String(mode.kbps)} kbps CBR` : `VBR quality ${String(mode.quality)}`;
}

/** Runs the command-line tool and returns its exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const args = parseArgs(argv);
  if (args.kind === 'help') {
    io.log(USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    io.error(`mp3enc: ${args.message}\nTry "mp3enc --help" for usage.`);
    return 2;
  }
  try {
    const wav = parseWav(io.readFile(args.input));
    const started = io.now();
    const mp3 = encodeMp3(wav, args.mode);
    const elapsedMs = io.now() - started;
    io.writeFile(args.output, mp3);

    const seconds = wav.frameCount / wav.sampleRate;
    const factor = seconds > 0 ? elapsedMs / 1000 / seconds : 0;
    io.log(
      `Encoded ${args.input} -> ${args.output} (${describeMode(args.mode)}, ${String(mp3.length)} bytes)\n` +
      `Audio ${seconds.toFixed(2)} s, encoded in ${(elapsedMs / 1000).toFixed(2)} s: ${factor.toFixed(2)}x real time`,
    );
    if (seconds >= MIN_SECONDS_TO_JUDGE && factor > MAX_REALTIME_FACTOR) {
      io.error(`Warning: encoding was slower than ${String(MAX_REALTIME_FACTOR)}x real time (target is at most half the audio duration)`);
    }
    return 0;
  } catch (e) {
    io.error(`mp3enc: ${args.input}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
