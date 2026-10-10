import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Top-level project entries that an editor, agent, Git hook manager or CI service later reads or runs outside the
// sandbox, so sandboxed commands may not change them (#127). Each one is protected whole, like .git: protecting a
// file deeper inside would let a command rename the writable folder above it and put its own in its place. A legitimate
// change goes through the direct edit tools instead, which ask about the same paths even in Auto mode (guard.ts), except
// .github: workflow edits are routine, so the edit tools leave them to the normal approval rules.
const PROTECTED_CONFIG = new Set(
  [
    // Editor and agent settings: tasks, launch configurations, hooks and MCP servers that run when opened.
    '.agents',
    '.amp',
    '.claude',
    '.codex',
    '.continue',
    '.cursor',
    '.gemini',
    '.idea',
    '.kilo',
    '.kilocode',
    '.vscode',
    '.windsurf',
    '.zed',
    '.mcp.json',
    // Patch's own instructions and skills go into every new chat's system prompt (#236).
    '.patch',
    'AGENTS.md',
    'CLAUDE.md',
    // direnv runs .envrc on cd; Husky's hooks run on git commit; workflows run in CI with the repository's secrets.
    '.envrc',
    '.husky',
    '.github',
  ].map((name) => name.toLowerCase()),
);

export function isProtectedConfigName(name: string): boolean {
  return PROTECTED_CONFIG.has(name.toLowerCase());
}

// The protected entries that exist in the project root, matched without regard to case (Windows and macOS file
// systems are case-insensitive). Links are left out: the sandbox protects a path, and a link's target is protected
// only when it is itself one of these entries. An entry that does not exist yet cannot be mounted over or given an
// ACL, so it is not protected while the command runs: createdProtectedEntries finds it afterwards (#262).
export function protectedConfigPaths(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => isProtectedConfigName(entry.name) && (entry.isDirectory() || entry.isFile()))
    .map((entry) => join(root, entry.name));
}

// The lower-cased names of the protected entries in the project root, links included. Taken before a sandboxed
// command starts, so that what the command created can be told apart afterwards (#262).
export function protectedConfigSnapshot(root: string): Set<string> {
  try {
    return new Set(
      readdirSync(root)
        .filter((name) => isProtectedConfigName(name))
        .map((name) => name.toLowerCase()),
    );
  } catch {
    return new Set();
  }
}

// Protected entries in the project root that are absent from `before`. A sandbox cannot guard a path that does not
// exist yet, so a command can create one, or rename a folder into place. Returns the names as they are on disk.
export function createdProtectedEntries(root: string, before: Set<string>): string[] {
  try {
    return readdirSync(root).filter((name) => isProtectedConfigName(name) && !before.has(name.toLowerCase()));
  } catch {
    return [];
  }
}

// Removes what a command created in a protected place. Never follows a link. Returns the names it removed.
export function removeCreatedProtectedEntries(root: string, names: string[]): string[] {
  const removed: string[] = [];
  for (const name of names) {
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Left out of the result, so the caller reports it as still there.
    }
  }
  return removed;
}
