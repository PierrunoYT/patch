import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSandboxGit } from './sandbox_git';
import { ShellRunner } from './shell';

describe('sandbox Git layout validation', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-git-policy-'));
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts ordinary metadata without creating absent control files', () => {
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit.sample'), 'sample');
    const original = readFileSync(join(root, '.git', 'config'), 'utf8');
    validateSandboxGit(root);
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(original);
    expect(existsSync(join(root, '.git', 'config.worktree'))).toBe(false);
    expect(existsSync(join(root, '.git', 'commondir'))).toBe(false);
  });

  it('refuses missing metadata without initializing a repository', () => {
    rmSync(join(root, '.git'), { recursive: true });
    expect(() => validateSandboxGit(root)).toThrow(/explicit unsandboxed access/);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('refuses a worktree gitfile and a common-directory redirect', () => {
    writeFileSync(join(root, '.git', 'commondir'), '../other');
    expect(() => validateSandboxGit(root)).toThrow(/shared Git directories/);
    rmSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: ../other');
    expect(() => validateSandboxGit(root)).toThrow(/regular .git directory/);
  });

  it('refuses a directory junction or symlink instead of following it', () => {
    rmSync(join(root, '.git'), { recursive: true });
    const other = join(root, 'other');
    mkdirSync(other);
    symlinkSync(other, join(root, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => validateSandboxGit(root)).toThrow(/regular .git directory/);
  });

  it('refuses hardlinked config that would have a writable worktree alias', () => {
    linkSync(join(root, '.git', 'config'), join(root, 'alias'));
    expect(() => validateSandboxGit(root)).toThrow(/linked Git metadata/);
  });

  it.each(['config', 'config.worktree'])('refuses conditional includes in %s without reading their target', (name) => {
    writeFileSync(join(root, '.git', name), '[includeIf "onbranch:other"]\npath = ../untrusted\n');
    writeFileSync(join(root, 'untrusted'), 'not valid Git config');
    expect(() => validateSandboxGit(root)).toThrow(/configuration includes/);
  });

  it.each(['core.hooksPath', 'core.fsmonitor', 'alias.status', 'filter.custom.process'])(
    'refuses command override %s',
    (key) => {
      execFileSync('git', ['config', '--file', join(root, '.git', 'config'), key, 'arbitrary-command']);
      expect(() => validateSandboxGit(root)).toThrow(/command overrides/);
    },
  );

  it('refuses active hooks that can delegate to writable project scripts', () => {
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n./project-script\n');
    expect(() => validateSandboxGit(root)).toThrow(/active Git hooks/);
  });

  it('does not launch foreground or background commands for an unsupported layout', async () => {
    rmSync(join(root, '.git'), { recursive: true });
    const shell = new ShellRunner(
      () => root,
      () => ({ mode: 'container', network: 'off', image: 'node:lts', allowedHosts: '' }),
      () => ({ bwrap: false, seatbelt: false, appcontainer: null, container: 'docker' }),
    );
    expect((await shell.run('echo SHOULD-NOT-RUN')).output).toContain('command was not run');
    expect(() => shell.startBackground('echo SHOULD-NOT-RUN')).toThrow(/command was not run/);
  });
});
