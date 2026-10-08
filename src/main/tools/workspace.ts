import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { ToolError } from './types';

// Always skipped when listing, searching or indexing, in addition to .gitignore. `.git` without a slash also covers
// gitfiles and the sandbox's reservation file.
const ALWAYS_IGNORED = ['.git', 'node_modules/', '.DS_Store', 'Thumbs.db'];

// Read in this order, so .gitignore overrides .git/info/exclude (as in git) and .ccignore overrides both.
const ROOT_IGNORE_FILES = ['.git/info/exclude', '.gitignore', '.ccignore'];

// Size and times of a regular file (through links), or null when it is missing, a folder or unreadable.
function fileStat(path: string): Stats | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// The real path of `target`: its deepest part that exists (a file, a folder or a link) is resolved through any links,
// and the missing rest is appended. Null for a link that leads nowhere, whose destination cannot be checked.
function realPathAllowingMissing(target: string): string | null {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  try {
    const real = realpathSync(current);
    return missing.length > 0 ? join(real, ...missing) : real;
  } catch {
    return null;
  }
}

// The project the agent works in. Every path from the model is resolved against the root and must stay inside it.
export class Workspace {
  readonly root: string;
  private folderRules = new Map<string, { key: string; rules: Ignore | null }>();

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
  }

  // Resolves a model-supplied path (relative or absolute) and rejects anything outside the project.
  resolve(path: string): string {
    if (!path || typeof path !== 'string') throw new ToolError('A file path is required.');
    const target = resolve(this.root, path);
    // Follow links so none can point the agent outside the project, including for a file that does not exist yet:
    // `link/new.txt`, where `link` is a folder link to somewhere else, must be checked where it would really be written.
    const real = realPathAllowingMissing(target);
    if (real === null) throw new ToolError(`Path is outside the project: ${path}`);
    const rel = relative(this.root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ToolError(`Path is outside the project: ${path}`);
    }
    return real;
  }

  // Project-relative path with forward slashes, for display and for the model.
  relative(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/') || '.';
  }

  // Whether git (plus .ccignore and the always-skipped names) would ignore this path, checking every folder above it.
  isIgnored(absolute: string, isDirectory: boolean): boolean {
    const rel = this.relative(absolute);
    if (rel === '.') return false;
    const load = this.ruleLoader();
    const parts = rel.split('/');
    // Nothing inside an ignored folder can be re-included, so check the folders from the top first.
    for (let i = 1; i < parts.length; i++) {
      if (this.matches(parts.slice(0, i).join('/'), true, load)) return true;
    }
    return this.matches(rel, isDirectory, load);
  }

  // Walks the project breadth-first, skipping ignored paths, up to `limit` files.
  async listFiles(start = this.root, limit = 50_000): Promise<string[]> {
    const files: string[] = [];
    // One rule lookup (and stat) per folder for the whole walk, not one per file.
    const load = this.ruleLoader();
    if (start !== this.root && this.isIgnored(start, true)) return files;
    const queue = [start];
    while (queue.length > 0 && files.length < limit) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        // The walk never enters an ignored folder, so only the entry itself needs checking.
        if (this.matches(this.relative(full), entry.isDirectory(), load)) continue;
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile()) files.push(full);
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  // Forget the cached rules. Not required for correctness, since rules are re-read when an ignore file changes.
  invalidateIgnoreRules(): void {
    this.folderRules.clear();
  }

  // Git's precedence: the rules of deeper folders win over shallower ones, and within one file the last match wins.
  private matches(rel: string, isDirectory: boolean, load: (dir: string) => Ignore | null): boolean {
    const target = isDirectory ? `${rel}/` : rel;
    let ignored = false;
    let dir = '';
    for (;;) {
      const rules = load(dir);
      if (rules) {
        const result = rules.test(dir ? target.slice(dir.length + 1) : target);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      const next = rel.indexOf('/', dir ? dir.length + 1 : 0);
      if (next < 0) return ignored;
      dir = rel.slice(0, next);
    }
  }

  // Rules of one folder ('' is the root), remembered for the lifetime of the returned function.
  private ruleLoader(): (dir: string) => Ignore | null {
    const seen = new Map<string, Ignore | null>();
    return (dir) => {
      let rules = seen.get(dir);
      if (rules === undefined) {
        rules = this.folderRulesFor(dir);
        seen.set(dir, rules);
      }
      return rules;
    };
  }

  // The root's rules come from the always-skipped names, .git/info/exclude, .gitignore and .ccignore; any other folder's
  // from its own .gitignore. They are cached until a source file changes, appears or disappears, so edits made by any
  // tool, a command, Undo or the user are picked up without anyone invalidating the cache.
  private folderRulesFor(dir: string): Ignore | null {
    const sources = dir ? [`${dir}/.gitignore`] : ROOT_IGNORE_FILES;
    const stats = sources.map((source) => fileStat(join(this.root, source)));
    const key = stats
      .map((stat) => (stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}` : '-'))
      .join('|');
    const cached = this.folderRules.get(dir);
    if (cached?.key === key) return cached.rules;

    let rules: Ignore | null = dir ? null : ignore().add(ALWAYS_IGNORED);
    sources.forEach((source, i) => {
      if (!stats[i]) return;
      const content = this.readIgnoreFile(source);
      if (content !== null) rules = (rules ?? ignore()).add(content);
    });
    this.folderRules.set(dir, { key, rules });
    return rules;
  }

  private readIgnoreFile(source: string): string | null {
    try {
      return readFileSync(this.resolve(source), 'utf8');
    } catch (error) {
      // Ignore rules cannot opt a project into reading outside its root, including through dangling links.
      if (error instanceof ToolError) return null;
      throw error;
    }
  }
}
