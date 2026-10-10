import { stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { GitFile } from '@shared/panels';

// What a chat is told about the project's repository (#85), read with the Git panel's hardened Git.
export interface GitContext {
  branch: string | null;
  detached: boolean;
  tracking: string | null;
  ahead: number;
  behind: number;
  // The commit HEAD points to; null in a repository without commits.
  head: string | null;
  // The project's changed files, relative to the project folder.
  files: GitFile[];
  // Subjects of the last few commits, newest first.
  recent: string[];
}

export type GitHead = Pick<GitContext, 'branch' | 'head'>;

const MAX_FILES = 20;
// At most this many files the chat read are checked for outside changes before a message.
export const MAX_WATCHED_FILES = 200;

const short = (head: string) => head.slice(0, 7);

// The block added to a chat's first message. It goes into the message, not the system prompt, so the cached prompt
// prefix stays the same for every chat in the project.
export function describeGit(git: GitContext): string {
  const where = git.detached || !git.branch ? `a detached HEAD${git.head ? ` at ${short(git.head)}` : ''}` : git.branch;
  const upstream = git.tracking
    ? `, tracking ${git.tracking}${git.ahead || git.behind ? ` (${git.ahead} ahead, ${git.behind} behind)` : ''}`
    : '';
  const lines = [`Git, as the chat starts: on ${where}${upstream}.`];
  if (git.files.length === 0) lines.push('No uncommitted changes.');
  else {
    const listed = git.files.slice(0, MAX_FILES).map((file) => `${file.path} (${file.status})`);
    const more = git.files.length - listed.length;
    lines.push(`Uncommitted changes: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`);
  }
  if (git.recent.length > 0) lines.push(`Recent commits:\n${git.recent.map((subject) => `- ${subject}`).join('\n')}`);
  return `[${lines.join('\n')}]\n\n`;
}

// What moved in the repository between two looks at it: a branch switch, or new or rewritten commits on the same
// branch. Commits the agent made itself are not reported: the first look is taken after its run.
export function describeGitMove(before: GitHead, after: GitHead): string | null {
  if (before.branch !== after.branch) {
    const name = (branch: string | null) => branch ?? 'a detached HEAD';
    return `The branch changed from ${name(before.branch)} to ${name(after.branch)}.`;
  }
  if (before.head !== after.head && after.head) {
    return `HEAD moved${before.head ? ` from ${short(before.head)}` : ''} to ${short(after.head)} (a commit, pull, reset or rebase outside this chat).`;
  }
  return null;
}

// Size and modification time per file, '-' for one that is gone. Taken after each run for the files the chat read.
export async function fileStamps(paths: Iterable<string>): Promise<Map<string, string>> {
  const list = [...paths].slice(-MAX_WATCHED_FILES);
  const stamps = await Promise.all(
    list.map((path) =>
      stat(path).then(
        (info) => `${info.size}:${info.mtimeMs}`,
        () => '-',
      ),
    ),
  );
  return new Map(list.map((path, i) => [path, stamps[i]!]));
}

// The note about files the chat read that changed or disappeared since the last run ended, by the user, another
// program or a pull. `current` limits it to files the chat still counts as read (an undone edit is told separately).
export function describeChangedFiles(
  before: Map<string, string>,
  after: Map<string, string>,
  current: ReadonlySet<string>,
  root: string | null,
): string | null {
  const changed: string[] = [];
  for (const [path, stamp] of after) {
    const previous = before.get(path);
    if (previous === undefined || previous === stamp || !current.has(path)) continue;
    changed.push(`${display(path, root)} (${stamp === '-' ? 'deleted' : 'modified'})`);
  }
  if (changed.length === 0) return null;
  const listed = changed.slice(0, MAX_FILES);
  const more = changed.length - listed.length;
  return `Changed outside this chat since your last turn: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}. Read a file again before relying on what you read earlier.`;
}

function display(path: string, root: string | null): string {
  if (!root) return path;
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : path;
}
