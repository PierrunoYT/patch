import { existsSync } from 'node:fs';
import { isAbsolute, parse, sep } from 'node:path';
import { canonical } from './sandbox';

// Per-command extra filesystem access (#126): a command may ask for read-only or read/write access to a few paths
// outside the project while staying sandboxed. Pure planning plus canonicalisation; the backends mount the result.

export interface PathGrants {
  read: string[];
  write: string[];
}

export interface GrantRequest {
  readPaths?: string[];
  writePaths?: string[];
}

export interface GrantContext {
  cwd: string;
  home: string;
  // Read-only inside the sandbox whatever is granted: Git metadata and the project's configuration.
  protectedPaths: string[];
  // Application and system directories that are never granted.
  sensitivePaths: string[];
}

export const MAX_GRANT_PATHS = 8;

export function hasPathGrants(access: GrantRequest): boolean {
  return (access.readPaths?.length ?? 0) > 0 || (access.writePaths?.length ?? 0) > 0;
}

function fold(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

function contains(parent: string, child: string): boolean {
  const a = fold(parent);
  const b = fold(child);
  const prefix = a.endsWith(sep) ? a : `${a}${sep}`;
  return b === a || b.startsWith(prefix);
}

const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);

function resolveOne(raw: string, writable: boolean, ctx: GrantContext, cwd: string, home: string): string {
  const label = `${writable ? 'write_paths' : 'read_paths'} entry "${raw}"`;
  if (typeof raw !== 'string' || raw.includes('\0') || !isAbsolute(raw))
    throw new Error(`${label} must be an absolute path.`);
  if (!existsSync(raw))
    throw new Error(
      `${label} does not exist. Create it first, or grant an existing path explicitly; a missing target never opens its parent folder.`,
    );
  const real = canonical(raw);
  if (real === parse(real).root) throw new Error(`${label} is a filesystem root, which is never granted.`);
  if (contains(real, home))
    throw new Error(`${label} is, or contains, your home folder, which is never granted. Name a narrower path.`);
  if (contains(real, cwd))
    throw new Error(`${label} is, or contains, the project folder. The project is already available to the command.`);
  if (contains(cwd, real))
    throw new Error(`${label} is already inside the project folder, where the sandbox's normal rules apply.`);
  if (ctx.sensitivePaths.some((path) => overlaps(real, canonical(path))))
    throw new Error(`${label} overlaps a sensitive system or application directory.`);
  if (writable && ctx.protectedPaths.some((path) => overlaps(real, path)))
    throw new Error(`${label} overlaps protected Git metadata or project configuration, which stays read-only.`);
  return real;
}

// The canonical grants for a request, or an Error saying which entry cannot be granted. Overlaps collapse: a read
// grant inside another grant adds nothing, and a path granted both ways is write-only.
export function resolvePathGrants(access: GrantRequest, ctx: GrantContext): PathGrants {
  const readPaths = access.readPaths ?? [];
  const writePaths = access.writePaths ?? [];
  if (readPaths.length > MAX_GRANT_PATHS || writePaths.length > MAX_GRANT_PATHS)
    throw new Error(`At most ${MAX_GRANT_PATHS} read_paths and ${MAX_GRANT_PATHS} write_paths per command.`);
  const cwd = canonical(ctx.cwd);
  const home = canonical(ctx.home);
  const write = unique(writePaths.map((path) => resolveOne(path, true, ctx, cwd, home)));
  const read = unique(readPaths.map((path) => resolveOne(path, false, ctx, cwd, home)));
  const outermost = (paths: string[]) =>
    paths.filter((path, index) => !paths.some((other, i) => i !== index && contains(other, path)));
  const writeOnly = outermost(write);
  const readOnly = outermost(read).filter((path) => !writeOnly.some((other) => contains(other, path)));
  return { read: readOnly.sort(), write: writeOnly.sort() };
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = fold(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function emptyGrants(): PathGrants {
  return { read: [], write: [] };
}

export function hasResolvedGrants(grants: PathGrants | undefined): boolean {
  return Boolean(grants && (grants.read.length > 0 || grants.write.length > 0));
}

// What the approval is bound to: the exact canonical set, compared again when the command starts.
export function grantsKey(grants: PathGrants): string {
  return JSON.stringify([grants.read.map(fold), grants.write.map(fold)]);
}

// Lines for the approval card. Each path includes everything inside it; nothing else is opened.
export function describeGrants(grants: PathGrants): string {
  const lines: string[] = [];
  if (grants.read.length > 0) lines.push(`Read-only access to: ${grants.read.join(', ')}.`);
  if (grants.write.length > 0) lines.push(`Read and write access to: ${grants.write.join(', ')}.`);
  if (lines.length === 0) return '';
  return `Extra access for this one command and the processes it starts (everything inside each path, nothing else): ${lines.join(' ')} Network access is unchanged.`;
}
