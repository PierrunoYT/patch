import { createTwoFilesPatch } from 'diff';
import type { SelfReviewMode } from '@shared/settings';

// A file the turn changed: its project-relative path and the bytes it had before the turn's first change to it (null
// when the turn created it).
export interface TurnChange {
  path: string;
  before: Buffer | null;
}

// What the reviewer answers when it finds nothing to fix.
export const REVIEW_CLEAN = 'NO_PROBLEMS';

// The self-review runs at most once per message, and only when the setting asks for it: always, or when the turn
// changed two or more files.
export function shouldSelfReview(mode: SelfReviewMode, changedFiles: number): boolean {
  if (mode === 'off') return false;
  return mode === 'always' ? changedFiles > 0 : changedFiles > 1;
}

// True when the reviewer found something to fix. Anything but the clean marker counts, so an unclear answer is handed
// to the main agent rather than dropped.
export function reviewFoundProblems(answer: string): boolean {
  const text = answer.trim();
  return text !== '' && !text.toUpperCase().startsWith(REVIEW_CLEAN);
}

// The message that goes back to the main agent when the review found problems.
export function reviewFollowUp(answer: string): string {
  return `A read-only reviewer compared your changes with my request and found these problems. Fix the ones that are real, and say briefly what you changed or why you disagree. Do not ask for another review.\n\n${answer.trim()}`;
}

const MAX_DIFF_CHARS = 60_000;

// The turn's changes as unified diffs against what the files were before. `readCurrent` returns the file now, or null
// when it no longer exists (deleted, or moved by apply_patch).
export function describeChanges(changes: TurnChange[], readCurrent: (path: string) => Buffer | null): string {
  const parts: string[] = [];
  let used = 0;
  for (const change of changes) {
    const after = readCurrent(change.path);
    let text: string;
    if (change.before?.includes(0) || after?.includes(0)) {
      text = `${change.path}: binary file changed`;
    } else {
      text = createTwoFilesPatch(
        `a/${change.path}`,
        `b/${change.path}`,
        change.before?.toString('utf8') ?? '',
        after?.toString('utf8') ?? '',
        change.before ? '' : '(new file)',
        after ? '' : '(deleted)',
        { context: 3 },
      );
    }
    if (used + text.length > MAX_DIFF_CHARS) {
      parts.push(`${change.path}: changed (diff left out, it is too long; read the file)`);
      continue;
    }
    used += text.length;
    parts.push(text);
  }
  return parts.join('\n');
}

export function buildReviewPrompt(request: string, diffs: string): string {
  return `# The user's request\n${request.trim() || '(no text)'}\n\n# The changes made for it\n${diffs}\n\nReview these changes against the request and the project's conventions.`;
}

export const REVIEWER_PREAMBLE = `You are a code reviewer. Another agent just changed files for a user's request, and you check its work before it tells the user it is done.
- Compare the changes with the request and with the project's conventions (the project instructions and AGENTS.md in your prompt, if any). You can read files to confirm anything the diff does not show.
- Report concrete problems only: parts of the request that are missing, behavior that is wrong, changes unrelated to the request, leftover debug code, a change that breaks a check or convention the project states. No style opinions, no praise, no summary of the diff.
- For each problem give the file and line, what is wrong and what to do.
- You cannot change anything and you cannot run checks. Do not guess: leave out what you are not sure of.
- If you find no problems, answer with exactly ${REVIEW_CLEAN} and nothing else.`;
