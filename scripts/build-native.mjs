import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const suffix = process.platform === 'win32' ? '.exe' : '';
const localCargo = join(homedir(), '.cargo', 'bin', `cargo${suffix}`);
const cargo = existsSync(localCargo) ? localCargo : `cargo${suffix}`;
const manifest = 'native/sandbox-helper/Cargo.toml';
function run(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(cargo, ['build', '--release', '--locked', '--manifest-path', manifest]);
if (process.platform === 'darwin') {
  // electron-builder produces a universal macOS app; its external file helper must also run on both architectures.
  const rustup = join(homedir(), '.cargo', 'bin', 'rustup');
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  run(existsSync(rustup) ? rustup : 'rustup', ['target', 'add', ...targets]);
  for (const target of targets)
    run(cargo, [
      'build',
      '--release',
      '--locked',
      '--bin',
      'file-helper',
      '--target',
      target,
      '--manifest-path',
      manifest,
    ]);
  run('lipo', [
    '-create',
    ...targets.map((target) => `native/sandbox-helper/target/${target}/release/file-helper`),
    '-output',
    'native/sandbox-helper/target/release/file-helper',
  ]);
}
