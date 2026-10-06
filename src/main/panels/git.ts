import { existsSync, realpathSync } from 'node:fs';
import { lstat, readFile, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import { parseNumstat, type GitFile, type GitStatus } from '@shared/panels';
import { releaseGitReservation } from '../tools/sandbox_git';
import { Workspace } from '../tools/workspace';

// Git reads the repository's own .git/config, which can name commands to run: core.fsmonitor on status, clean and
// smudge filters (enabled by .gitattributes) on status, add and checkout, and diff drivers on diff. A folder from an
// untrusted source must not be able to run anything just because the Git panel was opened, so every call turns
// these off: fsmonitor is disabled, the filter drivers the repository defines in its local config are neutralized
// (filters configured globally by the user, such as git-lfs, keep working), and diffs skip external drivers and
// textconv. Hooks are disabled too: sandboxed commands can redirect core.hooksPath to a writable project folder.
export function hardenedConfig(localFilterNames: string[]): string[] {
  return [
    'safe.bareRepository=explicit',
    'core.fsmonitor=false',
    'core.hooksPath=/dev/null',
    ...localFilterNames.flatMap((name) => [
      `filter.${name}.clean=`,
      `filter.${name}.smudge=`,
      `filter.${name}.process=`,
      `filter.${name}.required=false`,
    ]),
  ];
}

// Settings in the repository's own config that make push or commit run a program: credential helpers, SSH and
// askpass commands, the receive/upload-pack programs of a local remote, and signing programs.
const PUSH_COMMANDS =
  /^(credential\..*helper|core\.sshcommand|core\.askpass|core\.gitproxy|remote\..*\.(receivepack|uploadpack))$/;
const COMMIT_COMMANDS = /^(gpg\.program|gpg\..*\.program)$/;

// The settings among `git config --local --null --get-regexp` output that run a file inside the project. A sandboxed
// command can rewrite any project file, so the panel must not run one with the user's rights (#130). The check is
// deliberately broad: any path-like word that leads into the project, a bare word naming a project file, or shell
// substitution counts; `~` paths, options and bare program names (`store`, `osxkeychain`) do not.
export function projectCommands(listing: string, root: string): string[] {
  const inside = (path: string) => {
    const rel = relative(root, resolve(root, path));
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  const runsProjectFile = (value: string) =>
    /[`$]/.test(value) ||
    value
      .replace(/^!/, '')
      .split(/\s+/)
      .map((word) => word.replace(/^['"]|['"]$/g, ''))
      .filter((word) => word && !word.startsWith('-') && !word.startsWith('~'))
      .some((word) => (/[\\/]/.test(word) || word === '.' ? inside(word) : existsSync(join(root, word))));
  return listing
    .split('\0')
    .filter(Boolean)
    .map((entry): [string, string] => {
      const newline = entry.indexOf('\n');
      return newline === -1 ? [entry, ''] : [entry.slice(0, newline), entry.slice(newline + 1)];
    })
    .filter(([, value]) => runsProjectFile(value))
    .map(([key, value]) => `${key}=${value}`);
}

// Names of the filter drivers defined in the repository's local config (filter.<name>.<key>). Reading config runs
// nothing.
export function filterNames(configListing: string): string[] {
  const names = configListing
    .split(/\r?\n/)
    .map((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1])
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

// A repository whose root is the user's home folder or a folder above it (often left by an accidental `git init`)
// is not the project's repository: `git status` there scans the whole profile, which can take minutes and gigabytes
// of memory. A project inside such a repository is shown as not a repository, unless the project is its root.
export function isRepoAboveHome(topLevel: string, projectRoot: string, home: string): boolean {
  const normalize = (path: string) => {
    const full = resolve(path);
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  const top = normalize(topLevel);
  const contains = (path: string) => {
    const rel = relative(top, normalize(path));
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  return top !== normalize(projectRoot) && contains(home);
}

// New files larger than this are not counted for the line counts in the Git panel.
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

// The Git panel: changed files, diffs, commit and discard for the open project.
export class GitService {
  private readonly workspace: Workspace;
  private hardened: Promise<SimpleGit> | null = null;

  constructor(root: string) {
    this.workspace = new Workspace(root);
  }

  // A simple-git instance with the overrides above. simple-git refuses to set hooksPath, fsmonitor and filters
  // unless allowed, which protects against attacker-chosen values; here the values are fixed and only disable them.
  private repo(): Promise<SimpleGit> {
    this.hardened ??= (async () => {
      // An empty sandbox reservation is not a repository. Do not discover planted bare metadata in the
      // writable project root instead; this guard must cover the config query as well as panel operations.
      const plain = simpleGit({ baseDir: this.workspace.root, config: ['safe.bareRepository=explicit'] });
      const listing = await plain
        .raw(['config', '--local', '--includes', '--name-only', '--get-regexp', '^filter\\.'])
        .catch(() => '');
      return simpleGit({
        baseDir: this.workspace.root,
        config: hardenedConfig(filterNames(listing)),
        unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true, allowUnsafeFilter: true },
      });
    })();
    return this.hardened;
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo()))
      return { isRepo: false, branch: null, files: [], tracking: null, ahead: 0, behind: 0, canPush: false };
    const repo = await this.repo();
    const status = await repo.status();
    const hasOrigin = status.tracking
      ? true
      : (await repo.getRemotes().catch(() => [])).some((remote) => remote.name === 'origin');
    return {
      isRepo: true,
      branch: status.current,
      files: await this.withLineCounts(toFiles(status)),
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      canPush: Boolean(status.current) && hasOrigin,
    };
  }

  // Adds the lines added and removed to each file: `git diff --numstat` for tracked files (renames counted as a
  // deletion and an addition), and the line count of new files, which git does not diff.
  private async withLineCounts(files: GitFile[]): Promise<GitFile[]> {
    if (files.length === 0) return files;
    const repo = await this.repo();
    const safe = ['--no-ext-diff', '--no-textconv', '--no-renames', '--numstat'];
    const hasHead = await repo.revparse(['--verify', 'HEAD']).then(
      () => true,
      () => false,
    );
    const output = hasHead
      ? await repo.diff([...safe, 'HEAD']).catch(() => '')
      : `${await repo.diff([...safe, '--cached']).catch(() => '')}\n${await repo.diff(safe).catch(() => '')}`;
    const counts = parseNumstat(output);
    return Promise.all(
      files.map(async (file) => {
        if (file.status === 'untracked') {
          const lines = await this.countLines(file.path);
          return lines === null ? file : { ...file, added: lines, removed: 0 };
        }
        const count = counts.get(file.path);
        return count ? { ...file, ...count } : file;
      }),
    );
  }

  private async countLines(path: string): Promise<number | null> {
    try {
      const content = await readFile(this.workspace.resolve(path));
      // Binary or large files are not counted, as git does not count binary files.
      if (content.length > MAX_COUNTED_BYTES || content.includes(0)) return null;
      const text = content.toString('utf8');
      return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      return null;
    }
  }

  // Pushes the current branch: to its upstream, or to `origin` (setting it as the upstream) when it has none yet.
  // Hooks stay disabled. Credentials come from the user's git setup (a credential manager may
  // show its own sign-in window); the app has no terminal, so git cannot ask for a password and fails instead.
  async push(): Promise<GitStatus> {
    if (!(await this.isRepo())) throw new Error('This project is not a Git repository.');
    const repo = await this.repo();
    const status = await repo.status();
    if (!status.current) throw new Error('Check out a branch before pushing.');
    await this.refuseProjectCommands(PUSH_COMMANDS);
    if (status.tracking) {
      await repo.push();
    } else {
      const remotes = await repo.getRemotes();
      if (!remotes.some((remote) => remote.name === 'origin'))
        throw new Error('This repository has no remote named origin to push to.');
      await repo.push(['--set-upstream', 'origin', status.current]);
    }
    return this.status();
  }

  // Reverts every changed file (and deletes new ones), as Discard does for one file.
  async discardAll(): Promise<GitStatus> {
    const status = await this.status();
    // An entry that cannot be discarded safely (inside a linked folder) is skipped, and the rest still go.
    const refused: string[] = [];
    for (const file of status.files) {
      try {
        await this.discard(file.path);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('inside a linked folder')) throw error;
        refused.push(file.path);
      }
    }
    if (refused.length > 0) {
      throw new Error(
        `Not discarded, because they are inside a linked folder: ${refused.join(', ')}. Remove the link itself instead.`,
      );
    }
    return this.status();
  }

  // Unified diff of all changes, or of one file. Untracked files are shown as additions.
  async diff(path: string | null): Promise<string> {
    if (!(await this.isRepo())) return '';
    const status = await (await this.repo()).status();
    const files = toFiles(status).filter((file) => path === null || file.path === path);

    const parts: string[] = [];
    const originals = new Map(status.renamed.map((rename) => [rename.to, rename.from]));
    const tracked = new Set<string>();
    for (const file of files) {
      if (file.status === 'untracked') continue;
      tracked.add(file.path);
      const original = originals.get(file.path);
      if (original) tracked.add(original);
    }
    if (tracked.size > 0) {
      const paths = [...tracked].map((path) => {
        this.workspace.resolve(path);
        return `:(literal)${path}`;
      });
      const hasHead = await (await this.repo()).revparse(['--verify', 'HEAD']).then(
        () => true,
        () => false,
      );
      // No external diff programs or textconv drivers: the repository's config could name any command.
      const safe = ['--no-ext-diff', '--no-textconv'];
      if (hasHead) {
        parts.push(await (await this.repo()).diff([...safe, 'HEAD', '--', ...paths]));
      } else {
        // An unborn branch has no HEAD: show both the initial index and subsequent working edits.
        parts.push(await (await this.repo()).diff([...safe, '--cached', '--', ...paths]));
        parts.push(await (await this.repo()).diff([...safe, '--', ...paths]));
      }
    }
    for (const file of files.filter((candidate) => candidate.status === 'untracked')) {
      const absolute = this.workspace.resolve(file.path);
      const content = await readFile(absolute, 'utf8').catch(() => '');
      parts.push(createTwoFilesPatch('/dev/null', `b/${file.path}`, '', content, '', ''));
    }
    return parts.filter(Boolean).join('\n');
  }

  async commit(message: string): Promise<GitStatus> {
    if (!message.trim()) throw new Error('Enter a commit message.');
    await this.refuseProjectCommands(COMMIT_COMMANDS);
    await (await this.repo()).add(['-A']);
    await (await this.repo()).commit(message.trim());
    return this.status();
  }

  // Reverts one file to the last commit; new (untracked) files are deleted.
  async discard(path: string): Promise<GitStatus> {
    if (!(await this.isRepo())) return this.status();
    const status = await (await this.repo()).status();
    const file = toFiles(status).find((candidate) => candidate.path === path);
    if (!file) return this.status();
    const literalPath = `:(literal)${path}`;
    const rename = status.renamed.find((candidate) => candidate.to === path);
    if (file.status === 'untracked') {
      await removeEntry(this.ownPath(path));
    } else if (rename) {
      this.workspace.resolve(rename.from);
      await (
        await this.repo()
      ).raw(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', rename.from, path]);
    } else if (file.status === 'added') {
      const own = this.ownPath(path);
      await (await this.repo()).rm(['--cached', '--', literalPath]);
      await removeEntry(own);
    } else {
      this.workspace.resolve(path);
      await (await this.repo()).checkout(['HEAD', '--', literalPath]);
    }
    return this.status();
  }

  // The entry itself, as Git names it, not where links lead (#111). Workspace.resolve returns the real path, so
  // deleting that would remove a link's target: a whole folder for `link -> src`. It still confines the path to the
  // project. An entry reached through a linked folder (Git lists `link/file` for a Windows junction) is the target
  // file itself, so discarding it is refused rather than deleting the real file.
  private ownPath(path: string): string {
    this.workspace.resolve(path);
    const own = resolve(this.workspace.root, path);
    const parent = dirname(own);
    let realParent: string;
    try {
      // Match Workspace's resolver: native() expands Windows 8.3 names, which would make an ordinary
      // RUNNER~1 temp path look like a linked folder when compared with Workspace.root.
      realParent = realpathSync(parent);
    } catch {
      return own;
    }
    const same =
      process.platform === 'win32' ? realParent.toLowerCase() === parent.toLowerCase() : realParent === parent;
    if (!same) {
      throw new Error(
        `${path} is inside a linked folder, so discarding it would delete the real file. Remove the link itself instead.`,
      );
    }
    return own;
  }

  async init(): Promise<GitStatus> {
    // Git refuses the folder while the sandbox reservation file exists.
    releaseGitReservation(this.workspace.root);
    await (await this.repo()).init();
    return this.status();
  }

  // Refuses before push or commit would run a project file named by the repository's own config (#130).
  private async refuseProjectCommands(keys: RegExp): Promise<void> {
    const listing = await (
      await this.repo()
    )
      .raw(['config', '--local', '--includes', '--null', '--get-regexp', keys.source])
      .catch(() => '');
    const found = projectCommands(listing, this.workspace.root);
    if (found.length > 0) {
      throw new Error(
        `This repository's own Git config runs a file inside the project (${found.join(', ')}). Commands the agent ran could have changed that file, so the Git panel does not run it. Check the file, then use your terminal.`,
      );
    }
  }

  private async isRepo(): Promise<boolean> {
    try {
      const topLevel = await (await this.repo()).revparse(['--show-toplevel']);
      return topLevel.length > 0 && !isRepoAboveHome(topLevel, this.workspace.root, homedir());
    } catch {
      return false;
    }
  }
}

// Deletes one entry: a real folder with its contents, a file, or a link itself (never what it points to). On Windows
// a directory link or junction is removed with rmdir, which unlink refuses.
export async function removeEntry(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    await rm(path, { force: true, recursive: stat.isDirectory() });
    return;
  }
  try {
    await unlink(path);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await rmdir(path);
  }
}

function toFiles(status: StatusResult): GitFile[] {
  const files = new Map<string, GitFile>();
  const add = (path: string, fileStatus: GitFile['status']) => {
    if (!files.has(path)) files.set(path, { path, status: fileStatus });
  };
  status.conflicted.forEach((path) => add(path, 'conflicted'));
  status.renamed.forEach((rename) => add(rename.to, 'renamed'));
  status.created.forEach((path) => add(path, 'added'));
  status.deleted.forEach((path) => add(path, 'deleted'));
  status.modified.forEach((path) => add(path, 'modified'));
  status.not_added.forEach((path) => add(path, 'untracked'));
  // Anything else git reports (e.g. type changes) shows as modified.
  status.files.forEach((file) => add(file.path, 'modified'));
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
