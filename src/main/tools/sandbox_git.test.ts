import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSandboxGit } from './sandbox_git';
import { ShellRunner } from './shell';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), readdirSync: vi.fn(fs.readdirSync) };
});

describe('sandbox Git layout validation', () => {
  let root: string;
  beforeEach(() => {
    // validateSandboxGit returns real paths; macOS's temp folder is under the /var -> /private/var link.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-git-policy-')));
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  });
  afterEach(() => {
    vi.mocked(readdirSync).mockClear();
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts ordinary metadata without creating absent control files', () => {
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit.sample'), 'sample');
    const original = readFileSync(join(root, '.git', 'config'), 'utf8');
    validateSandboxGit(root);
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(original);
    expect(existsSync(join(root, '.git', 'config.worktree'))).toBe(false);
    expect(existsSync(join(root, '.git', 'commondir'))).toBe(false);
  });

  it('reserves missing metadata without initializing a repository, including repeated preparation', () => {
    rmSync(join(root, '.git'), { recursive: true });
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
    expect(readdirSync(join(root, '.git'))).toEqual([]);
    expect(() =>
      execFileSync('git', ['--git-dir', join(root, '.git'), 'rev-parse', '--git-dir'], { stdio: 'pipe' }),
    ).toThrow();
  });

  it('protects an in-project gitfile and the metadata ancestor against replacement', () => {
    mkdirSync(join(root, 'metadata'));
    renameSync(join(root, '.git'), join(root, 'metadata', 'repo'));
    writeFileSync(join(root, '.git'), 'gitdir: metadata/repo\n');
    expect(validateSandboxGit(root)).toEqual([join(root, '.git'), join(root, 'metadata')]);
  });

  it('protects an in-project common directory as well as worktree metadata', () => {
    mkdirSync(join(root, 'common', 'repo'), { recursive: true });
    writeFileSync(join(root, '.git', 'commondir'), '../common/repo\n');
    expect(validateSandboxGit(root)).toEqual([join(root, '.git'), join(root, 'common')]);
  });

  it('refuses external worktree and common-directory pointers', () => {
    writeFileSync(join(root, '.git', 'commondir'), '../../other');
    expect(() => validateSandboxGit(root)).toThrow(/outside the project/);
    rmSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: ../other');
    expect(() => validateSandboxGit(root)).toThrow(/outside the project/);
  });

  it('refuses a gitfile redirected through a writable directory link', () => {
    renameSync(join(root, '.git'), join(root, 'metadata'));
    symlinkSync(join(root, 'metadata'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(root, '.git'), 'gitdir: link\n');
    expect(() => validateSandboxGit(root)).toThrow(/linked Git metadata/);
  });

  describe.skipIf(process.platform === 'win32')('pointers that name the project through a link above it', () => {
    // root/real/project is the workspace; root/alias -> root/real is how the pointer names it.
    let project: string;
    beforeEach(() => {
      project = join(root, 'real', 'project');
      mkdirSync(join(project, 'metadata'), { recursive: true });
      renameSync(join(root, '.git'), join(project, 'metadata', 'repo'));
      symlinkSync(join(root, 'real'), join(root, 'alias'), 'dir');
      writeFileSync(join(project, '.git'), `gitdir: ${join(root, 'alias', 'project', 'metadata', 'repo')}\n`);
    });
    let actual: typeof lstatSync;
    beforeEach(async () => {
      actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).lstatSync;
    });
    afterEach(() => vi.mocked(lstatSync).mockImplementation(actual));
    // Tests cannot create a root-owned folder, so report the link's folder as one, like / on macOS.
    const trustRoot = () =>
      vi.mocked(lstatSync).mockImplementation(((path: string) => {
        const stat = actual(path);
        return path === root ? Object.assign(stat, { uid: 0, mode: 0o40755 }) : stat;
      }) as typeof lstatSync);

    it('accepts the link when it sits in a root-owned directory nobody else can write (macOS /tmp)', () => {
      trustRoot();
      expect(validateSandboxGit(project)).toEqual([join(project, '.git'), join(project, 'metadata')]);
    });

    it('refuses the link when its directory is writable by a user, such as a temp folder', () => {
      expect(() => validateSandboxGit(project)).toThrow(/linked Git metadata/);
    });

    it('refuses a link inside the project even when the path above it is trusted', () => {
      trustRoot();
      symlinkSync(join(project, 'metadata'), join(project, 'inner'), 'dir');
      writeFileSync(join(project, '.git'), `gitdir: ${join(project, 'inner', 'repo')}\n`);
      expect(() => validateSandboxGit(project)).toThrow(/linked Git metadata/);
    });
  });

  it('refuses a directory junction or symlink instead of following it', () => {
    rmSync(join(root, '.git'), { recursive: true });
    const other = join(root, 'other');
    mkdirSync(other);
    symlinkSync(other, join(root, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => validateSandboxGit(root)).toThrow(/regular directory or gitfile/);
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

  it.each([
    'core.hooksPath',
    'core.fsmonitor',
    'alias.status',
    'filter.custom.process',
    'credential.helper',
    'diff.custom.textconv',
    'core.editor',
    'core.pager',
  ])('protects existing command override %s without executing it', (key) => {
    execFileSync('git', ['config', '--file', join(root, '.git', 'config'), key, 'arbitrary-command']);
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
  });

  it('accepts active hooks without executing them', () => {
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n./project-script\n');
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
  });

  it('accepts protected includes but checks transitive includes and cycles without following writable targets', () => {
    writeFileSync(join(root, '.git', 'config'), '[include]\npath = extra\n');
    writeFileSync(join(root, '.git', 'extra'), '[include]\npath = config\n');
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
    writeFileSync(join(root, '.git', 'extra'), '[include]\npath = ../untrusted\n');
    expect(() => validateSandboxGit(root)).toThrow(/configuration includes/);
  });

  it('refuses a home-relative include rather than treating it as a literal protected filename', () => {
    writeFileSync(join(root, '.git', 'config'), '[include]\npath = ~/project-config\n');
    expect(() => validateSandboxGit(root)).toThrow(/configuration includes/);
  });

  it('accepts metadata trees above the former 100,000-entry limit', () => {
    // Exercise the old counting boundary without creating 100,001 files on every Windows test run.
    vi.mocked(readdirSync).mockReturnValueOnce(Array(100_001).fill('config'));
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
  });

  it('does not launch foreground or background commands for an unsupported layout', async () => {
    rmSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: ../outside');
    const shell = new ShellRunner(
      () => root,
      () => ({ mode: 'container', network: 'off', image: 'node:lts', allowedHosts: '' }),
      () => ({ bwrap: false, seatbelt: false, appcontainer: null, container: 'docker' }),
    );
    expect((await shell.run('echo SHOULD-NOT-RUN')).output).toContain('command was not run');
    expect(() => shell.startBackground('echo SHOULD-NOT-RUN')).toThrow(/command was not run/);
  });
});
