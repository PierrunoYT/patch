import { existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, readFile, rm, rmdir, stat, unlink } from 'node:fs/promises';
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
// gpg.ssh.defaultKeyCommand runs when SSH signing is on and no signing key is set (#156).
const COMMIT_COMMANDS = /^(gpg\.program|gpg\..*\.program|gpg\.ssh\.defaultkeycommand)$/;

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

// From `git config --local --includes --show-origin --null --list` run in `root`: the filter drivers it defines, and
// every file the result depends on (each file an entry came from, and each file an include names, which may not
// exist or may have no entries yet).
export function parseConfigListing(listing: string, root: string): { filters: string[]; files: string[] } {
  const parts = listing.split('\0');
  const keys: string[] = [];
  const files = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i]!.replace(/^file:/, '');
    const entry = parts[i + 1]!;
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);
    const file = resolve(root, origin);
    files.add(file);
    keys.push(key);
    if (/^(include|includeif\..*)\.path$/i.test(key) && value) {
      files.add(value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(dirname(file), value));
    }
  }
  return { filters: filterNames(keys.join('\n')), files: [...files] };
}

// Size and times of a file, or '-' when it is missing, so a change, a new file or a removed one changes the key.
function statKey(files: string[]): string {
  return files
    .map((file) => {
      try {
        const stat = statSync(file);
        return `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      } catch {
        return `${file}:-`;
      }
    })
    .join('|');
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
const COUNT_CONCURRENCY = 16;

// The Git panel: changed files, diffs, commit and discard for the open project.
export class GitService {
  private readonly workspace: Workspace;
  // The hardened instance and the stat key of the config files its filter list was read from (null: not a
  // repository when it was read, so it is read again every time).
  private hardened: { key: string | null; files: string[]; repo: SimpleGit } | null = null;
  private loading: Promise<SimpleGit> | null = null;

  constructor(root: string) {
    this.workspace = new Workspace(root);
  }

  // A simple-git instance with the overrides above. simple-git refuses to set hooksPath, fsmonitor and filters
  // unless allowed, which protects against attacker-chosen values; here the values are fixed and only disable them.
  // The service is kept per project, so the filter list is read again only when a config file it came from (or one
  // that could add filters: the local and worktree config, an included file) changes.
  private repo(): Promise<SimpleGit> {
    const cached = this.hardened;
    if (cached && cached.key !== null && cached.key === statKey(cached.files)) return Promise.resolve(cached.repo);
    this.loading ??= this.loadRepo().finally(() => (this.loading = null));
    return this.loading;
  }

  private async loadRepo(): Promise<SimpleGit> {
    // An empty sandbox reservation is not a repository. Do not discover planted bare metadata in the
    // writable project root instead; this guard must cover the config query as well as panel operations.
    const plain = simpleGit({ baseDir: this.workspace.root, config: ['safe.bareRepository=explicit'] });
    const dirs = await plain
      .revparse(['--git-common-dir', '--git-dir'])
      .then((output) => output.split(/\r?\n/).map((dir) => resolve(this.workspace.root, dir.trim())))
      .catch(() => null);
    // Stat before reading, so a change made while git reads the config makes the next call read it again.
    const known = dirs
      ? [join(dirs[0]!, 'config'), join(dirs[1] ?? dirs[0]!, 'config.worktree'), ...(this.hardened?.files ?? [])]
      : [];
    const unique = [...new Set(known)];
    const key = dirs ? statKey(unique) : null;
    const listing = await plain
      .raw(['config', '--local', '--includes', '--show-origin', '--null', '--list'])
      .catch(() => '');
    const { filters, files } = parseConfigListing(listing, this.workspace.root);
    const all = [...new Set([...unique, ...files])];
    const repo = simpleGit({
      baseDir: this.workspace.root,
      config: hardenedConfig(filters),
      unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true, allowUnsafeFilter: true },
    });
    // Files found only now were not in the key: the next call reads again, then the set is complete.
    this.hardened = { key: all.length === unique.length ? key : null, files: all, repo };
    return repo;
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo()))
      return { isRepo: false, branch: null, files: [], tracking: null, ahead: 0, behind: 0, canPush: false };
    const repo = await this.repo();
    const { status, files } = await this.projectStatus();
    const hasOrigin = status.tracking
      ? true
      : (await repo.getRemotes().catch(() => [])).some((remote) => remote.name === 'origin');
    return {
      isRepo: true,
      branch: status.current,
      files: await this.withLineCounts(files),
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      canPush: Boolean(status.current) && hasOrigin,
    };
  }

  // The project's part of `git status`. The project can be a subfolder of the repository (#132), and Git prints
  // paths relative to the repository root, so the status is limited to the project folder and its paths are made
  // relative to it: the panel lists and acts on the project's files only. Pathspecs given to Git later are relative
  // to the project folder too, since simple-git runs Git there.
  private async projectStatus(): Promise<{ status: StatusResult; files: GitFile[]; renames: Map<string, string> }> {
    const repo = await this.repo();
    const prefix = await repo.revparse(['--show-prefix']).catch(() => '');
    const status = await repo.status(['--', '.']);
    return { status, ...projectFiles(status, prefix) };
  }

  // Adds the lines added and removed to each file: `git diff --numstat` for tracked files (renames counted as a
  // deletion and an addition), and the line count of new files, which git does not diff.
  private async withLineCounts(files: GitFile[]): Promise<GitFile[]> {
    if (files.length === 0) return files;
    const repo = await this.repo();
    // --relative limits the counts to the project folder and names files relative to it, as the status does.
    const safe = ['--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '--numstat'];
    const hasHead = await repo.revparse(['--verify', 'HEAD']).then(
      () => true,
      () => false,
    );
    const output = hasHead
      ? await repo.diff([...safe, 'HEAD']).catch(() => '')
      : `${await repo.diff([...safe, '--cached']).catch(() => '')}\n${await repo.diff(safe).catch(() => '')}`;
    const counts = parseNumstat(output);
    const result: GitFile[] = [];
    // A few files at a time, so many untracked files do not all sit in memory at once.
    for (let start = 0; start < files.length; start += COUNT_CONCURRENCY) {
      const batch = files.slice(start, start + COUNT_CONCURRENCY);
      result.push(
        ...(await Promise.all(
          batch.map(async (file) => {
            if (file.status === 'untracked') {
              const lines = await this.countLines(file.path);
              return lines === null ? file : { ...file, added: lines, removed: 0 };
            }
            const count = counts.get(file.path);
            return count ? { ...file, ...count } : file;
          }),
        )),
      );
    }
    return result;
  }

  private async countLines(path: string): Promise<number | null> {
    try {
      const absolute = this.workspace.resolve(path);
      // The size is checked before reading: a large untracked file (a dump, a video) was read whole on every status
      // refresh (#244).
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MAX_COUNTED_BYTES) return null;
      const content = await readFile(absolute);
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
    const { files: all, renames: originals } = await this.projectStatus();
    const files = all.filter((file) => path === null || file.path === path);

    const parts: string[] = [];
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
      // No external diff programs or textconv drivers: the repository's config could name any command. --relative
      // names files relative to the project folder, as the panel lists them.
      const safe = ['--no-ext-diff', '--no-textconv', '--relative'];
      if (hasHead) {
        parts.push(await (await this.repo()).diff([...safe, 'HEAD', '--', ...paths]));
      } else {
        // An unborn branch has no HEAD: show both the initial index and subsequent working edits.
        parts.push(await (await this.repo()).diff([...safe, '--cached', '--', ...paths]));
        parts.push(await (await this.repo()).diff([...safe, '--', ...paths]));
      }
    }
    for (const file of files.filter((candidate) => candidate.status === 'untracked')) {
      // A new link that points outside the project is left out instead of failing the whole diff, and a large new
      // file is not read whole (#259).
      let absolute: string;
      try {
        absolute = this.workspace.resolve(file.path);
      } catch {
        continue;
      }
      const info = await stat(absolute).catch(() => null);
      const content =
        info?.isFile() && info.size <= MAX_COUNTED_BYTES ? await readFile(absolute, 'utf8').catch(() => '') : '';
      parts.push(createTwoFilesPatch('/dev/null', `b/${file.path}`, '', content, '', ''));
    }
    return parts.filter(Boolean).join('\n');
  }

  async commit(message: string): Promise<GitStatus> {
    if (!message.trim()) throw new Error('Enter a commit message.');
    await this.refuseProjectCommands(COMMIT_COMMANDS);
    const repo = await this.repo();
    const prefix = await repo.revparse(['--show-prefix']);
    if (!prefix) {
      await repo.add(['-A']);
      await repo.commit(message.trim());
    } else {
      // A project inside a larger repository commits only its own folder. Naming the paths makes Git commit just
      // them (--only), so changes staged elsewhere in the repository stay staged and out of this commit.
      await repo.add(['-A', '--', '.']);
      await repo.raw(['commit', '-m', message.trim(), '--', '.']);
    }
    return this.status();
  }

  // Reverts one file to the last commit; new (untracked) files are deleted.
  async discard(path: string): Promise<GitStatus> {
    if (!(await this.isRepo())) return this.status();
    const { files, renames } = await this.projectStatus();
    const file = files.find((candidate) => candidate.path === path);
    if (!file) return this.status();
    const literalPath = `:(literal)${path}`;
    const from = renames.get(path);
    const rename = from === undefined ? undefined : { from, to: path };
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

// The changed files inside the project folder (`prefix`, from `git rev-parse --show-prefix`), with paths relative to
// it, and the renames among them (new path to old path). A status limited to the project already shows a rename across
// the project's edge as an addition or a deletion. Should one still appear, only the side inside the project is
// listed, as added or deleted: discarding it then touches nothing outside the project.
function projectFiles(status: StatusResult, prefix: string): { files: GitFile[]; renames: Map<string, string> } {
  const own = (path: string): string | null => (path.startsWith(prefix) ? path.slice(prefix.length) : null);
  const files = new Map<string, GitFile>();
  const renames = new Map<string, string>();
  const add = (repoPath: string, fileStatus: GitFile['status']) => {
    const path = own(repoPath);
    if (path !== null && path !== '' && !files.has(path)) files.set(path, { path, status: fileStatus });
  };
  status.conflicted.forEach((path) => add(path, 'conflicted'));
  status.renamed.forEach((rename) => {
    const to = own(rename.to);
    const from = own(rename.from);
    if (to !== null && from !== null) {
      renames.set(to, from);
      add(rename.to, 'renamed');
    } else if (to !== null) add(rename.to, 'added');
    else if (from !== null) add(rename.from, 'deleted');
  });
  status.created.forEach((path) => add(path, 'added'));
  status.deleted.forEach((path) => add(path, 'deleted'));
  status.modified.forEach((path) => add(path, 'modified'));
  status.not_added.forEach((path) => add(path, 'untracked'));
  // Anything else git reports (e.g. type changes) shows as modified.
  status.files.forEach((file) => add(file.path, 'modified'));
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), renames };
}
