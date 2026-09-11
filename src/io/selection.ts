/**
 * Selection expansion adapted from aider/commands.py `cmd_add`/`cmd_read_only` at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch so a directory or glob widens a selection only inside the
 * resolved root, never follows a symlink out of it, and is bounded rather than
 * unlimited.
 * Licensed under the Apache License, Version 2.0.
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { isMissingPathError, type SafePathResolver } from "./safe-path.js";

/** Selecting more files than this is refused rather than silently accepted. */
export const DEFAULT_SELECTION_LIMIT = 200;
/** Directory entries one expansion may look at before it gives up. */
export const DEFAULT_VISIT_LIMIT = 20_000;

export interface ExpandSelectionOptions {
  /**
   * Drops paths the repository ignores. Applied to expanded matches only: a
   * single named path stays the caller's business, so an ignored file named
   * outright is still reported rather than silently disappearing.
   */
  readonly filterIgnored?: (
    paths: readonly string[],
  ) => Promise<readonly string[]>;
  readonly limit?: number;
  readonly visitLimit?: number;
}

export class SelectionTooLargeError extends Error {
  override readonly name = "SelectionTooLargeError";
}

/** True when the pattern asks to match rather than name one path. */
export function isGlobPattern(pattern: string): boolean {
  return /[*?[]/u.test(pattern);
}

function escapeLiteral(character: string): string {
  return /[\\^$.|+()/{}]/u.test(character) ? `\\${character}` : character;
}

/**
 * Translates a glob to an anchored expression over `/`-separated paths. `*` and
 * `?` stay inside one segment, `**` crosses segments, and `[...]` is a character
 * class; an unterminated class is a literal bracket.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 2;
        if (pattern[index] === "/") {
          index += 1;
          // `**/` also matches no directory at all, as git's pathspecs do.
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
        continue;
      }
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 2);
      if (end === -1) {
        source += "\\[";
      } else {
        const body = pattern.slice(index + 1, end);
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end + 1;
        continue;
      }
    } else {
      source += escapeLiteral(character);
    }
    index += 1;
  }
  return new RegExp(`^${source}$`, "u");
}

function portable(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * Every regular file under `directory`, repository-relative.
 *
 * Symbolic links are skipped rather than followed: a link is the one entry that
 * can leave the resolved root or loop, and a selection is meant to widen inside
 * the worktree. `.git` is skipped because its contents are never model context.
 */
async function walk(
  root: string,
  directory: string,
  budget: { remaining: number },
): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [directory];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        throw new SelectionTooLargeError(
          `Expanding ${portable(root, directory) || "the repository root"} reached the directory-entry limit; name a narrower path or pattern.`,
        );
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") pending.push(absolute);
      } else if (entry.isFile()) {
        found.push(portable(root, absolute));
      }
    }
  }
  return found.sort();
}

/** The leading path segments of a glob that contain no metacharacter. */
function staticPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (isGlobPattern(segment)) break;
    fixed.push(segment);
  }
  return fixed.join("/");
}

/**
 * Resolves each pattern to the repository-relative files it selects.
 *
 * A plain path stays exactly what the caller named, including one that does not
 * exist yet. A directory selects the files beneath it and a glob selects the
 * files it matches, both contained by the resolver, filtered by the repository's
 * ignore rules, and bounded by `limit`.
 */
export async function expandSelection(
  resolver: SafePathResolver,
  patterns: readonly string[],
  options: ExpandSelectionOptions = {},
): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_SELECTION_LIMIT;
  const budget = { remaining: options.visitLimit ?? DEFAULT_VISIT_LIMIT };
  const selected: string[] = [];
  const add = (path: string) => {
    if (!selected.includes(path)) selected.push(path);
  };

  for (const raw of patterns) {
    const pattern = raw.split(sep).join("/");
    if (isGlobPattern(pattern)) {
      if (isAbsolute(pattern)) {
        throw new Error(
          `Use a repository-relative pattern instead of an absolute one: ${raw}`,
        );
      }
      const prefix = staticPrefix(pattern);
      const base = await resolver.resolve(prefix === "" ? "." : prefix);
      const expression = globToRegExp(pattern);
      const matches = (await walk(resolver.root, base, budget)).filter((path) =>
        expression.test(path),
      );
      if (matches.length === 0) {
        throw new Error(`No file in the repository matches: ${raw}`);
      }
      for (const path of await visible(matches, raw, options)) add(path);
      continue;
    }

    const absolute = await resolver.resolve(pattern);
    const normalized = portable(resolver.root, absolute);
    let directory = normalized === "";
    if (!directory) {
      try {
        directory = (await stat(absolute)).isDirectory();
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    if (!directory) {
      add(normalized);
      continue;
    }
    const found = await walk(resolver.root, absolute, budget);
    if (found.length === 0) {
      throw new Error(
        `No file to select under: ${normalized === "" ? "the repository root" : raw}`,
      );
    }
    for (const path of await visible(found, raw, options)) add(path);
  }

  if (selected.length > limit) {
    throw new SelectionTooLargeError(
      `Selecting ${selected.length} files exceeds the ${limit}-file limit; name a narrower path or pattern.`,
    );
  }
  return selected;
}

/**
 * Ignored matches are dropped rather than refused, because an expansion sweeps
 * up whatever is there; an expansion that is entirely ignored says so instead of
 * reporting an empty selection as success.
 */
async function visible(
  paths: readonly string[],
  pattern: string,
  options: ExpandSelectionOptions,
): Promise<readonly string[]> {
  if (options.filterIgnored === undefined) return paths;
  const kept = new Set(await options.filterIgnored(paths));
  const remaining = paths.filter((path) => kept.has(path));
  if (remaining.length === 0) {
    throw new Error(
      `Every file selected by ${pattern} is ignored and cannot enter model context.`,
    );
  }
  return remaining;
}
