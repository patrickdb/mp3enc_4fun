Build a command-line MP3 encoder in TypeScript (Node 22), in the current directory, and push it when done.

PRODUCT
- Input: 16-bit PCM WAV, mono or stereo, 32/44.1/48 kHz. Nothing else (lean and mean).
- Output: MPEG-1 Layer III MP3. CBR at 128, 160, 192, 256 kbps, plus VBR (quality 0-9, default 4).
  Other standard bitrates (32-320) may be accepted. Anything else is rejected with a clear message and exit code 2.
- CLI: `mp3enc in.wav [-b <kbps|vbr>] [-q 0-9] [-o out.mp3]`. Print a summary including the real-time factor.
- No ID3, no extras.

ALGORITHM (own code, from scratch)
- No codec/audio libraries in the encoder. Only Node built-ins (node:fs etc.).
- Research the public ISO/IEC 11172-3 material yourself (Annexes B, C, D; Raissi "The Theory Behind MP3";
  Brandenburg "MP3 and AAC Explained"; the MPEG Layer3 bitstream reference).
- Constant tables (Huffman, scalefactor bands, analysis window) are data, not algorithm. You may extract them from
  public copies of the standard with a one-off generator script kept in tools/, and you must validate them
  (prefix-free, Kraft sum 1, expected counts).

TOOLING PRE-APPROVED (do not ask)
- Dev dependencies: typescript, vitest, @vitest/coverage-v8, eslint, @eslint/js, typescript-eslint, tsx, @types/node.
- Test-only: mpg123-decoder (independent decoder).
- Scratch only, in /tmp: pdfjs-dist, to read the spec PDFs.
- Nothing else without asking.

QUALITY
- Static analysis: ESLint with typescript-eslint strictTypeChecked + stylisticTypeChecked, strict tsc, complexity <= 20. Must be clean.
- Strict test-driven development: for every module write the test first, run it and see it fail, then write the code,
  then run until green. For bug fixes, write the failing regression test first.
- Vitest, with unit tests (tests/unit) separate from black-box acceptance tests (tests/acceptance, run the built CLI).
- Write the acceptance criteria to docs/acceptance-criteria.md BEFORE implementing.
  Cover: each bitrate, VBR with Xing header, strict bitstream validation (written independently from the ISO syntax),
  playback by mpg123 without errors and with the right duration, fidelity (tone frequency/level, stereo separation, SNR rising with bitrate),
  performance, input formats, error handling, robustness (silence, white noise, clipped square, tiny and empty files).
- Add a benchmark/performance check early (within the first working pipeline), not at the end.
- Performance requirement: encoding takes < 0.5x the audio duration, in every mode, including full-scale white noise.

DONE WHEN
- npm run check (typecheck + lint + all tests) passes.
- A real 30 s stereo demo WAV is encoded in all modes, each output validated and decoded with mpg123. Report results in a table.
- No secrets in the repo. Add .gitignore (node_modules, dist, coverage).

DELIVERABLES
- README.md, docs/acceptance-criteria.md, docs/report.md (requirements vs outcome, results, bugs found, simplifications, next steps).
- Commit in logical steps, then git remote add origin <URL> and push to main.
  Repo: https://github.com/<user>/<repo>.git. You are allowed to run git init/remote/push for this.

AUTONOMY
- Do not ask clarifying questions. Decide using the above, and list assumptions in docs/report.md.
- Stop and ask only if blocked on something not covered here.

OPTIONAL
- If a real WAV is available, tune the quality constants on it: <path>/sample.wav
