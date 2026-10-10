import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeChangedFiles,
  describeGit,
  describeGitMove,
  fileStamps,
  MAX_WATCHED_FILES,
  type GitContext,
} from './project_context';

const repo = (overrides: Partial<GitContext> = {}): GitContext => ({
  branch: 'main',
  detached: false,
  tracking: null,
  ahead: 0,
  behind: 0,
  head: 'abcdef1234567890',
  files: [],
  recent: [],
  ...overrides,
});

describe('describeGit', () => {
  it('names the branch, the upstream with ahead/behind counts, changed files and recent commits', () => {
    const text = describeGit(
      repo({
        tracking: 'origin/main',
        ahead: 2,
        behind: 1,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'untracked' },
        ],
        recent: ['feat: one', 'fix: two'],
      }),
    );
    expect(text).toBe(
      '[Git, as the chat starts: on main, tracking origin/main (2 ahead, 1 behind).\n' +
        'Uncommitted changes: a.ts (modified), b.ts (untracked).\n' +
        'Recent commits:\n- feat: one\n- fix: two]\n\n',
    );
  });

  it('leaves out ahead/behind when in sync, and says when nothing is uncommitted', () => {
    const text = describeGit(repo({ tracking: 'origin/main' }));
    expect(text).toContain('on main, tracking origin/main.');
    expect(text).toContain('No uncommitted changes.');
    expect(text).not.toContain('Recent commits');
  });

  it('describes a detached HEAD by its short commit', () => {
    expect(describeGit(repo({ branch: null, detached: true }))).toContain('on a detached HEAD at abcdef1.');
  });

  it('lists at most 20 changed files and counts the rest', () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.ts`, status: 'modified' as const }));
    const text = describeGit(repo({ files }));
    expect(text).toContain('f19.ts (modified), and 5 more.');
    expect(text).not.toContain('f20.ts');
  });
});

describe('describeGitMove', () => {
  it('reports a branch switch', () => {
    expect(describeGitMove({ branch: 'main', head: 'a' }, { branch: 'feature/x', head: 'b' })).toBe(
      'The branch changed from main to feature/x.',
    );
    expect(describeGitMove({ branch: 'main', head: 'a' }, { branch: null, head: 'a' })).toContain('to a detached HEAD');
  });

  it('reports a new HEAD on the same branch, including the first commit', () => {
    expect(describeGitMove({ branch: 'main', head: '1111111aaa' }, { branch: 'main', head: '2222222bbb' })).toBe(
      'HEAD moved from 1111111 to 2222222 (a commit, pull, reset or rebase outside this chat).',
    );
    expect(describeGitMove({ branch: 'main', head: null }, { branch: 'main', head: '2222222bbb' })).toMatch(
      /^HEAD moved to 2222222/,
    );
  });

  it('says nothing when the branch and HEAD stayed', () => {
    expect(describeGitMove({ branch: 'main', head: 'a' }, { branch: 'main', head: 'a' })).toBeNull();
  });
});

describe('fileStamps and describeChangedFiles', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports files changed or deleted since the stamps were taken, relative to the project', async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-context-'));
    const [a, b, c] = ['a.ts', 'b.ts', 'c.ts'].map((name) => join(root, name)) as [string, string, string];
    for (const path of [a, b, c]) writeFileSync(path, 'one');
    const before = await fileStamps([a, b, c]);

    writeFileSync(a, 'changed content');
    rmSync(b);
    const after = await fileStamps([a, b, c]);
    expect(after.get(b)).toBe('-');

    expect(describeChangedFiles(before, after, new Set([a, b, c]), root)).toBe(
      'Changed outside this chat since your last turn: a.ts (modified), b.ts (deleted). ' +
        'Read a file again before relying on what you read earlier.',
    );
  });

  it('skips files no longer counted as read and files without an earlier stamp', () => {
    const before = new Map([['/p/a.ts', '1:1']]);
    const after = new Map([
      ['/p/a.ts', '2:2'],
      ['/p/new.ts', '3:3'],
    ]);
    expect(describeChangedFiles(before, after, new Set(['/p/new.ts']), '/p')).toBeNull();
  });

  it('keeps the absolute path for a file outside the project', () => {
    root = mkdtempSync(join(tmpdir(), 'cc-context-'));
    const outside = join(tmpdir(), 'elsewhere.ts');
    const note = describeChangedFiles(
      new Map([[outside, '1:1']]),
      new Map([[outside, '2:2']]),
      new Set([outside]),
      root,
    );
    expect(note).toContain(outside);
  });

  it('stamps only the most recently read files', async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-context-'));
    const paths = Array.from({ length: MAX_WATCHED_FILES + 5 }, (_, i) => join(root, `missing-${i}`));
    const stamps = await fileStamps(paths);
    expect(stamps.size).toBe(MAX_WATCHED_FILES);
    expect(stamps.has(paths[0]!)).toBe(false);
    expect(stamps.has(paths.at(-1)!)).toBe(true);
  });
});
