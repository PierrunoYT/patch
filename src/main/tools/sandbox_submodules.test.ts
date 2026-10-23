import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  changedSubmoduleGit,
  clearSubmoduleCache,
  settleChangedSubmoduleGit,
  submodulePaths,
  submoduleSnapshot,
} from './sandbox_submodules';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Patch', '-c', 'user.email=patch@example.com', '-c', 'protocol.file.allow=always', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

function repo(path: string, file = 'readme.txt'): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, file), 'x\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'init');
  return path;
}

// Git marks a gitfile hidden on Windows, where a hidden file cannot be opened for writing: replace it, as a command
// would.
const replace = (path: string, text: string) => {
  rmSync(path, { force: true });
  writeFileSync(path, text);
};

// A project with every kind of submodule: `lib` (metadata in .git/modules) with a nested `lib/leaf`, `vendor/empty`
// that is not checked out, and `inner`, a repository added in place whose .git is a folder in its working tree. Built
// once; each test gets a copy (every gitfile and core.worktree in it is relative).
let template: string;
let base: string;
let root: string;
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'patch-submodules-'));
  const leaf = repo(join(template, 'leaf'));
  const lib = repo(join(template, 'lib-source'));
  git(lib, 'submodule', 'add', '-q', leaf, 'leaf');
  git(lib, 'commit', '-q', '-m', 'add leaf');
  const project = repo(join(template, 'project'));
  git(project, 'submodule', 'add', '-q', lib, 'lib');
  git(project, 'submodule', 'update', '-q', '--init', '--recursive');
  const head = git(leaf, 'rev-parse', 'HEAD').trim();
  git(project, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/empty`);
  mkdirSync(join(project, 'vendor', 'empty'), { recursive: true });
  repo(join(project, 'inner'));
  git(project, 'add', 'inner');
  git(project, 'commit', '-q', '-m', 'submodules');
}, 60_000);
afterAll(() => rmSync(template, { recursive: true, force: true }));
beforeEach(() => {
  clearSubmoduleCache();
  base = mkdtempSync(join(tmpdir(), 'patch-submodules-'));
  root = join(base, 'project');
  cpSync(join(template, 'project'), root, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const sorted = (paths: string[]) => paths.map((path) => path.replace(/\\/g, '/')).sort();

describe('submodule .git entries a sandboxed command changes (#294)', () => {
  it('lists every submodule from the index, nested ones under .git/modules too, checked out or not', async () => {
    expect(sorted(await submodulePaths(root))).toEqual(['inner', 'lib', 'lib/leaf', 'vendor/empty']);
  });

  it('lists nothing outside a repository', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, '.git'), 'not a gitfile\n');
    expect(await submodulePaths(plain)).toEqual([]);
  });

  it('reads the index again once it changed', async () => {
    expect(await submodulePaths(root)).toHaveLength(4);
    git(root, 'rm', '-q', '--cached', 'vendor/empty');
    expect(sorted(await submodulePaths(root))).toEqual(['inner', 'lib', 'lib/leaf']);
  });

  it('reports nothing when the submodules are unchanged, also after Git work inside an in-tree .git folder', async () => {
    const snapshot = submoduleSnapshot(root, await submodulePaths(root));
    writeFileSync(join(root, 'inner', 'more.txt'), 'y\n');
    git(join(root, 'inner'), 'add', '.');
    git(join(root, 'inner'), 'commit', '-q', '-m', 'more');
    expect(changedSubmoduleGit(snapshot)).toEqual([]);
    expect(settleChangedSubmoduleGit(snapshot, true)).toBe('');
  });

  it('finds a replaced gitfile, a .git created where none was, a changed config and a swapped folder', async () => {
    const snapshot = submoduleSnapshot(root, await submodulePaths(root));
    replace(join(root, 'lib', '.git'), 'gitdir: ../planted\n');
    mkdirSync(join(root, 'vendor', 'empty', '.git'));
    writeFileSync(join(root, 'vendor', 'empty', '.git', 'config'), '[core]\n\tfsmonitor = calc.exe\n');
    writeFileSync(join(root, 'inner', '.git', 'config'), '[filter "x"]\n\tclean = calc.exe\n', { flag: 'a' });
    renameSync(join(root, 'lib', 'leaf'), join(root, 'lib', 'leaf-away'));
    mkdirSync(join(root, 'lib', 'leaf', '.git'), { recursive: true });
    expect(sorted(changedSubmoduleGit(snapshot))).toEqual(['inner', 'lib', 'lib/leaf', 'vendor/empty']);
  });

  it('leaves out a submodule whose .git the command removed', async () => {
    const snapshot = submoduleSnapshot(root, await submodulePaths(root));
    rmSync(join(root, 'lib', '.git'));
    expect(changedSubmoduleGit(snapshot)).toEqual([]);
  });

  it('moves a changed .git aside, keeping its content, once no other command runs, and only reports it before', async () => {
    const snapshot = submoduleSnapshot(root, await submodulePaths(root));
    replace(join(root, 'lib', '.git'), 'gitdir: ../planted\n');

    const early = settleChangedSubmoduleGit(snapshot, false);
    expect(early).toMatch(/submodule lib\. Patch left it in place because another command is still running/);
    expect(readFileSync(join(root, 'lib', '.git'), 'utf8')).toBe('gitdir: ../planted\n');

    const note = settleChangedSubmoduleGit(snapshot, true);
    expect(note).toMatch(/Patch moved lib[\\/]\.git to lib[\\/]\.git\.patch-quarantine-/);
    expect(existsSync(join(root, 'lib', '.git'))).toBe(false);
    const [moved] = readdirSync(join(root, 'lib')).filter((name) => name.startsWith('.git.patch-quarantine-'));
    expect(readFileSync(join(root, 'lib', moved!), 'utf8')).toBe('gitdir: ../planted\n');
    // The submodule is no longer checked out, so host Git does not look inside it.
    expect(git(root, 'status', '--porcelain', '--', 'lib')).toBe('');
  });

  it('does nothing without a snapshot (an unsandboxed command)', () => {
    expect(settleChangedSubmoduleGit(null, true)).toBe('');
  });
});
