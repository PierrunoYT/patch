import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLaunch, detectSandboxSupport, systemLaunchEnv } from './sandbox';
import { GIT_RESERVATION } from './sandbox_git';
import { GitService } from '../panels/git';
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
      const nullProbe = join(process.cwd(), 'native/sandbox-helper/target/release/examples/null_probe.exe');
      if (kind === 'appcontainer' && existsSync(nullProbe)) {
        copyFileSync(nullProbe, join(root, 'null-probe.exe'));
        writeFileSync(join(root, 'host-null-probe.json'), execFileSync(nullProbe));
      }
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

    it('runs without Git while denying changes to the reservation file', async () => {
      rmSync(join(root, '.git'), { recursive: true });
      const result = await run(`
const fs = require('node:fs');
const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
fs.writeFileSync('ordinary.txt', 'sandbox ran');
fs.writeFileSync('replacement', 'gitdir: metadata');
console.log(JSON.stringify({
  created: fs.readFileSync('ordinary.txt', 'utf8'),
  overwrite: attempt(() => fs.writeFileSync('.git', 'gitdir: metadata')),
  unlink: attempt(() => fs.unlinkSync('.git')),
  replace: attempt(() => fs.renameSync('replacement', '.git')),
  rename: attempt(() => fs.renameSync('.git', 'old-git')),
}));
`);
      expect(result.created).toBe('sandbox ran');
      for (const operation of ['overwrite', 'unlink', 'replace', 'rename'])
        expect(result[operation], operation).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
      expect(readFileSync(join(root, '.git'), 'utf8')).toBe(GIT_RESERVATION);
      const panel = new GitService(root);
      expect((await panel.status()).isRepo).toBe(false);
      // Later host initialization remains available; sandbox setup has not initialized a repository.
      expect((await panel.init()).isRepo).toBe(true);
    });

    it('keeps the HEAD reservation of a project inside another repository in place (#132)', async () => {
      rmSync(join(root, '.git'), { recursive: true });
      execFileSync('git', ['init', '--quiet'], { cwd: fixture, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
      const result = await run(`
const fs = require('node:fs');
const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
fs.mkdirSync('objects');
fs.mkdirSync('refs');
fs.writeFileSync('config', '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = true\\n');
console.log(JSON.stringify({
  remove: attempt(() => fs.rmdirSync('HEAD')),
  rename: attempt(() => fs.renameSync('HEAD', 'old-head')),
  write: attempt(() => fs.writeFileSync('HEAD/planted', 'ref: refs/heads/main')),
}));
`);
      for (const operation of ['remove', 'rename', 'write'])
        expect(result[operation], operation).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
      expect(readdirSync(join(root, 'HEAD'))).toEqual([]);
      // Host Git still finds the enclosing repository instead of the planted bare repository.
      expect(git('rev-parse', '--is-bare-repository').trim()).toBe('false');
      expect(git('rev-parse', '--show-toplevel')).toBe(
        execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fixture, encoding: 'utf8' }),
      );
    });

    it('runs with Husky and active hooks while keeping existing and absent control metadata read-only', async () => {
      git('config', 'core.hooksPath', '.husky');
      mkdirSync(join(root, '.husky'));
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\necho SHOULD-NOT-RUN > hook-marker\n', {
        mode: 0o755,
      });
      writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const original = readFileSync(join(root, '.git', 'config'), 'utf8');
      const hook = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
      const result = await run(`
const fs = require('node:fs');
const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
fs.appendFileSync('source.txt', '-husky');
console.log(JSON.stringify({
  source: fs.readFileSync('source.txt', 'utf8'),
  config: attempt(() => fs.appendFileSync('.git/config', '\\n[alias]\\npwn = !echo planted\\n')),
  hook: attempt(() => fs.writeFileSync('.git/hooks/pre-commit', 'planted')),
  absent: attempt(() => fs.writeFileSync('.git/config.worktree', 'planted')),
}));
`);
      expect(result.source).toBe('original-husky');
      for (const operation of ['config', 'hook', 'absent'])
        expect(result[operation], operation).toMatch(/^(EACCES|EPERM|EROFS)$/);
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(original);
      expect(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(hook);
      expect(existsSync(join(root, 'hook-marker'))).toBe(false);
    });

    it.each(['gitfile', 'worktree'])(
      'protects an in-project %s and the entire metadata ancestor against redirected replacement',
      async (layout) => {
        let pointer = 'metadata/repo';
        if (layout === 'worktree') {
          const linked = join(fixture, 'linked');
          git('worktree', 'add', '--quiet', '--detach', linked);
          mkdirSync(join(linked, 'metadata'));
          renameSync(join(root, '.git'), join(linked, 'metadata', 'repo'));
          root = linked;
          pointer += '/worktrees/linked';
          if (kind !== 'container')
            copyFileSync(process.execPath, join(root, process.platform === 'win32' ? 'node.exe' : 'node'));
        } else {
          mkdirSync(join(root, 'metadata'));
          git('init', '--quiet', `--separate-git-dir=${join(root, 'metadata', 'repo')}`);
        }
        // Git for Windows marks the gitfile it wrote hidden, and Node cannot overwrite a hidden file (EPERM).
        rmSync(join(root, '.git'));
        writeFileSync(join(root, '.git'), `gitdir: ${pointer}\n`);
        const original = readFileSync(join(root, 'metadata', 'repo', 'config'), 'utf8');
        const result = await run(`
const fs = require('node:fs');
const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
fs.appendFileSync('source.txt', '-gitfile');
console.log(JSON.stringify({
  source: fs.readFileSync('source.txt', 'utf8'),
  pointer: attempt(() => fs.writeFileSync('.git', 'gitdir: other')),
  config: attempt(() => fs.appendFileSync('metadata/repo/config', 'planted')),
  absent: attempt(() => fs.writeFileSync('metadata/repo/config.worktree', 'planted')),
  ${layout === 'worktree' ? "common: attempt(() => fs.writeFileSync('metadata/repo/worktrees/linked/commondir', '../../../other'))," : ''}
  ancestor: attempt(() => fs.renameSync('metadata', 'old-metadata')),
}));
`);
        expect(result.source).toBe('original-gitfile');
        for (const operation of ['pointer', 'config', 'absent', 'ancestor'])
          expect(result[operation], operation).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
        if (layout === 'worktree') expect(result.common).toMatch(/^(EACCES|EPERM|EROFS)$/);
        expect(readFileSync(join(root, '.git'), 'utf8')).toBe(`gitdir: ${pointer}\n`);
        expect(readFileSync(join(root, 'metadata', 'repo', 'config'), 'utf8')).toBe(original);
        expect(git('show', 'HEAD:source.txt').trim()).toBe('original');
      },
    );

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
result.aliasLink = attempt(() => fs.linkSync('.git/config', 'config-alias'));
result.aliasWrite = result.aliasLink === 'allowed' ? attempt(() => fs.appendFileSync('config-alias', 'bad')) : 'not-attempted';
if (process.platform === 'darwin') {
  const parent = require('node:path').dirname(process.cwd());
  result.renameAncestor = attempt(() => { fs.renameSync(parent, parent + '-moved'); fs.renameSync(parent + '-moved', parent); });
}
console.log(JSON.stringify(result));
`);
      expect(result.source).toBe('original-edited');
      expect(result.created).toBe('new');
      expect(result.config).toBe(original);
      for (const operation of ['overwrite', 'absent', 'redirect', 'attributes', 'unlink', 'replace', 'renameDirectory'])
        expect(result[operation], operation).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
      if (kind === 'seatbelt') {
        // #99: the deny rule is path-based, so a hard link must not be created at all. The profile grants no
        // file-link operation, and `(deny default)` refuses it.
        expect(result.aliasLink).toMatch(/^(EACCES|EPERM)$/);
      } else if (result.aliasLink === 'allowed') {
        expect(result.aliasWrite).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
      } else {
        // Seatbelt may grow an explicit (file-link) denial; either boundary is safe if the alias is never writable.
        expect(result.aliasLink).toMatch(/^(EACCES|EPERM|EROFS|EBUSY|EXDEV)$/);
        expect(result.aliasWrite).toBe('not-attempted');
      }
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
fs.writeFileSync('empty-git-config', '');
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: require('node:path').resolve('empty-git-config'), GIT_TRACE: '1' };
const run = (args) => {
  const fd = fs.openSync('git-output', 'w');
  const result = spawnSync(${JSON.stringify(kind === 'container' ? 'git' : hostGit)}, ['-c', 'safe.directory=*', ...args], { env, stdio: ['inherit', fd, fd] });
  fs.closeSync(fd);
  return { code: result.status, error: result.error?.message, output: fs.readFileSync('git-output', 'utf8') };
};
let nullProbe;
if (fs.existsSync('null-probe.exe')) {
  const fd = fs.openSync('null-output', 'w');
  const result = spawnSync(require('node:path').resolve('null-probe.exe'), [], { stdio: ['inherit', fd, fd] });
  fs.closeSync(fd);
  nullProbe = { code: result.status, error: result.error?.message, host: fs.readFileSync('host-null-probe.json', 'utf8'), sandbox: fs.readFileSync('null-output', 'utf8') };
}
console.log(JSON.stringify({ nullProbe, status: run(['status', '--porcelain']), diff: run(['diff', '--no-ext-diff', '--no-textconv']), add: run(['add', 'source.txt']), commit: run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'denied']) }));
`);
      expect(result.status.code, JSON.stringify(result)).toBe(0);
      expect(result.diff.code, JSON.stringify(result.diff)).toBe(0);
      expect(result.diff.output).toContain('+changed');
      for (const operation of ['add', 'commit']) {
        expect(result[operation].error).toBeUndefined();
        expect(result[operation].code).not.toBe(0);
        expect(result[operation].output).toMatch(/permission denied|operation not permitted|read-only/i);
      }
      expect(git('log', '--format=%s').trim()).toBe('fixture');
      expect(git('diff', '--cached')).toBe('');
    });
  });
}
