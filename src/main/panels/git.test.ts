import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitFile } from '@shared/panels';
import { validateSandboxGit } from '../tools/sandbox_git';
import { filterNames, GitService, hardenedConfig, isRepoAboveHome, projectCommands, removeEntry } from './git';

const tempFolderInsideRepo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: tmpdir() }).status === 0;

let root: string;
let service: GitService;

// Path and status only, for tests about which files are listed rather than their line counts.
const kinds = (files: GitFile[]) => files.map(({ path, status }) => ({ path, status }));

// Building a repository takes nine git processes, which is most of what these tests cost on Windows. Each test copies
// a template made once instead; only the folder the copy is in differs.
let templates: { base: string; empty: string; committed: string } | undefined;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-git-template-'));
  const empty = join(base, 'empty');
  const committed = join(base, 'committed');
  mkdirSync(empty);
  const git = simpleGit({ baseDir: empty });
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  await git.addConfig('core.autocrlf', 'false');
  await git.addConfig('status.renames', 'true');
  await git.addConfig('diff.renames', 'true');
  cpSync(empty, committed, { recursive: true });
  writeFileSync(join(committed, 'a.txt'), 'one\n');
  const withCommit = simpleGit({ baseDir: committed });
  await withCommit.add('-A');
  await withCommit.commit('first');
  templates = { base, empty, committed };
}, 60_000);

afterAll(() => {
  if (templates) rmSync(templates.base, { recursive: true, force: true });
});

async function initRepo(initialCommit = true): Promise<void> {
  if (!templates) throw new Error('The repository templates were not built.');
  cpSync(initialCommit ? templates.committed : templates.empty, root, { recursive: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-git-'));
  service = new GitService(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitService', () => {
  // Git finds a repository in any parent folder, so this cannot hold when the temp folder is inside one (for example
  // a home folder under version control).
  it.skipIf(tempFolderInsideRepo)('reports a folder that is not a repository', async () => {
    expect(await service.status()).toEqual({
      isRepo: false,
      branch: null,
      files: [],
      tracking: null,
      ahead: 0,
      behind: 0,
      canPush: false,
    });
    expect(await service.diff(null)).toBe('');
  });

  it('initializes a repository', async () => {
    const status = await service.init();
    expect(status.isRepo).toBe(true);
    expect(status.files).toEqual([]);
  });

  it('can initialize an empty sandbox reservation on the same service after checking status', async () => {
    validateSandboxGit(root);
    expect((await service.status()).isRepo).toBe(false);
    expect((await service.init()).isRepo).toBe(true);
  });

  it('does not discover planted bare metadata outside the protected reservation', async () => {
    validateSandboxGit(root);
    expect(spawnSync('git', ['init', '--bare', '--template='], { cwd: root }).status).toBe(0);
    writeFileSync(join(root, 'config'), '[core]\nbare = true\n[include]\npath = nonexistent\n');
    // Git stops at the reservation file instead of accepting the planted bare repository (#129).
    await expect(simpleGit({ baseDir: root }).raw(['rev-parse', '--is-bare-repository'])).rejects.toThrow(
      /invalid gitfile format/,
    );
    expect((await service.status()).isRepo).toBe(false);
    expect(await service.diff(null)).toBe('');
    await expect(service.commit('must not trust writable metadata')).rejects.toThrow(/invalid gitfile format/);
  });

  it('lists modified and untracked files, sorted by path', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    const status = await service.status();
    expect(status.isRepo).toBe(true);
    expect(status.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
      { path: 'b.txt', status: 'untracked', added: 1, removed: 0 },
    ]);
    expect(status).toMatchObject({ tracking: null, ahead: 0, behind: 0, canPush: false });
  });

  it('counts the lines of new files, but not of binary ones', async () => {
    await initRepo();
    writeFileSync(join(root, 'three.txt'), 'a\nb\nc');
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 0]));
    const files = (await service.status()).files;
    expect(files.find((file) => file.path === 'three.txt')).toMatchObject({ added: 3, removed: 0 });
    expect(files.find((file) => file.path === 'image.bin')).toEqual({ path: 'image.bin', status: 'untracked' });
  });

  it('discards every change at once', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    const status = await service.discardAll();
    expect(status.files).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
  });

  it('pushes to origin and sets it as the upstream, then pushes there again', async () => {
    await initRepo();
    const remote = mkdtempSync(join(tmpdir(), 'cc-git-remote-'));
    try {
      await simpleGit({ baseDir: remote }).init(true);
      await simpleGit({ baseDir: root }).addRemote('origin', remote);
      expect((await service.status()).canPush).toBe(true);
      const first = await service.push();
      expect(first.tracking).toMatch(/^origin\//);
      writeFileSync(join(root, 'a.txt'), 'two\n');
      await service.commit('second');
      expect((await service.status()).ahead).toBe(1);
      expect((await service.push()).ahead).toBe(0);
      expect(await simpleGit({ baseDir: remote }).raw(['log', '--format=%s'])).toContain('second');
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('refuses to push without a remote', async () => {
    await initRepo();
    await expect(service.push()).rejects.toThrow('no remote named origin');
  });

  it('shows tracked changes and untracked files in the diff', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'brand new\n');
    const all = await service.diff(null);
    expect(all).toContain('-one');
    expect(all).toContain('+two');
    expect(all).toContain('+brand new');

    const onlyNew = await service.diff('b.txt');
    expect(onlyNew).toContain('+brand new');
    expect(onlyNew).not.toContain('+two');
  });

  it('shows staged additions and working edits before the first commit', async () => {
    await initRepo(false);
    const git = simpleGit({ baseDir: root });
    writeFileSync(join(root, 'initial.txt'), 'staged content\n');
    writeFileSync(join(root, 'other.txt'), 'other staged content\n');
    await git.add(['initial.txt', 'other.txt']);
    writeFileSync(join(root, 'initial.txt'), 'working content\n');
    writeFileSync(join(root, 'untracked.txt'), 'untracked content\n');

    const all = await service.diff(null);
    expect(all).toContain('+staged content');
    expect(all).toContain('-staged content');
    expect(all).toContain('+working content');
    expect(all).toContain('+other staged content');
    expect(all).toContain('+untracked content');

    const selected = await service.diff('initial.txt');
    expect(selected).toContain('+staged content');
    expect(selected).toContain('+working content');
    expect(selected).not.toContain('other staged content');
    expect(selected).not.toContain('untracked content');
  });

  it('limits tracked diffs and discard to a literal filename', async () => {
    await initRepo();
    const git = simpleGit({ baseDir: root });
    writeFileSync(join(root, 'file[1].txt'), 'literal baseline\n');
    writeFileSync(join(root, 'file1.txt'), 'neighbor baseline\n');
    await git.add(['file[1].txt', 'file1.txt']);
    await git.commit('literal filenames');
    writeFileSync(join(root, 'file[1].txt'), 'literal edit\n');
    writeFileSync(join(root, 'file1.txt'), 'neighbor edit\n');

    const diff = await service.diff('file[1].txt');
    expect(diff).toContain('+literal edit');
    expect(diff).not.toContain('neighbor edit');

    const status = await service.discard('file[1].txt');
    expect(readFileSync(join(root, 'file[1].txt'), 'utf8')).toBe('literal baseline\n');
    expect(readFileSync(join(root, 'file1.txt'), 'utf8')).toBe('neighbor edit\n');
    expect(kinds(status.files)).toEqual([{ path: 'file1.txt', status: 'modified' }]);
  });

  it('commits all changes and rejects an empty message', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    await expect(service.commit('   ')).rejects.toThrow('Enter a commit message.');
    const status = await service.commit('  update  ');
    expect(status.files).toEqual([]);
    const log = await simpleGit({ baseDir: root }).log();
    expect(log.latest?.message).toBe('update');
  });

  it('discards a modified file, deletes an untracked file and unstages an added file', async () => {
    await initRepo();
    const git = simpleGit({ baseDir: root });
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    writeFileSync(join(root, 'untracked.txt'), 'x\n');
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'staged.txt'), 'y\n');
    await git.add('dir/staged.txt');

    await service.discard('a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');

    await service.discard('untracked.txt');
    expect(existsSync(join(root, 'untracked.txt'))).toBe(false);

    const status = await service.discard('dir/staged.txt');
    expect(existsSync(join(root, 'dir', 'staged.txt'))).toBe(false);
    expect(status.files).toEqual([]);
  });

  // #111: Workspace.resolve returns the real path, so discarding a link must not delete what it points to.
  it('discards an untracked link to a project folder without deleting the folder', async () => {
    await initRepo();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'keep.txt'), 'keep\n');
    const git = simpleGit({ baseDir: root });
    await git.add('-A');
    await git.commit('src');
    symlinkSync(join(root, 'src'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    // Git lists a symlink as `link`; on Windows it looks through a junction and lists `link/keep.txt` instead.
    const before = await service.status();
    const entry = before.files.find((file) => file.path === 'link' || file.path.startsWith('link/'));
    expect(entry, JSON.stringify(kinds(before.files))).toBeDefined();
    if (entry!.path === 'link') {
      await service.discard('link');
      expect(() => lstatSync(join(root, 'link'))).toThrow();
    } else {
      // `link/keep.txt` is src/keep.txt itself, so discarding it is refused instead of deleting the real file.
      await expect(service.discard(entry!.path)).rejects.toThrow(/inside a linked folder/);
      expect(lstatSync(join(root, 'link')).isSymbolicLink()).toBe(true);
    }
    expect(readFileSync(join(root, 'src', 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('discards everything else and names the entries inside a linked folder', async () => {
    await initRepo();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'keep.txt'), 'keep\n');
    const git = simpleGit({ baseDir: root });
    await git.add('-A');
    await git.commit('src');
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    symlinkSync(join(root, 'src'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedEntry = (await service.status()).files.some((file) => file.path.startsWith('link/'));

    if (linkedEntry) await expect(service.discardAll()).rejects.toThrow(/inside a linked folder: link\/keep\.txt/);
    else await service.discardAll();
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(root, 'src', 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('removes a link itself, never the folder it points to', async () => {
    mkdirSync(join(root, 'target'));
    writeFileSync(join(root, 'target', 'keep.txt'), 'keep\n');
    symlinkSync(join(root, 'target'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await removeEntry(join(root, 'link'));
    expect(() => lstatSync(join(root, 'link'))).toThrow();
    expect(readFileSync(join(root, 'target', 'keep.txt'), 'utf8')).toBe('keep\n');
    // A real folder is still removed with its contents, and a missing entry is not an error.
    await removeEntry(join(root, 'target'));
    expect(existsSync(join(root, 'target'))).toBe(false);
    await removeEntry(join(root, 'missing'));
  });

  it.each(['none', 'staged', 'unstaged', 'both'])(
    'discards a staged rename with %s modifications without touching other changes',
    async (modifications) => {
      await initRepo();
      const git = simpleGit({ baseDir: root });
      const baseline = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
      writeFileSync(join(root, 'a.txt'), baseline);
      await git.add('a.txt');
      await git.commit('rename baseline');
      await git.mv('a.txt', 'renamed[1].txt');
      let content = baseline;
      if (modifications === 'staged' || modifications === 'both') {
        content += 'staged edit\n';
        writeFileSync(join(root, 'renamed[1].txt'), content);
        await git.add('renamed[1].txt');
      }
      if (modifications === 'unstaged' || modifications === 'both') {
        content += 'working edit\n';
        writeFileSync(join(root, 'renamed[1].txt'), content);
      }
      writeFileSync(join(root, 'unrelated.txt'), 'keep staged\n');
      await git.add('unrelated.txt');
      writeFileSync(join(root, 'untracked.txt'), 'keep untracked\n');

      expect(kinds((await service.status()).files)).toContainEqual({ path: 'renamed[1].txt', status: 'renamed' });
      const diff = await service.diff('renamed[1].txt');
      expect(diff).toContain('rename from a.txt');
      expect(diff).toContain('rename to renamed[1].txt');
      if (modifications === 'staged' || modifications === 'both') expect(diff).toContain('+staged edit');
      if (modifications === 'unstaged' || modifications === 'both') expect(diff).toContain('+working edit');

      const status = await service.discard('renamed[1].txt');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(baseline);
      expect(existsSync(join(root, 'renamed[1].txt'))).toBe(false);
      expect(await git.show([':a.txt'])).toBe(baseline);
      expect(await git.raw(['ls-files', '--', ':(literal)renamed[1].txt'])).toBe('');
      expect(await git.diff(['--'])).toBe('');
      expect(kinds(status.files)).toEqual([
        { path: 'unrelated.txt', status: 'added' },
        { path: 'untracked.txt', status: 'untracked' },
      ]);
      expect(await git.show([':unrelated.txt'])).toBe('keep staged\n');
      expect(readFileSync(join(root, 'untracked.txt'), 'utf8')).toBe('keep untracked\n');
    },
  );

  it('ignores a discard of a file without changes', async () => {
    await initRepo();
    const status = await service.discard('a.txt');
    expect(status.files).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });
});

// A repository from an untrusted source can name commands in its own .git/config. Opening the Git panel, viewing a
// diff or discarding a file must not run any of them (issue #24). Each "command" here only creates a marker file.
describe('GitService with a hostile repository config', () => {
  const marker = (name: string) => join(root, `MARKER_${name}`);
  const markerCommand = (name: string) =>
    process.platform === 'win32'
      ? `cmd /c type nul > "${marker(name)}" & exit 1`
      : `sh -c 'touch "${marker(name)}"; exit 1'`;
  // Plain git: simple-git (rightly) refuses to write these settings.
  const config = (key: string, value: string) => {
    expect(spawnSync('git', ['config', key, value], { cwd: root }).status).toBe(0);
  };

  it.each(['.git/hooks', 'agent-hooks'])('does not execute hooks from %s on commit or push', async (hooksPath) => {
    await initRepo();
    // Initialize the cached Git client before the agent changes the repository config.
    await service.status();
    const git = simpleGit({ baseDir: root });
    const remote = mkdtempSync(join(tmpdir(), 'cc-git-hooks-remote-'));
    try {
      await simpleGit({ baseDir: remote }).init(true);
      await git.addRemote('origin', remote);
      mkdirSync(join(root, hooksPath), { recursive: true });
      config('core.hooksPath', hooksPath);
      for (const hook of ['pre-commit', 'pre-push']) {
        writeFileSync(
          join(root, hooksPath, hook),
          `#!/bin/sh\nprintf ran > "${marker(hook).replaceAll('\\', '/')}"\n`,
          { mode: 0o755 },
        );
        // Prove the fixture is executable, rather than passing because Git ignores an invalid hook.
        await git.raw(['hook', 'run', hook]);
        expect(readFileSync(marker(hook), 'utf8')).toBe('ran');
        rmSync(marker(hook));
      }
      writeFileSync(join(root, 'a.txt'), 'changed\n');
      await service.commit('without host hooks');
      expect((await service.push()).ahead).toBe(0);
      expect(existsSync(marker('pre-commit'))).toBe(false);
      expect(existsSync(marker('pre-push'))).toBe(false);
      expect(await simpleGit({ baseDir: remote }).raw(['log', '--format=%s'])).toContain('without host hooks');
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it.each([
    ['credential.helper', '!./cred.sh'],
    ['core.sshCommand', 'sh cred.sh'],
    ['remote.origin.receivepack', './cred.sh'],
  ])('does not push when the repository %s runs a project file (#130)', async (key, value) => {
    await initRepo();
    const remote = mkdtempSync(join(tmpdir(), 'cc-git-commands-remote-'));
    try {
      await simpleGit({ baseDir: remote }).init(true);
      await simpleGit({ baseDir: root }).addRemote('origin', remote);
      writeFileSync(join(root, 'cred.sh'), `#!/bin/sh\ntouch "${marker('cred').replaceAll('\\', '/')}"\n`, {
        mode: 0o755,
      });
      config(key, value);
      await expect(service.push()).rejects.toThrow(/runs a file inside the project/);
      expect(existsSync(marker('cred'))).toBe(false);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('still pushes with helpers outside the project', async () => {
    await initRepo();
    const remote = mkdtempSync(join(tmpdir(), 'cc-git-commands-remote-'));
    try {
      await simpleGit({ baseDir: remote }).init(true);
      await simpleGit({ baseDir: root }).addRemote('origin', remote);
      config('credential.helper', 'store');
      config('core.sshCommand', 'ssh -i ~/.ssh/work');
      expect((await service.push()).ahead).toBe(0);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('does not commit when the repository signing program is a project file (#130)', async () => {
    await initRepo();
    writeFileSync(join(root, 'sign.sh'), `#!/bin/sh\ntouch "${marker('sign').replaceAll('\\', '/')}"\n`, {
      mode: 0o755,
    });
    config('commit.gpgSign', 'true');
    config('gpg.program', './sign.sh');
    writeFileSync(join(root, 'a.txt'), 'two\n');
    await expect(service.commit('signed')).rejects.toThrow(/gpg\.program=\.\/sign\.sh/);
    expect(existsSync(marker('sign'))).toBe(false);
  });

  it('does not commit when the SSH signing key command is a project file (#156)', async () => {
    await initRepo();
    writeFileSync(join(root, 'key.sh'), `#!/bin/sh\ntouch "${marker('key').replaceAll('\\', '/')}"\n`, {
      mode: 0o755,
    });
    config('commit.gpgSign', 'true');
    config('gpg.format', 'ssh');
    config('gpg.ssh.defaultKeyCommand', './key.sh');
    writeFileSync(join(root, 'a.txt'), 'two\n');
    await expect(service.commit('signed')).rejects.toThrow(/gpg\.ssh\.defaultkeycommand=\.\/key\.sh/);
    expect(existsSync(marker('key'))).toBe(false);
  });

  it('does not run core.fsmonitor when reading the status', async () => {
    await initRepo();
    writeFileSync(join(root, 'a.txt'), 'two\n');
    await config('core.fsmonitor', markerCommand('fsmonitor'));

    const status = await service.status();
    expect(kinds(status.files)).toEqual([{ path: 'a.txt', status: 'modified' }]);
    expect(existsSync(marker('fsmonitor'))).toBe(false);
  });

  it('does not run textconv or external diff drivers', async () => {
    await initRepo();
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=evil\n');
    await config('diff.evil.textconv', markerCommand('textconv'));
    await config('diff.external', markerCommand('external'));
    writeFileSync(join(root, 'a.txt'), 'two\n');

    const diff = await service.diff('a.txt');
    expect(diff).toContain('+two');
    expect(existsSync(marker('textconv'))).toBe(false);
    expect(existsSync(marker('external'))).toBe(false);
  });

  it('does not run clean or smudge filters defined by the repository', async () => {
    await initRepo();
    writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n');
    await config('filter.evil.clean', markerCommand('clean'));
    await config('filter.evil.smudge', markerCommand('smudge'));
    writeFileSync(join(root, 'a.txt'), 'two\n');

    expect(kinds((await service.status()).files)).toContainEqual({ path: 'a.txt', status: 'modified' });
    expect(await service.diff('a.txt')).toContain('+two');
    await service.discard('a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(marker('clean'))).toBe(false);
    expect(existsSync(marker('smudge'))).toBe(false);
  });
});

describe('projectCommands', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-git-project-commands-'));
    writeFileSync(join(project, 'helper.sh'), '');
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));
  const listing = (entries: Record<string, string>) =>
    Object.entries(entries)
      .map(([key, value]) => `${key}\n${value}\0`)
      .join('');

  it('names settings that run a project file, by relative path, bare name, absolute path or substitution', () => {
    expect(
      projectCommands(
        listing({
          'credential.helper': '!./helper.sh get',
          'core.sshcommand': 'sh helper.sh',
          'gpg.program': join(project, 'bin', 'gpg'),
          'core.askpass': 'echo $(cat x)',
        }),
        project,
      ),
    ).toEqual([
      'credential.helper=!./helper.sh get',
      'core.sshcommand=sh helper.sh',
      `gpg.program=${join(project, 'bin', 'gpg')}`,
      'core.askpass=echo $(cat x)',
    ]);
  });

  it('accepts helpers outside the project', () => {
    expect(
      projectCommands(
        listing({
          'credential.helper': 'osxkeychain',
          'credential.https://example.com.helper': '!/usr/local/bin/helper --flag',
          'core.sshcommand': 'ssh -i ~/.ssh/work -o IdentitiesOnly=yes',
        }),
        project,
      ),
    ).toEqual([]);
    expect(projectCommands('', project)).toEqual([]);
  });
});

describe('filterNames and hardenedConfig', () => {
  it('finds each filter driver once, including names with dots', () => {
    expect(filterNames('filter.lfs.clean\nfilter.lfs.smudge\r\nfilter.my.tool.process\n\n')).toEqual([
      'lfs',
      'my.tool',
    ]);
    expect(filterNames('')).toEqual([]);
  });

  it('disables fsmonitor and neutralizes each named filter', () => {
    expect(hardenedConfig(['evil'])).toEqual([
      'safe.bareRepository=explicit',
      'core.fsmonitor=false',
      'core.hooksPath=/dev/null',
      'filter.evil.clean=',
      'filter.evil.smudge=',
      'filter.evil.process=',
      'filter.evil.required=false',
    ]);
  });
});

describe('isRepoAboveHome', () => {
  const home = join(tmpdir(), 'home', 'user');

  it('rejects a repository at the home folder or above it for a project inside it', () => {
    expect(isRepoAboveHome(home, join(home, 'code', 'app'), home)).toBe(true);
    expect(isRepoAboveHome(join(home, '..'), join(home, 'AppData', 'Temp', 'p'), home)).toBe(true);
  });

  it('accepts the project being the repository root, even the home folder', () => {
    expect(isRepoAboveHome(home, home, home)).toBe(false);
  });

  it('accepts repositories below the home folder or elsewhere', () => {
    expect(isRepoAboveHome(join(home, 'code'), join(home, 'code', 'app'), home)).toBe(false);
    expect(isRepoAboveHome(join(tmpdir(), 'work'), join(tmpdir(), 'work', 'app'), home)).toBe(false);
    expect(isRepoAboveHome(join(home, 'code'), join(home, 'code-other'), home)).toBe(false);
  });

  it('compares git-style forward-slash paths', () => {
    expect(isRepoAboveHome(home.replaceAll('\\', '/'), join(home, 'app'), home)).toBe(true);
  });
});
