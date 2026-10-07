import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../../dist/cli.js');

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallSeconds: number;
}

export interface Workspace {
  readonly dir: string;
  path(name: string): string;
  write(name: string, data: Uint8Array): string;
  read(name: string): Uint8Array;
  exists(name: string): boolean;
  cleanup(): void;
}

export function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'mp3enc-acceptance-'));
  return {
    dir,
    path: (name): string => join(dir, name),
    write: (name, data): string => { const p = join(dir, name); writeFileSync(p, data); return p; },
    read: (name): Uint8Array => readFileSync(join(dir, name)),
    exists: (name): boolean => existsSync(join(dir, name)),
    cleanup: (): void => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Runs the real, built command-line tool as a subprocess. */
export function runCli(args: readonly string[], cwd?: string): CliRun {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    wallSeconds: (performance.now() - started) / 1000,
  };
}
