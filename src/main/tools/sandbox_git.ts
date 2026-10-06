import { execFileSync } from 'node:child_process';
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

// Reserve missing metadata without initializing Git. Keep the reservation across command lifetimes:
// deleting it on exit could let an overlapping sandbox plant a gitfile or a new repository.
// Return top-level entries to protect, so metadata redirects cannot be replaced by renaming a writable ancestor.
export function validateSandboxGit(cwd: string): string[] {
  const refuse = (reason: string): never => {
    throw new Error(
      `Cannot protect Git metadata: ${reason}. The command was not run. Use the Git panel or request explicit unsandboxed access, which removes filesystem confinement and permits unrestricted network access.`,
    );
  };
  try {
    const workspace = new Workspace(cwd);
    const git = join(workspace.root, '.git');
    workspace.resolve('.git');
    if (insideRepository(workspace.root)) {
      // The file would stop Git from finding the enclosing repository, so reserve an empty folder there instead.
      // That keeps the #129 gap for such projects: Git may accept a bare repository planted in the project folder.
      if (isReservation(git)) releaseGitReservation(workspace.root);
      try {
        mkdirSync(git);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
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
    if (isReservation(git)) return [git];
    // A pointer may name the project through a link above it (macOS /tmp -> /private/tmp) only when no command can
    // retarget that link: it must sit in a root-owned directory that group and others cannot write. Every link inside
    // the project is refused, because a sandboxed command could point it at writable metadata.
    const systemAlias = (absolute: string, confined: string) => {
      if (process.platform === 'win32') return false;
      let top: string | null = null;
      for (let path = absolute; ; path = dirname(path)) {
        if (realpathSync(path) === workspace.root) top = path;
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
    const protectedPaths = new Set([git]);
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
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
          refuse('linked Git metadata is not supported');
        workspace.resolve(relative(workspace.root, path));
        if (stat.isDirectory()) pending.push(path);
        else if (!stat.isFile()) refuse('special files in Git metadata are not supported');
      }
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
      const entries = execFileSync(
        'git',
        ['--git-dir=/dev/null', 'config', '--file', path, '--no-includes', '--null', '--list'],
        {
          cwd: workspace.root,
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).split('\0');
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
    return [...protectedPaths];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot protect Git metadata:')) throw error;
    return refuse('metadata is unreadable, linked, outside the project, or unsupported');
  }
}
