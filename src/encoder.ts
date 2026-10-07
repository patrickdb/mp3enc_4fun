import { BitWriter } from './bitwriter.js';
import { FrameAssembler } from './frame-assembler.js';
import { BITRATES_KBPS, FramePadder, bitrateIndex, type GranuleChannelInfo } from './frame-format.js';
import { encodeGranule, type GranuleResult } from './granule-encoder.js';
import { HybridAnalyzer } from './hybrid.js';
import { PolyphaseAnalyzer } from './polyphase.js';
import { computeThresholds, perceptualEntropy } from './psycho.js';
import { writeScalefactors } from './scalefactors.js';
import { writeSpectrum } from './huffman.js';
import { SFB_LONG } from './tables/sfb-data.js';
import type { WavData } from './wav.js';
import { buildTableOfContents, buildXingFrame } from './xing.js';

export type BitrateMode =
  | { readonly kind: 'cbr'; readonly kbps: number }
  /** quality 0 (best, biggest) to 9 (smallest), like LAME's -V. */
  | { readonly kind: 'vbr'; readonly quality: number };

const GRANULE_SIZE = 576;
const GRANULES_PER_FRAME = 2;
const FRAME_SIZE = GRANULE_SIZE * GRANULES_PER_FRAME;
const BLOCK = 32;
const BLOCKS_PER_GRANULE = GRANULE_SIZE / BLOCK;
/** Samples between an input sample and its decoded output: polyphase (481) + MDCT overlap + decoder (~529). */
const CODEC_DELAY = 1105;
const MAX_PART23 = 4095;
const RESERVOIR_USE = 0.5;
const MAX_VBR_QUALITY = 9;
const VBR_BITRATES = BITRATES_KBPS;

interface FrameAnalysis {
  readonly xr: Float64Array[][];
  readonly thresholds: Float64Array[][];
  readonly weights: number[];
}

/** Extra precision (dB below the masking threshold) a CBR setting can afford per channel. */
function cbrMarginDb(kbps: number, channels: number): number {
  return Math.max(0, (kbps / channels - 48) / 8);
}

/** Calibrated so average bitrates on typical music land near the familiar -V ladder (V0 ~245 ... V9 ~85 kbps). */
const VBR_MARGIN_STEP_DB = 1.5;
const VBR_MARGIN_OFFSET_DB = 5;

function vbrMarginDb(quality: number): number {
  return (MAX_VBR_QUALITY - quality) * VBR_MARGIN_STEP_DB - VBR_MARGIN_OFFSET_DB;
}

const dbToScale = (marginDb: number): number => 10 ** (-marginDb / 10);

function frameData(results: readonly (readonly GranuleResult[])[]): { main: BitWriter; granules: GranuleChannelInfo[][] } {
  const main = new BitWriter();
  const granules = results.map((granule) =>
    granule.map((r) => {
      writeScalefactors(main, r.scalefacs, r.scalefacCompress);
      writeSpectrum(main, r.ix, r.coding);
      return {
        part23Length: r.part23Bits,
        bigValues: r.coding.bigValues,
        globalGain: r.globalGain,
        scalefacCompress: r.scalefacCompress,
        tableSelect: r.coding.tableSelect,
        region0Count: r.coding.region0Count,
        region1Count: r.coding.region1Count,
        preflag: false,
        scalefacScale: false,
        count1TableSelect: r.coding.count1TableSelect,
      };
    }));
  return { main, granules };
}

/** Encodes decoded WAV audio to an MPEG-1 Layer III stream. */
export function encodeMp3(wav: WavData, mode: BitrateMode): Uint8Array {
  if (mode.kind === 'cbr') bitrateIndex(mode.kbps);
  else if (!Number.isInteger(mode.quality) || mode.quality < 0 || mode.quality > MAX_VBR_QUALITY) {
    throw new RangeError(`VBR quality must be an integer from 0 to ${String(MAX_VBR_QUALITY)}`);
  }
  const { sampleRate, channels } = wav;
  const sfb = SFB_LONG[sampleRate];
  if (!sfb) throw new Error(`Unsupported sample rate ${String(sampleRate)}`);

  const polyphase = Array.from({ length: channels }, () => new PolyphaseAnalyzer());
  const hybrid = Array.from({ length: channels }, () => new HybridAnalyzer());
  const assembler = new FrameAssembler(sampleRate, channels);
  const padder = new FramePadder(sampleRate);
  const frameCount = Math.max(1, Math.ceil((wav.frameCount + CODEC_DELAY) / FRAME_SIZE));
  const lastGain = new Array<number>(channels).fill(0);
  const subband = new Float64Array(GRANULE_SIZE);
  const block = new Float64Array(BLOCK);

  const analyse = (frame: number): FrameAnalysis => {
    const xr: Float64Array[][] = [];
    const thresholds: Float64Array[][] = [];
    const weights: number[] = [];
    for (let gr = 0; gr < GRANULES_PER_FRAME; gr++) {
      const xrGranule: Float64Array[] = [];
      const thrGranule: Float64Array[] = [];
      for (let ch = 0; ch < channels; ch++) {
        const pcm = wav.data[ch];
        const start = frame * FRAME_SIZE + gr * GRANULE_SIZE;
        for (let t = 0; t < BLOCKS_PER_GRANULE; t++) {
          const chunk = new Float64Array(BLOCK);
          for (let i = 0; i < BLOCK; i++) chunk[i] = pcm?.[start + t * BLOCK + i] ?? 0;
          polyphase[ch]?.process(chunk, block);
          for (let k = 0; k < BLOCK; k++) subband[k * BLOCKS_PER_GRANULE + t] = block[k] ?? 0;
        }
        const spectrum = new Float64Array(GRANULE_SIZE);
        hybrid[ch]?.process(subband, spectrum);
        const thr = new Float64Array(sfb.length - 1);
        computeThresholds(spectrum, sfb, sampleRate, thr);
        weights.push(perceptualEntropy(spectrum, sfb, thr) + 24);
        xrGranule.push(spectrum);
        thrGranule.push(thr);
      }
      xr.push(xrGranule);
      thresholds.push(thrGranule);
    }
    return { xr, thresholds, weights };
  };

  /** Encodes all granules of a frame, dividing `totalBits` among them by perceptual weight. */
  const encodeFrame = (a: FrameAnalysis, totalBits: number, noiseScale: number): GranuleResult[][] => {
    const weightSum = a.weights.reduce((x, y) => x + y, 0);
    return a.xr.map((granule, gr) =>
      granule.map((spectrum, ch) => {
        const w = a.weights[gr * channels + ch] ?? 1;
        const maxBits = Math.min(MAX_PART23, Math.floor((totalBits * w) / weightSum));
        const result = encodeGranule(spectrum, a.thresholds[gr]?.[ch] ?? new Float64Array(0), sfb, {
          maxBits, tighten: true, noiseScale, gainHint: lastGain[ch] ?? 0,
        });
        lastGain[ch] = result.globalGain;
        return result;
      }));
  };
  const sumBits = (r: readonly (readonly GranuleResult[])[]): number =>
    r.reduce((n, g) => n + g.reduce((m, x) => m + x.part23Bits, 0), 0);

  const vbr = mode.kind === 'vbr';
  const xingRate = BITRATES_KBPS[BITRATES_KBPS.length - 1] ?? 320;
  for (let frame = 0; frame < frameCount; frame++) {
    const analysis = analyse(frame);
    let kbps: number;
    let results: GranuleResult[][];
    if (mode.kind === 'cbr') {
      kbps = mode.kbps;
      const slot = assembler.slotBytes(kbps, false);
      const budgetBytes = slot + Math.floor((assembler.reservoirBytes * RESERVOIR_USE));
      results = encodeFrame(analysis, budgetBytes * 8, dbToScale(cbrMarginDb(kbps, channels)));
    } else {
      const scale = dbToScale(vbrMarginDb(mode.quality));
      results = encodeFrame(analysis, MAX_PART23 * GRANULES_PER_FRAME * channels, scale);
      const neededBytes = Math.ceil(sumBits(results) / 8);
      const reservoir = assembler.reservoirBytes;
      kbps = VBR_BITRATES.find((r) => assembler.slotBytes(r, false) + reservoir >= neededBytes) ?? xingRate;
      if (assembler.slotBytes(kbps, false) + reservoir < neededBytes) {
        results = encodeFrame(analysis, (assembler.slotBytes(kbps, false) + reservoir) * 8, scale);
      }
    }
    const padding = padder.nextPadding(kbps);
    const { main, granules } = frameData(results);
    assembler.addFrame({ bitrateKbps: kbps, padding, granules, mainData: main });
  }

  const audio = assembler.finish();
  if (!vbr) return audio;
  const xing = buildXingFrame({
    sampleRate, channels, frames: frameCount,
    bytes: audio.length + frameSizeOf(sampleRate), toc: buildTableOfContents(assembler.frameSizes()),
  });
  const out = new Uint8Array(xing.length + audio.length);
  out.set(xing);
  out.set(audio, xing.length);
  return out;
}

function frameSizeOf(sampleRate: number): number {
  return Math.floor((144000 * (BITRATES_KBPS[8] ?? 128)) / sampleRate);
}
