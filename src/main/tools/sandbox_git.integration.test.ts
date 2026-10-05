import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLaunch, detectSandboxSupport, systemLaunchEnv } from './sandbox';
import { ShellRunner } from './shell';

const support = detectSandboxSupport();
const execute = promisify(execFile);
const image = 'node:lts';
const container = Boolean(
  support.container &&
  spawnSync(support.container, ['image', 'inspect', image], { stdio: 'ignore', timeout: 8000 }).status === 0,
);
const hostGit =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim()
    : 'git';

for (const [kind, available] of [
  ['appcontainer', process.platform === 'win32' && Boolean(support.appcontainer)],
  ['bwrap', process.platform === 'linux' && support.bwrap],
  ['seatbelt', process.platform === 'darwin' && support.seatbelt],
  ['container', container],
] as const) {
  describe.skipIf(!available)(`Git metadata isolation (${kind})`, () => {
    let fixture: string;
    let root: string;
    let shell: ShellRunner;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
    beforeEach(() => {
      fixture = realpathSync(mkdtempSync(join(tmpdir(), 'patch-git-isolation-')));
      root = join(fixture, 'project');
      mkdirSync(root);
      git('-c', 'init.templateDir=', 'init', '--quiet');
      mkdirSync(join(root, '.git', 'info'), { recursive: true });
      writeFileSync(join(root, 'source.txt'), 'original');
      git('add', 'source.txt');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      );
      if (kind !== 'container')
        copyFileSync(process.execPath, join(root, process.platform === 'win32' ? 'node.exe' : 'node'));
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'));
      env.PATH = root;
      shell = new ShellRunner(
        () => root,
        () => ({ mode: 'auto', network: 'off', image, allowedHosts: '' }),
        () => support,
        () => env,
      );
    });
    afterEach(() => {
      shell?.stopAll();
      rmSync(fixture, { recursive: true, force: true });
    });

    const run = async (script: string) => {
      writeFileSync(join(root, 'probe.cjs'), script);
      if (kind === 'appcontainer') {
        const result = await shell.run('.\\node.exe probe.cjs');
        expect(result.exitCode, result.output).toBe(0);
        return JSON.parse(result.output.trim());
      }
      const command = `${kind === 'container' ? 'node' : './node'} probe.cjs`;
      const env = systemLaunchEnv({
        cwd: root,
        home: fixture,
        tmp: fixture,
        inner: { file: '/bin/sh', args: ['-c', command] },
        command,
        containerName: `patch-git-${randomUUID()}`,
        image,
      });
      const launch = buildLaunch({ kind, network: false }, env, support.container);
      try {
        const result = await execute(launch.file, launch.args, {
          cwd: root,
          timeout: 15_000,
          env: kind === 'container' ? process.env : { PATH: process.env.PATH, HOME: fixture },
        });
        return JSON.parse(result.stdout.trim());
      } finally {
        if (launch.stop) await execute(launch.stop.file, launch.stop.args, { timeout: 10_000 }).catch(() => {});
      }
    };

    it('keeps project edits working while denying overwrite, absent names, unlink and metadata replacement', async () => {
      const original = readFileSync(join(root, '.git', 'config'), 'utf8');
      const result = await run(`
const fs = require('node:fs');
const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
fs.mkdirSync('new-directory');
fs.writeFileSync('new-directory/new-file', 'new');
fs.appendFileSync('source.txt', '-edited');
const result = { source: fs.readFileSync('source.txt', 'utf8'), created: fs.readFileSync('new-directory/new-file', 'utf8'), config: fs.readFileSync('.git/config', 'utf8') };
result.overwrite = attempt(() => fs.appendFileSync('.git/config', '\\n[alias]\\npatchproof = !echo PWNED > marker.txt\\n'));
result.absent = attempt(() => fs.writeFileSync('.git/config.worktree', 'bad'));
result.redirect = attempt(() => fs.writeFileSync('.git/commondir', '../new-directory'));
result.attributes = attempt(() => fs.writeFileSync('.git/info/attributes', '* filter=bad'));
result.unlink = attempt(() => fs.unlinkSync('.git/config'));
fs.writeFileSync('replacement', 'bad');
result.replace = attempt(() => fs.renameSync('replacement', '.git/config'));
result.renameDirectory = attempt(() => fs.renameSync('.git', 'old-git'));
result.alias = attempt(() => { fs.linkSync('.git/config', 'config-alias'); fs.appendFileSync('config-alias', 'bad'); });
if (process.platform === 'darwin') {
  const parent = require('node:path').dirname(process.cwd());
  result.renameAncestor = attempt(() => { fs.renameSync(parent, parent + '-moved'); fs.renameSync(parent + '-moved', parent); });
}
console.log(JSON.stringify(result));
`);
      expect(result.source).toBe('original-edited');
      expect(result.created).toBe('new');
      expect(result.config).toBe(original);
      for (const operation of [
        'overwrite',
        'absent',
        'redirect',
        'attributes',
        'unlink',
        'replace',
        'renameDirectory',
        'alias',
      ])
        expect(result[operation], operation).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
      if (kind === 'seatbelt') expect(result.renameAncestor).toMatch(/^(EACCES|EPERM)$/);
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(original);
      expect(existsSync(join(root, '.git', 'config.worktree'))).toBe(false);
      expect(existsSync(join(root, '.git', 'commondir'))).toBe(false);
      expect(() => git('patchproof')).toThrow();
      expect(existsSync(join(root, 'marker.txt'))).toBe(false);
      // Host Git remains writable (the Git panel and explicitly approved unsandboxed commands use this boundary).
      git('config', 'patch.hostControl', 'allowed');
      expect(git('config', '--get', 'patch.hostControl').trim()).toBe('allowed');
      git('add', 'source.txt');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'host commit',
      );
      expect(git('show', 'HEAD:source.txt').trim()).toBe('original-edited');
    });

    it('supports sandboxed status and diff but requires host approval for add and commit', async () => {
      const result = await run(`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeFileSync('source.txt', 'changed\\n');
const run = (args) => {
  const fd = fs.openSync('git-output', 'w');
  const result = spawnSync(${JSON.stringify(kind === 'container' ? 'git' : hostGit)}, ['-c', 'safe.directory=*', ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['inherit', fd, fd] });
  fs.closeSync(fd);
  return { code: result.status, error: result.error?.message, output: fs.readFileSync('git-output', 'utf8') };
};
console.log(JSON.stringify({ status: run(['status', '--porcelain']), diff: run(['diff', '--no-ext-diff', '--no-textconv']), add: run(['add', 'source.txt']), commit: run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'denied']) }));
`);
      expect(result.status.code, JSON.stringify(result.status)).toBe(0);
      expect(result.diff.code, JSON.stringify(result.diff)).toBe(0);
      expect(result.diff.output).toContain('+changed');
      for (const operation of ['add', 'commit']) {
        expect(result[operation].error).toBeUndefined();
        expect(result[operation].code).not.toBe(0);
        expect(result[operation].output).toMatch(/permission denied|read-only/i);
      }
      expect(git('log', '--format=%s').trim()).toBe('fixture');
      expect(git('diff', '--cached')).toBe('');
    });
  });
}
