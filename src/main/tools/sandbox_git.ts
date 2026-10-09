import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Workspace } from './workspace';

// The protected .git file that stands in for missing metadata. It is not a gitfile ("gitdir: ..."), so every Git
// stops at the project with "invalid gitfile format". An empty .git folder would not stop it: Git then checks
// whether the project folder itself is a bare repository, which a sandboxed command could plant there (#129).
export const GIT_RESERVATION =
  'Patch reserved this .git file so that sandboxed commands cannot create a Git repository in this folder.\n' +
  'Git refuses the folder while the file exists. To create a repository, use Initialize in the Git panel, or\n' +
  'delete this file and run git init.\n';

const isReservation = (git: string) => {
  const stat = lstatSync(git, { throwIfNoEntry: false });
  return Boolean(stat?.isFile() && stat.nlink === 1 && readFileSync(git, 'utf8') === GIT_RESERVATION);
};

// Turns the reservation back into an empty .git folder for git init. The folder is created right after the file is
// removed, so a running sandboxed command has no time to plant its own .git first.
export function releaseGitReservation(root: string): void {
  const git = join(new Workspace(root).root, '.git');
  if (!isReservation(git)) return;
  unlinkSync(git);
  mkdirSync(git);
}

// Whether a folder above the project has Git metadata, which Git finds from the project when it has none of its own.
// Like the Git panel, a repository at or above the home folder does not count (often an accidental `git init`).
function insideRepository(root: string): boolean {
  const home = homedir();
  for (let path = dirname(root); dirname(path) !== path; path = dirname(path)) {
    const rel = relative(path, home);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return false;
    if (existsSync(join(path, '.git'))) return true;
  }
  return false;
}

// Git accepts a folder as a bare repository only with a readable HEAD file in it. Inside another repository, where the
// project keeps an empty .git folder, a protected empty HEAD folder stops Git from accepting the project folder as a
// bare repository a sandboxed command planted there (#132). Git ignores empty folders, so the enclosing repository
// does not list it. Returns the path to protect.
function reserveHead(root: string, refuse: (reason: string) => never): string {
  const head = join(root, 'HEAD');
  try {
    mkdirSync(head);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(head);
  if (stat.isSymbolicLink()) refuse('a link named HEAD in the project folder is not supported');
  if (stat.isFile()) {
    if (stat.nlink !== 1) refuse('a linked HEAD file in the project folder is not supported');
    if (/^(ref:|[0-9a-f]{40})/i.test(readFileSync(head, 'utf8')))
      refuse('the project folder has a Git HEAD file, so Git may treat it as a bare repository');
  } else if (!stat.isDirectory()) refuse('a special file named HEAD in the project folder is not supported');
  return head;
}

// `git config --list` of one file, without includes, repository discovery or startup config.
function readConfig(path: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--git-dir=/dev/null', 'config', '--file', path, '--no-includes', '--null', '--list'],
      { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

// The last successful validation per project root (#112). It is reused while the fingerprint of the paths it read
// directly (.git, HEAD, the Git directories, their config, config.worktree, commondir and hooks folder, every config
// file it checked, and the protected top-level entries) is unchanged, and while the project's place inside or outside
// another repository is the same. The fingerprint does not see changes deeper in a protected tree, such as a link
// added under .git/refs: sandboxed commands cannot make those, because every returned path is read-only inside the
// sandbox, and the next change to .git itself (any Git write touches .git/index or a lock file) re-validates.
interface CachedCheck {
  watched: string[];
  fingerprint?: string;
  result?: string[];
}
const checks = new Map<string, CachedCheck>();

// File times tick coarsely (a few milliseconds on Linux), so a same-size write right after a validation can leave the
// fingerprint unchanged. Like Git's racy-index rule, a result is cached only when every watched path is older than
// racyMs. `validations` counts full validations; both are test seams.
export const sandboxGitCache = { validations: 0, racyMs: 2000 };

export function clearSandboxGitCache(): void {
  checks.clear();
}

// The paths every validation reads, before it knows where a gitfile points.
const basePaths = (root: string) => {
  const git = join(root, '.git');
  return [
    git,
    join(root, 'HEAD'),
    ...['config', 'config.worktree', 'commondir', 'hooks'].map((name) => join(git, name)),
  ];
};

// Identity, size and times of each path, with the newest time among them, or null when one cannot be read: then the
// cache is not used.
async function fingerprint(root: string, paths: string[]): Promise<{ text: string; newest: bigint } | null> {
  try {
    let newest = 0n;
    const stats = await Promise.all(
      paths.map(async (path) => {
        try {
          const s = await lstat(path, { bigint: true });
          for (const time of [s.mtimeNs, s.ctimeNs]) if (time > newest) newest = time;
          return `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return '-';
          throw error;
        }
      }),
    );
    return { text: JSON.stringify([insideRepository(root), ...paths.map((path, i) => [path, stats[i]])]), newest };
  } catch {
    return null;
  }
}

// Reserve missing metadata without initializing Git. Keep the reservation across command lifetimes:
// deleting it on exit could let an overlapping sandbox plant a gitfile or a new repository.
// Return top-level entries to protect, so metadata redirects cannot be replaced by renaming a writable ancestor.
// Asynchronous, so a large .git does not freeze the main process before every command (#112). A failure is never
// cached: every call after one validates again.
export async function validateSandboxGit(cwd: string): Promise<string[]> {
  let root: string | null = null;
  try {
    root = new Workspace(cwd).root;
  } catch {
    // The full validation reports it.
  }
  const known = root === null ? undefined : checks.get(root);
  const watched = known?.watched ?? (root === null ? [] : basePaths(root));
  const before = root === null ? null : await fingerprint(root, watched);
  if (known?.result && before !== null && before.text === known.fingerprint) return [...known.result];
  if (root !== null) checks.delete(root);
  const { result, read } = await checkSandboxGit(cwd);
  if (root !== null && before !== null) {
    // Cache only when every path the validation read was fingerprinted before it began and is unchanged after it,
    // so a change during the validation is never taken as validated. Otherwise remember the paths for next time.
    const all = [...new Set([...basePaths(root), ...read])];
    const covered = all.every((path) => watched.includes(path));
    const after = covered ? await fingerprint(root, watched) : null;
    const settled = BigInt(Date.now() - sandboxGitCache.racyMs) * 1_000_000n;
    checks.set(
      root,
      after !== null && after.text === before.text && after.newest < settled
        ? { watched, fingerprint: after.text, result: [...result] }
        : { watched: all },
    );
  }
  return result;
}

async function checkSandboxGit(cwd: string): Promise<{ result: string[]; read: string[] }> {
  sandboxGitCache.validations++;
  const refuse = (reason: string): never => {
    throw new Error(
      `Cannot protect Git metadata: ${reason}. The command was not run. Use the Git panel or request explicit unsandboxed access, which removes filesystem confinement and permits unrestricted network access.`,
    );
  };
  try {
    const workspace = new Workspace(cwd);
    const git = join(workspace.root, '.git');
    workspace.resolve('.git');
    let head: string | null = null;
    if (insideRepository(workspace.root)) {
      // The file would stop Git from finding the enclosing repository, so reserve an empty folder there instead.
      // Next to that folder Git checks whether the project folder is a bare repository; a protected HEAD prevents it.
      if (isReservation(git)) releaseGitReservation(workspace.root);
      try {
        mkdirSync(git);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const existing = lstatSync(git);
      if (existing.isDirectory() && !existing.isSymbolicLink() && readdirSync(git).length === 0)
        head = reserveHead(workspace.root, refuse);
    } else {
      // Earlier versions reserved an empty folder; replace it. A link is never removed: it is refused below.
      const existing = lstatSync(git, { throwIfNoEntry: false });
      if (existing?.isDirectory() && !existing.isSymbolicLink() && readdirSync(git).length === 0) rmdirSync(git);
      try {
        writeFileSync(git, GIT_RESERVATION, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const root = lstatSync(git);
    if (root.isSymbolicLink() || (!root.isDirectory() && !root.isFile()))
      refuse('the project .git must be a regular directory or gitfile');
    if (root.isFile() && root.nlink !== 1) refuse('linked Git metadata is not supported');
    if (isReservation(git)) return { result: [git], read: [] };
    // A pointer may name the project through a link above it (macOS /tmp -> /private/tmp) only when no command can
    // retarget that link: it must sit in a root-owned directory that group and others cannot write. Every link inside
    // the project is refused, because a sandboxed command could point it at writable metadata.
    const systemAlias = (absolute: string, confined: string) => {
      if (process.platform === 'win32') return false;
      let top: string | null = null;
      for (let path = absolute; ; path = dirname(path)) {
        if (realpathSync.native(path) === workspace.root) top = path;
        if (dirname(path) === path) break;
      }
      if (top === null || relative(top, absolute) !== relative(workspace.root, confined)) return false;
      for (let path = top; dirname(path) !== path; path = dirname(path)) {
        if (!lstatSync(path).isSymbolicLink()) continue;
        const parent = lstatSync(dirname(path));
        if (parent.uid !== 0 || (parent.mode & 0o022) !== 0) return false;
      }
      return true;
    };
    const pointer = (base: string, value: string) => {
      const absolute = resolve(base, value);
      const confined = workspace.resolve(absolute);
      if (relative(absolute, confined) !== '' && !systemAlias(absolute, confined))
        refuse('linked Git metadata is not supported');
      return confined;
    };
    const metadata = root.isDirectory()
      ? git
      : pointer(
          workspace.root,
          readFileSync(git, 'utf8').match(/^gitdir: (.+?)\s*$/)?.[1] ?? refuse('invalid Git directory pointer'),
        );
    const directories = [metadata];
    const common = workspace.resolve(join(metadata, 'commondir'));
    if (existsSync(common)) directories.push(pointer(metadata, readFileSync(common, 'utf8').trim()));
    const protectedPaths = new Set(head ? [git, head] : [git]);
    for (const directory of directories) {
      if (!lstatSync(directory).isDirectory()) refuse('Git directory pointers must name existing directories');
      const top =
        relative(workspace.root, directory).split(sep)[0] ||
        refuse('Git metadata at the writable project root is not supported');
      protectedPaths.add(workspace.resolve(top));
    }
    const pending = [...protectedPaths].filter((path) => lstatSync(path).isDirectory());
    while (pending.length) {
      const directory = pending.pop()!;
      const names = await readdir(directory);
      const paths = names.map((name) => join(directory, name));
      // Checked in listing order after all are read, so the reason given does not depend on which lstat ends first.
      const stats = await Promise.all(paths.map((path) => lstat(path)));
      paths.forEach((path, i) => {
        const stat = stats[i]!;
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
          refuse('linked Git metadata is not supported');
        workspace.resolve(relative(workspace.root, path));
        if (stat.isDirectory()) pending.push(path);
        else if (!stat.isFile()) refuse('special files in Git metadata are not supported');
      });
    }
    // Existing executable integrations are not planted metadata. Includes are different: a writable include
    // lets the command plant new config without changing .git. Allow only targets inside the protected trees.
    const configs = directories.flatMap((directory) =>
      ['config', 'config.worktree'].map((name) => join(directory, name)),
    );
    const checked = new Set<string>();
    while (configs.length) {
      const path = workspace.resolve(configs.pop()!);
      if (checked.has(path)) continue;
      checked.add(path);
      if (!existsSync(path)) continue;
      // Suppress repository discovery and startup config loading as well: --no-includes applies only to
      // --file, not to config Git loads during startup when --git-dir names a real repository.
      const entries = (await readConfig(path, workspace.root)).split('\0');
      for (const entry of entries) {
        const newline = entry.indexOf('\n');
        if (!/^(include|includeif\..+)\.path$/i.test(newline === -1 ? entry : entry.slice(0, newline))) continue;
        const value = newline === -1 ? '' : entry.slice(newline + 1);
        if (!value || value.startsWith('~') || value.startsWith('%('))
          refuse('configuration includes outside protected Git directories are not supported');
        const target = workspace.resolve(resolve(dirname(path), value));
        if (![...protectedPaths].some((protectedPath) => target.startsWith(`${protectedPath}${sep}`)))
          refuse('configuration includes outside protected Git directories are not supported');
        configs.push(target);
      }
    }
    // What the result depends on directly, for the cache's fingerprint.
    const read = [
      metadata,
      ...directories.flatMap((directory) =>
        ['config', 'config.worktree', 'commondir', 'hooks'].map((name) => join(directory, name)),
      ),
      ...protectedPaths,
      ...checked,
    ];
    return { result: [...protectedPaths], read };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot protect Git metadata:')) throw error;
    return refuse('metadata is unreadable, linked, outside the project, or unsupported');
  }
}
