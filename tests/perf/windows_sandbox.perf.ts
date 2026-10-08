// Measures what the Windows AppContainer sandbox adds to one command in a large project (#103): a sandboxed `echo`
// against the same command unsandboxed, in a fixture project with PATCH_PERF_FILES files (default 100,000, spread
// over folders like a node_modules tree). Needs Windows and the built helper (`npm run build:sandbox`); skipped
// otherwise. Not part of `npm test`; run `npm run perf`. Numbers vary by machine, so this prints them rather than
// asserting limits. Results are recorded in docs/PERFORMANCE.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { scrubEnv } from '../../src/main/tools/env';
import { findHelper } from '../../src/main/tools/sandbox_windows';
import { ShellRunner } from '../../src/main/tools/shell';

const helper = process.platform === 'win32' ? findHelper() : null;
const FILES = Number(process.env.PATCH_PERF_FILES ?? 100_000);
const PER_FOLDER = 100;
const RUNS = 5;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe.skipIf(!helper)('Windows sandbox command overhead in a large project (#103)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(homedir(), 'patch-perf-sbx-'));
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    for (let folder = 0; folder * PER_FOLDER < FILES; folder++) {
      const directory = join(root, 'node_modules', `package-${Math.floor(folder / 50)}`, `lib-${folder % 50}`);
      mkdirSync(directory, { recursive: true });
      for (let file = 0; file < PER_FOLDER && folder * PER_FOLDER + file < FILES; file++)
        writeFileSync(join(directory, `file-${file}.js`), 'module.exports = 1;\n');
    }
  }, 600_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(`times echo with and without the sandbox (${FILES.toLocaleString()} files)`, async () => {
    // System folders only: a Program Files toolchain on PATH would add its own preparation to the sandboxed runs.
    const system = process.env.SystemRoot!;
    const env = () => ({
      ...scrubEnv(process.env),
      PATH: `${system}\\System32\\WindowsPowerShell\\v1.0;${system}\\System32`,
    });
    const config = (mode: 'off' | 'auto') => () => ({
      mode,
      network: 'off' as const,
      image: '',
      allowedHosts: '',
    });
    const results: Record<string, number[]> = { unsandboxed: [], sandboxed: [] };
    for (const [label, mode] of [
      ['unsandboxed', 'off'],
      ['sandboxed', 'auto'],
    ] as const) {
      const shell = new ShellRunner(() => root, config(mode), undefined, env);
      for (let run = 0; run < RUNS; run++) {
        const started = performance.now();
        const result = await shell.run('Write-Output hi', { timeoutSeconds: 600 });
        if (result.exitCode !== 0) throw new Error(`${label} echo failed: ${result.output}`);
        results[label]!.push(performance.now() - started);
      }
    }
    const row = (label: string) =>
      `${label.padEnd(12)} median ${Math.round(median(results[label]!))} ms  (runs: ${results[label]!.map(Math.round).join(', ')} ms)`;
    console.info(
      [
        `Windows sandbox, ${FILES.toLocaleString()} files:`,
        row('unsandboxed'),
        row('sandboxed'),
        `overhead     median ${Math.round(median(results.sandboxed!) - median(results.unsandboxed!))} ms`,
      ].join('\n'),
    );
  }, 1_800_000);
});
