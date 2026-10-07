import { BITRATES_KBPS } from './frame-format.js';
import type { BitrateMode } from './encoder.js';

export type ParsedArgs =
  | { readonly kind: 'encode'; readonly input: string; readonly output: string; readonly mode: BitrateMode }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

const DEFAULT_KBPS = 128;
const DEFAULT_VBR_QUALITY = 4;
const MAX_QUALITY = 9;

export const USAGE = `Usage: mp3enc <input.wav> [options]

Encodes a 16-bit PCM WAV file (mono/stereo, 32/44.1/48 kHz) to MPEG-1 Layer III.

Options:
  -o, --output <file>     output file (default: input with .mp3)
  -b, --bitrate <kbps|vbr>
                          constant bitrate: ${BITRATES_KBPS.join(', ')} (default ${String(DEFAULT_KBPS)}),
                          or "vbr" for variable bitrate
  -q, --vbr-quality <0-9> VBR quality, 0 = best/largest, 9 = smallest (default ${String(DEFAULT_VBR_QUALITY)})
  -h, --help              show this help
`;

const error = (message: string): ParsedArgs => ({ kind: 'error', message });

function defaultOutput(input: string): string {
  return /\.wav$/i.test(input) ? input.replace(/\.wav$/i, '.mp3') : `${input}.mp3`;
}

/** Splits "--name=value" into its parts; short flags and bare words pass through. */
function tokenize(argv: readonly string[]): string[] {
  return argv.flatMap((a) => {
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    return eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a];
  });
}

interface RawOptions {
  input?: string;
  output?: string;
  bitrate?: string;
  quality?: string;
}

const VALUE_OPTIONS: Readonly<Record<string, keyof RawOptions>> = {
  '--output': 'output', '-o': 'output',
  '--bitrate': 'bitrate', '-b': 'bitrate',
  '--vbr-quality': 'quality', '-q': 'quality',
};

/** Collects the raw option values; returns an error message for malformed command lines. */
function readOptions(tokens: readonly string[]): RawOptions | string {
  const raw: RawOptions = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const target = VALUE_OPTIONS[token];
    if (target !== undefined) {
      const value = tokens[++i];
      if (value === undefined) return `Option ${token} needs a value`;
      raw[target] = value;
    } else if (token.startsWith('-') && token.length > 1) {
      return `Unknown option ${token}`;
    } else if (raw.input === undefined) {
      raw.input = token;
    } else {
      return `Unexpected extra argument ${token}`;
    }
  }
  return raw;
}

function resolveMode(bitrate: string | undefined, quality: string | undefined): BitrateMode | string {
  const q = quality === undefined ? DEFAULT_VBR_QUALITY : Number(quality);
  if (!Number.isInteger(q) || q < 0 || q > MAX_QUALITY || quality === '') {
    return `Invalid VBR quality "${quality ?? ''}": use an integer from 0 to ${String(MAX_QUALITY)}`;
  }
  if (bitrate === 'vbr') return { kind: 'vbr', quality: q };
  const kbps = bitrate === undefined ? DEFAULT_KBPS : Number(bitrate);
  if (!BITRATES_KBPS.includes(kbps)) {
    return `Invalid bitrate "${bitrate ?? ''}": MP3 supports ${BITRATES_KBPS.join(', ')} kbps, or "vbr"`;
  }
  return { kind: 'cbr', kbps };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const tokens = tokenize(argv);
  if (tokens.length === 0 || tokens.includes('-h') || tokens.includes('--help')) return { kind: 'help' };

  const raw = readOptions(tokens);
  if (typeof raw === 'string') return error(raw);
  if (raw.input === undefined) return error('No input file given');
  const mode = resolveMode(raw.bitrate, raw.quality);
  if (typeof mode === 'string') return error(mode);
  return { kind: 'encode', input: raw.input, output: raw.output ?? defaultOutput(raw.input), mode };
}
