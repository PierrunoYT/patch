import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { ToolError } from './types';

// Always skipped when listing, searching or indexing, in addition to .gitignore. `.git` without a slash also covers
// gitfiles and the sandbox's reservation file.
const ALWAYS_IGNORED = ['.git', 'node_modules/', '.DS_Store', 'Thumbs.db'];

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
  private ignoreRules: Ignore | null = null;

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

  isIgnored(absolute: string, isDirectory: boolean): boolean {
    const rel = this.relative(absolute);
    if (rel === '.') return false;
    return this.rules().ignores(isDirectory ? `${rel}/` : rel);
  }

  // Walks the project breadth-first, skipping ignored paths, up to `limit` files.
  async listFiles(start = this.root, limit = 50_000): Promise<string[]> {
    const files: string[] = [];
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
        if (this.isIgnored(full, entry.isDirectory())) continue;
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile()) files.push(full);
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  // Re-read .gitignore on the next call (after the agent or user changed it).
  invalidateIgnoreRules(): void {
    this.ignoreRules = null;
  }

  private rules(): Ignore {
    if (!this.ignoreRules) {
      const rules = ignore().add(ALWAYS_IGNORED);
      for (const name of ['.gitignore', '.ccignore']) {
        try {
          const file = this.resolve(name);
          if (existsSync(file)) rules.add(readFileSync(file, 'utf8'));
        } catch (error) {
          // Ignore rules cannot opt a project into reading outside its root, including through dangling links.
          if (!(error instanceof ToolError)) throw error;
        }
      }
      this.ignoreRules = rules;
    }
    return this.ignoreRules;
  }
}
