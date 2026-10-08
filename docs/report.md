# End report: mp3enc

A command-line MP3 encoder written from scratch in TypeScript. It turns 16-bit PCM WAV files (mono or stereo, 32 / 44.1 / 48 kHz)
into MPEG-1 Layer III files at constant bitrates or VBR. No codec libraries are used. The only built-in used is `node:fs`.

## Requirements and outcome

| Requirement | Outcome |
|-------------|---------|
| CLI encoder, TypeScript | `node dist/cli.js in.wav -b 192 -o out.mp3` |
| Bitrates 128, 160, 192, 256 and VBR | Done. 169 and 296 from the brief are not MP3 bitrates and were clarified as 160 and 192. All standard bitrates 32-320 are accepted; anything else is refused with the list of valid ones |
| No libraries with prebaked algorithms | The whole pipeline is own code, written from the public ISO/IEC 11172-3 material |
| Research the algorithm | Sources: ISO/IEC 11172-3 Annexes B, C, D; Raissi, *The Theory Behind MP3*; Brandenburg, *MP3 and AAC Explained*; the MPEG Layer3 bitstream reference |
| Industry-standard static analysis | ESLint with typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`, plus strict `tsc`. Both are clean |
| Test-driven | Each module's tests were written first and seen to fail before the code was written |
| Acceptance criteria | AC-1 to AC-10 in `docs/acceptance-criteria.md`, run against the built CLI |
| Playable in any MP3 player | Verified with the mpg123 decoder and a strict bitstream validator (see below) |
| Encode in under half of the audio duration | 0.18-0.22x real time in every mode; worst case (full-scale white noise) about 0.3x |

## Results

121 unit tests and 44 acceptance tests pass. Unit-test coverage is 100% of lines and functions.

Test song: 30 s stereo, 44.1 kHz, 5.29 MB WAV (files in `demo/`).

| Mode | Size | Ratio | Strict validator | mpg123 decode errors | SNR L / R |
|------|------|-------|------------------|----------------------|-----------|
| 128 kbps | 469 KB | 11.0x | 0 issues | 0 | 20.8 / 20.3 dB |
| 160 kbps | 587 KB | 8.8x | 0 issues | 0 | 24.9 / 24.0 dB |
| 192 kbps | 704 KB | 7.3x | 0 issues | 0 | 28.0 / 25.3 dB |
| 256 kbps | 939 KB | 5.5x | 0 issues | 0 | 32.1 / 29.9 dB |
| VBR (q4) | 667 KB | 7.7x | 0 issues | 0 | 26.6 / 27.5 dB |

Decoded duration was 30.04 s in every mode. VBR averaged 182 kbps and used all 14 bitrates, from 32 to 320 kbps.
SNR rises with bitrate, which is expected: a perceptual codec shapes noise under the masking curve instead of minimising it.

## How playability was checked

- **mpg123** (`mpg123-decoder`, WebAssembly, test-only dependency) decodes every output without errors, with the right sample
  rate, channels and duration. Tone frequency and level, stereo separation and SNR match the input.
- A **strict bitstream validator** (`tests/helpers/bitstream-validator.ts`, written from the ISO syntax, independent of the encoder)
  checks sync words, headers, side info, bit-reservoir pointers, and that each granule's `part2_3_length` is consumed exactly.
  Decoders are lenient about these things, so this is stricter than "it decodes".
- Only one independent decoder was used. A second one (`minimp3-wasm`) was not installed, since it was not approved.

## Problems found by testing

- **Quantizer saturation:** with a generous bit budget the gain dropped to 0 and quantized values clamped at 8206, so a tone decoded
  at 4.6% of its amplitude. Fixed with a minimum-gain bound; mpg123 now reproduces amplitude to within about 0.3%.
- **Speed:** the first working version ran at 3.7x real time. Profiling found Huffman analysis was 72% of the time. A cheaper table search,
  a safe bit estimator and one exact analysis per granule brought it to 0.18-0.33x.
- **Validator bug:** table 0 (no bits) was mis-read. Fixed with a regression test that was shown to fail without the fix.

## Known simplifications

- Long blocks only (no block switching), so sharp transients can show some pre-echo.
- Plain left/right stereo; no mid/side or intensity stereo.
- No low-pass filter, scale-factor reuse, pre-emphasis, ID3 tag or LAME gapless tag (about 25 ms of lead-in silence).
- Compact psychoacoustic model working on the MDCT spectrum, not the FFT-based model of Annex D.
- The VBR quality scale and masking constants were tuned on synthetic audio, so they are worth checking by ear on real music.

## Possible next steps

Block switching for transients, joint stereo for better quality at low bitrates, a gapless tag, and tuning on real recordings.

## Reproduce

```bash
npm install
npm run check    # typecheck + lint + unit and acceptance tests (about 2 minutes)
```
