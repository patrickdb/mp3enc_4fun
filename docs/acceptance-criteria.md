# Acceptance criteria

Derived from the product description: a command-line tool that encodes WAV audio into MP3 (MPEG-1 Layer III)
at 128, 160, 192 and 256 kbps and VBR, written from scratch, playable in any MP3 player, and encoding in less
than half of the audio's duration. (169 and 296 kbps from the original brief are not MP3 bitrates; they were
clarified as 160 and 192. All standard bitrates 32-320 are accepted.)

Each criterion is verified black-box by `tests/acceptance` against the built CLI (`dist/cli.js`).

| ID | Criterion |
|----|-----------|
| AC-1 | `mp3enc in.wav` writes `in.mp3`, exits 0 and prints a summary; `-o` chooses the output name. |
| AC-2 | CBR at 128, 160, 192 and 256 kbps: every frame carries the requested bitrate; file size equals bitrate x duration (within one frame). |
| AC-3 | `-b vbr`: valid stream with a Xing header (correct frame count), bitrates that vary with content, average strictly inside 32-320 kbps; quality 0 is larger than quality 9. |
| AC-4 | Conformance: an independent strict validator finds no violation (sync, headers, side info, reservoir pointers, exact part2_3_length accounting) for every mode, channel layout and sample rate. |
| AC-5 | Playability: the mpg123 decoder decodes the file without errors at the right sample rate, channel count and duration. |
| AC-6 | Fidelity: tones keep their frequency and level, channels stay separate, SNR is high and rises with the bitrate. |
| AC-7 | Performance: encoding a 20 s stereo file takes under 0.5x its duration in every mode (wall clock of the CLI process, and the CLI's own report). |
| AC-8 | Inputs: 16-bit PCM mono and stereo at 32, 44.1 and 48 kHz are all accepted. |
| AC-9 | Errors: bitrates 169/296 (or any invalid one), missing files, non-WAV files and unsupported WAV formats give a clear message, a non-zero exit code and no output file. |
| AC-10 | Robustness: silence, full-scale noise and clipped square waves encode to valid, decodable streams. |
