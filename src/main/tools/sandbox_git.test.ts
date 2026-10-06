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
import { GIT_RESERVATION, releaseGitReservation, validateSandboxGit } from './sandbox_git';
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

  // Git without the user's or system configuration, which might set safe.bareRepository.
  const plainGit = (cwd: string, ...args: string[]) => {
    writeFileSync(join(root, 'empty-config'), '');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-config') };
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  };
  const plantBare = (folder: string) => {
    mkdirSync(join(folder, 'objects'));
    mkdirSync(join(folder, 'refs'));
    writeFileSync(join(folder, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(folder, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  };

  it('reserves missing metadata with a file Git refuses, including repeated preparation', () => {
    rmSync(join(root, '.git'), { recursive: true });
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
    expect(validateSandboxGit(root)).toEqual([join(root, '.git')]);
    expect(readFileSync(join(root, '.git'), 'utf8')).toBe(GIT_RESERVATION);
    expect(() => plainGit(root, 'rev-parse', '--git-dir')).toThrow(/invalid gitfile format/);
  });

  it('keeps Git from discovering a bare repository planted beside the reservation (#129)', () => {
    // Control: next to an empty .git folder, the reservation of earlier versions, Git accepts a planted bare repository.
    const control = join(root, 'control');
    mkdirSync(join(control, '.git'), { recursive: true });
    plantBare(control);
    expect(plainGit(control, 'rev-parse', '--is-bare-repository').trim()).toBe('true');

    rmSync(join(root, '.git'), { recursive: true });
    validateSandboxGit(root);
    plantBare(root);
    expect(() => plainGit(root, 'rev-parse', '--git-dir')).toThrow(/invalid gitfile format/);
  });

  it('keeps an empty folder inside another repository, so Git still finds that repository', () => {
    plainGit(root, 'init', '--quiet');
    const nested = join(root, 'package');
    mkdirSync(nested);
    expect(validateSandboxGit(nested)).toEqual([join(nested, '.git'), join(nested, 'HEAD')]);
    expect(readdirSync(join(nested, '.git'))).toEqual([]);
    expect(readdirSync(join(nested, 'HEAD'))).toEqual([]);
    // Git ignores the empty HEAD folder, so the enclosing repository does not list it.
    expect(plainGit(root, 'status', '--porcelain', '--untracked-files=all', '--', 'package')).toBe('');
    // Compare with Git's own answer for the parent: on Windows CI the temp path is an 8.3 short name Git expands.
    expect(plainGit(nested, 'rev-parse', '--show-toplevel')).toBe(plainGit(root, 'rev-parse', '--show-toplevel'));

    // A reservation file written before the enclosing repository existed is turned back into the folder.
    rmSync(join(nested, '.git'), { recursive: true });
    writeFileSync(join(nested, '.git'), GIT_RESERVATION);
    validateSandboxGit(nested);
    expect(readdirSync(join(nested, '.git'))).toEqual([]);
  });

  it('keeps Git from accepting a bare repository planted in a project inside another repository (#132)', () => {
    plainGit(root, 'init', '--quiet');
    // Control: next to an empty .git folder, Git accepts the project folder as a planted bare repository.
    const control = join(root, 'control');
    mkdirSync(join(control, '.git'), { recursive: true });
    plantBare(control);
    expect(plainGit(control, 'rev-parse', '--is-bare-repository').trim()).toBe('true');

    const nested = join(root, 'package');
    mkdirSync(nested);
    validateSandboxGit(nested);
    // What a command can still plant. HEAD is a folder that the sandbox keeps in place (sandbox_git.integration.test.ts).
    mkdirSync(join(nested, 'objects'));
    mkdirSync(join(nested, 'refs'));
    writeFileSync(join(nested, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
    expect(() => writeFileSync(join(nested, 'HEAD'), 'ref: refs/heads/main\n')).toThrow();
    expect(plainGit(nested, 'rev-parse', '--show-toplevel')).toBe(plainGit(root, 'rev-parse', '--show-toplevel'));
    expect(plainGit(nested, 'rev-parse', '--is-bare-repository').trim()).toBe('false');
  });

  it('protects an existing HEAD in a project inside another repository, but refuses one Git would accept', () => {
    plainGit(root, 'init', '--quiet');
    const nested = join(root, 'package');
    mkdirSync(nested);
    writeFileSync(join(nested, 'HEAD'), 'notes\n');
    expect(validateSandboxGit(nested)).toEqual([join(nested, '.git'), join(nested, 'HEAD')]);
    writeFileSync(join(nested, 'HEAD'), 'ref: refs/heads/main\n');
    expect(() => validateSandboxGit(nested)).toThrow(/Git HEAD file/);
    writeFileSync(join(nested, 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(() => validateSandboxGit(nested)).toThrow(/Git HEAD file/);

    // A nested project with its own repository needs no HEAD reservation.
    rmSync(join(nested, 'HEAD'));
    rmSync(join(nested, '.git'), { recursive: true });
    plainGit(nested, 'init', '--quiet');
    expect(validateSandboxGit(nested)[0]).toBe(join(nested, '.git'));
    expect(existsSync(join(nested, 'HEAD'))).toBe(false);
  });

  it('replaces the empty reservation folder of earlier versions, but not a folder with contents', () => {
    rmSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.git'));
    validateSandboxGit(root);
    expect(readFileSync(join(root, '.git'), 'utf8')).toBe(GIT_RESERVATION);

    rmSync(join(root, '.git'));
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    validateSandboxGit(root);
    expect(readdirSync(join(root, '.git'))).toEqual(['hooks']);
  });

  it('turns only the reservation back into an empty folder for git init', () => {
    releaseGitReservation(root);
    expect(readdirSync(join(root, '.git')).sort()).toEqual(['config', 'hooks']);
    rmSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: metadata/repo\n');
    releaseGitReservation(root);
    expect(readFileSync(join(root, '.git'), 'utf8')).toBe('gitdir: metadata/repo\n');

    writeFileSync(join(root, '.git'), GIT_RESERVATION);
    releaseGitReservation(root);
    expect(readdirSync(join(root, '.git'))).toEqual([]);
    expect(plainGit(root, 'init', '--quiet')).toBe('');
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
