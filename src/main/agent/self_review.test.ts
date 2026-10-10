import { describe, expect, it } from 'vitest';
import { describeChanges, reviewFollowUp, reviewFoundProblems, shouldSelfReview } from './self_review';

describe('self-review helpers', () => {
  it('decides from the mode and the number of changed files', () => {
    expect(shouldSelfReview('off', 5)).toBe(false);
    expect(shouldSelfReview('always', 0)).toBe(false);
    expect(shouldSelfReview('always', 1)).toBe(true);
    expect(shouldSelfReview('multi-file', 1)).toBe(false);
    expect(shouldSelfReview('multi-file', 2)).toBe(true);
  });

  it('treats only the clean marker as no problems', () => {
    expect(reviewFoundProblems('NO_PROBLEMS')).toBe(false);
    expect(reviewFoundProblems('  no_problems\n')).toBe(false);
    expect(reviewFoundProblems('a.ts:1 wrong')).toBe(true);
    expect(reviewFoundProblems('')).toBe(false);
    expect(reviewFollowUp(' x ')).toContain('\n\nx');
  });

  it('describes changes as diffs, with new, deleted and binary files', () => {
    const files: Record<string, Buffer | null> = {
      'a.ts': Buffer.from('one\ntwo\n'),
      'new.ts': Buffer.from('fresh\n'),
      'gone.ts': null,
      'img.png': Buffer.from([1, 0, 2]),
    };
    const text = describeChanges(
      [
        { path: 'a.ts', before: Buffer.from('one\n') },
        { path: 'new.ts', before: null },
        { path: 'gone.ts', before: Buffer.from('bye\n') },
        { path: 'img.png', before: Buffer.from([1]) },
      ],
      (path) => files[path] ?? null,
    );
    expect(text).toContain('+two');
    expect(text).toContain('+fresh');
    expect(text).toContain('-bye');
    expect(text).toContain('img.png: binary file changed');
  });

  it('leaves out diffs past the size limit', () => {
    const big = Buffer.from('x\n'.repeat(40_000));
    const text = describeChanges(
      [
        { path: 'big1.ts', before: null },
        { path: 'big2.ts', before: null },
      ],
      () => big,
    );
    expect(text).toContain('big2.ts: changed (diff left out');
  });
});
