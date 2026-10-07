#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { runCli } from './cli-runner.js';

process.exitCode = runCli(process.argv.slice(2), {
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => { writeFileSync(path, data); },
  log: (message) => { console.log(message); },
  error: (message) => { console.error(message); },
  now: () => performance.now(),
});
