import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appLog } from '../app_log';

// Host Git recurses into submodules: `git status` in the user's terminal or editor runs inside each populated submodule
// with that submodule's own config, whose filters and fsmonitor run outside the sandbox. A submodule's .git is a
// working-tree entry (a gitfile, or an in-tree folder), so a sandboxed command can replace it, create one in a
// submodule that was not checked out, or rename the submodule folder away and put its own in its place (#294). The
// submodule paths come from the Git index, which sandboxed commands cannot change (it is under the protected .git), and
// each one's .git is recorded before a sandboxed command starts; when the command ends, one that was created or changed
// is moved aside, like the protected top-level entries (#262). Nested submodules are followed while their metadata is
// under the superproject's Git directory (`.git/modules`), which is protected too. A submodule whose .git is a folder
// in its own working tree is writable as a whole: its config files are compared, but submodules nested in it are not.

// Bounds for a project with very many or deeply nested submodules; the paths past them are not checked.
const MAX_SUBMODULES = 1000;
const MAX_DEPTH = 8;
// The files of an in-tree .git folder that make Git run programs or point it at other metadata.
const FOLDER_FILES = ['config', 'config.worktree', 'commondir', join('info', 'attributes')];

// Git with every repository setting that runs a program turned off; ls-files and rev-parse run none of the others.
// Variables such as GIT_DIR, GIT_INDEX_FILE or GIT_CONFIG_PARAMETERS from Patch's own environment are left out.
const GIT_ARGS = ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

// Runs git and calls `onRecord` for each NUL-separated record of its output, so a large index is never held whole.
function git(cwd: string, args: string[], onRecord: (record: string) => void): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn('git', [...GIT_ARGS, '--no-optional-locks', ...args], {
      cwd,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const records = (rest + chunk).split('\0');
      rest = records.pop() ?? '';
      for (const record of records) onRecord(record);
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rest) onRecord(rest);
      done(code === 0);
    });
  });
}

async function gitDir(cwd: string): Promise<string | null> {
  let out = '';
  const ok = await git(cwd, ['rev-parse', '--absolute-git-dir'], (record) => (out += record));
  return ok && out.trim() ? resolve(out.trim()) : null;
}

// The gitlink (submodule) entries of the index Git finds from `cwd`, relative to `cwd`.
async function gitlinks(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  const ok = await git(cwd, ['ls-files', '--stage', '-z'], (record) => {
    const tab = record.indexOf('\t');
    if (tab !== -1 && record.startsWith('160000 ')) paths.push(record.slice(tab + 1));
  });
  return ok ? paths : [];
}

const inside = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function statKey(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const s = lstatSync(path, { bigint: true });
        return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

// The submodule paths per project root, kept while the index files and gitfiles they were read from are unchanged.
const listings = new Map<string, { files: string[]; key: string; paths: string[] }>();

export function clearSubmoduleCache(): void {
  listings.clear();
}

// Every submodule path in the project, relative to `root`, checked out or not.
export async function submodulePaths(root: string): Promise<string[]> {
  const known = listings.get(root);
  if (known && statKey(known.files) === known.key) return known.paths;
  const top = await gitDir(root);
  if (top === null) {
    listings.delete(root);
    return [];
  }
  const files = [join(root, '.git'), join(top, 'index')];
  const paths: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length && paths.length < MAX_SUBMODULES) {
    const { dir, depth } = queue.shift()!;
    for (const link of await gitlinks(dir)) {
      if (paths.length >= MAX_SUBMODULES) break;
      const path = resolve(dir, link);
      if (!inside(root, path)) continue;
      paths.push(relative(root, path));
      if (depth + 1 >= MAX_DEPTH) continue;
      // Follow a nested submodule only when its metadata is in the protected .git/modules of the superproject.
      const pointer = join(path, '.git');
      if (!lstatSync(pointer, { throwIfNoEntry: false })?.isFile()) continue;
      const nested = await gitDir(path);
      if (nested === null || !inside(top, nested)) continue;
      files.push(pointer, join(nested, 'index'));
      queue.push({ dir: path, depth: depth + 1 });
    }
  }
  listings.set(root, { files, key: statKey(files), paths });
  return paths;
}

const digest = (path: string) => {
  try {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) return `l:${readlinkSync(path)}`;
    if (!s.isFile()) return `o:${s.mode}`;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return '-';
  }
};

// What a submodule's .git is: missing, a link, a gitfile (by content) or a folder (by identity and the content of the
// files that matter). Times are left out: Windows permission changes and ordinary Git work inside an in-tree .git folder
// change them without changing what Git would run.
function gitEntry(folder: string): string {
  const git = join(folder, '.git');
  let s;
  try {
    s = lstatSync(git, { bigint: true });
  } catch {
    return '-';
  }
  if (s.isSymbolicLink() || s.isFile()) return `f:${digest(git)}`;
  if (!s.isDirectory()) return `o:${s.mode}`;
  return `d:${s.dev}:${s.ino}:${FOLDER_FILES.map((name) => digest(join(git, name))).join(':')}`;
}

export interface SubmoduleSnapshot {
  root: string;
  entries: Map<string, string>;
}

// Taken right before a sandboxed command starts, from the paths submodulePaths listed.
export function submoduleSnapshot(root: string, paths: string[]): SubmoduleSnapshot {
  return { root, entries: new Map(paths.map((path) => [path, gitEntry(join(root, path))])) };
}

// Submodules whose .git exists after the command and differs from the snapshot. One the command removed is left out:
// without a .git, Git does not look inside the folder.
export function changedSubmoduleGit(snapshot: SubmoduleSnapshot): string[] {
  return [...snapshot.entries]
    .filter(([path, before]) => {
      const after = gitEntry(join(snapshot.root, path));
      return after !== '-' && after !== before;
    })
    .map(([path]) => path);
}

// After a sandboxed command ended: moves each changed submodule .git aside to `.git.patch-quarantine-<time>` in its
// folder when no other sandboxed command is running (`settled`), otherwise only reports it. Nothing is deleted.
// Returns the note for the command's output, or '' when nothing changed.
export function settleChangedSubmoduleGit(snapshot: SubmoduleSnapshot | null, settled: boolean): string {
  if (snapshot === null) return '';
  const changed = changedSubmoduleGit(snapshot);
  if (changed.length === 0) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved: string[] = [];
  const left: string[] = [];
  for (const path of changed) {
    const folder = join(snapshot.root, path);
    let target: string | null = null;
    if (settled) {
      for (let attempt = 0; attempt < 10 && target === null; attempt++) {
        const name = `.git.patch-quarantine-${stamp}${attempt ? `-${attempt}` : ''}`;
        if (existsSync(join(folder, name))) continue;
        try {
          renameSync(join(folder, '.git'), join(folder, name));
          target = name;
        } catch {
          break;
        }
      }
    }
    if (target === null) left.push(path);
    else moved.push(`${join(path, '.git')} to ${join(path, target)}`);
  }
  appLog.warn('sandbox', 'A sandboxed command changed the Git metadata of a submodule.', {
    count: changed.length,
    moved: moved.length,
  });
  const notes: string[] = [];
  if (moved.length > 0)
    notes.push(
      `[Patch moved ${moved.join(', ')}: a sandboxed command created or changed this submodule's Git metadata, which Git outside the sandbox would use. Check it before moving it back, or run git submodule update to restore the submodule.]`,
    );
  if (left.length > 0) {
    const reason = settled ? 'it could not be moved aside' : 'another command is still running';
    notes.push(
      `[The command created or changed the Git metadata (.git) of the submodule ${left.join(', ')}. Patch left it in place because ${reason}: check it before running Git in this project.]`,
    );
  }
  return `\n${notes.join('\n')}`;
}
