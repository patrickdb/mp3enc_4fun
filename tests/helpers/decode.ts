import { MPEGDecoder } from 'mpg123-decoder';

export interface DecodedAudio {
  readonly sampleRate: number;
  readonly channelData: readonly Float32Array[];
  readonly samplesPerChannel: number;
  readonly errorCount: number;
}

/** Decodes an MP3 with mpg123 (compiled to WebAssembly), an independent, widely deployed decoder. */
export async function decodeMp3(bytes: Uint8Array): Promise<DecodedAudio> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const result = decoder.decode(bytes);
    return {
      sampleRate: result.sampleRate,
      channelData: result.channelData,
      samplesPerChannel: result.samplesDecoded,
      errorCount: result.errors.length,
    };
  } finally {
    decoder.free();
  }
}
