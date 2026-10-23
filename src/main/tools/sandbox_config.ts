import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { appLog } from '../app_log';

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
    // Other hook managers and package managers, run on commit, install or CI (#283).
    '.pre-commit-config.yaml',
    'lefthook.yml',
    'lefthook.yaml',
    '.lefthook.yml',
    '.lefthook.yaml',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    // Other CI services.
    '.gitlab-ci.yml',
    '.circleci',
    'azure-pipelines.yml',
    'bitbucket-pipelines.yml',
    '.travis.yml',
    'Jenkinsfile',
    // A dev container's initializeCommand runs on the host; other agents read their own configuration.
    '.devcontainer',
    'GEMINI.md',
    '.cursorrules',
    '.windsurfrules',
    '.clinerules',
    '.roo',
    '.aider.conf.yml',
  ].map((name) => name.toLowerCase()),
);

export function isProtectedConfigName(name: string): boolean {
  const lower = name.toLowerCase();
  // Names with a variable part: a VS Code workspace file runs tasks when opened, .simple-git-hooks.* are Git hooks.
  return PROTECTED_CONFIG.has(lower) || lower.endsWith('.code-workspace') || lower.startsWith('.simple-git-hooks.');
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

// Protected top-level names that Patch's own edit tools wrote into, by project, with a sequence number (#276). An entry
// that appears while a sandboxed command runs may come from an approved edit rather than from the command; the guard
// then reports it instead of moving it away. Keys are the project root and the lower-cased name.
let writeSequence = 0;
const patchWrites = new Map<string, number>();
const writeKey = (root: string, name: string) => {
  const full = resolve(root);
  return `${process.platform === 'linux' ? full : full.toLowerCase()}\0${name.toLowerCase()}`;
};

// Called after the edit tools changed `path` (relative to the project root or absolute inside it).
export function notePatchWrite(root: string, path: string): void {
  const top = relative(root, resolve(root, path)).split(/[\\/]/)[0];
  if (top && isProtectedConfigName(top)) patchWrites.set(writeKey(root, top), ++writeSequence);
}

// A mark to pass to writtenByPatchSince: taken when a sandboxed command starts.
export function patchWriteMark(): number {
  return writeSequence;
}

export function writtenByPatchSince(root: string, name: string, mark: number): boolean {
  return (patchWrites.get(writeKey(root, name)) ?? 0) > mark;
}

// Moves what a command created in a protected place aside, to `<name>.patch-quarantine-<time>` in the project root,
// where no editor, agent or CI service reads it. Nothing is deleted: when the guard cannot tell who created an entry
// (the user, an editor or the command), the user can still move it back (#276). Never follows a link: a link is moved
// itself. Returns each name it moved with its new name.
export function quarantineCreatedProtectedEntries(root: string, names: string[]): Map<string, string> {
  const moved = new Map<string, string>();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const name of names) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const target = `${name}.patch-quarantine-${stamp}${attempt ? `-${attempt}` : ''}`;
      if (existsSync(join(root, target))) continue;
      try {
        renameSync(join(root, name), join(root, target));
        moved.set(name, target);
      } catch {
        // Left out of the result, so the caller reports it as still there.
      }
      break;
    }
  }
  return moved;
}

// After a sandboxed command ended: finds the protected entries it may have created (absent from `before`) and moves
// them aside when no other sandboxed command is running (`settled`). An entry Patch's edit tools wrote into since
// `mark` may be the user's approved edit rather than the command's, so it stays, with a note (#276). Returns the note
// for the command's output, or '' when nothing was created.
export function settleCreatedProtectedEntries(
  root: string,
  before: Set<string>,
  mark: number,
  settled: boolean,
): string {
  const created = createdProtectedEntries(root, before);
  if (created.length === 0) return '';
  const edited = created.filter((name) => writtenByPatchSince(root, name, mark));
  const others = created.filter((name) => !edited.includes(name));
  const moved = settled ? quarantineCreatedProtectedEntries(root, others) : new Map<string, string>();
  const left = others.filter((name) => !moved.has(name));
  appLog.warn('sandbox', 'A sandboxed command created protected project configuration.', {
    count: created.length,
    moved: moved.size,
    edited: edited.length,
  });
  const notes: string[] = [];
  if (moved.size > 0) {
    const list = [...moved].map(([name, target]) => `${name} to ${target}`).join(', ');
    notes.push(
      `[Patch moved ${list}: sandboxed commands may not create editor, agent or CI configuration. Use the edit tools for it.]`,
    );
  }
  if (left.length > 0) {
    const reason = settled ? 'it could not be moved aside' : 'another command is still running';
    notes.push(
      `[The command created ${left.join(', ')}, which sandboxed commands may not create. Patch left it in place because ${reason}: check it before using it.]`,
    );
  }
  if (edited.length > 0) {
    notes.push(
      `[${edited.join(', ')} appeared while the command ran, and the edit tools wrote to it too, so Patch left it in place: check it for files the command may have added.]`,
    );
  }
  return `\n${notes.join('\n')}`;
}
