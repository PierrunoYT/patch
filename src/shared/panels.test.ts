import { describe, expect, it } from 'vitest';
import {
  AGENT_BROWSER_PARTITION,
  allowsWebviewAttach,
  diffHunks,
  parseNumstat,
  USER_BROWSER_PARTITION,
} from './panels';

describe('git diff parsing', () => {
  it('reads numstat counts, summing repeated paths and skipping binary files', () => {
    const counts = parseNumstat('3\t1\tsrc/a.ts\r\n-\t-\timage.png\n2\t0\tsrc/a.ts\n0\t5\tgone.txt\n');
    expect(Object.fromEntries(counts)).toEqual({
      'src/a.ts': { added: 5, removed: 1 },
      'gone.txt': { added: 0, removed: 5 },
    });
  });

  it('splits a diff into hunks per file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '@@ -10 +10 @@',
      '--- a removed line',
      '+++ an added line',
      '===================================================================',
      '--- /dev/null',
      '+++ b/new.txt\t',
      '@@ -0,0 +1 @@',
      '+hello',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(diffHunks(diff)).toEqual([
      { file: 'src/a.ts', header: '@@ -1,2 +1,2 @@', lines: [' keep', '-old', '+new'] },
      { file: 'src/a.ts', header: '@@ -10 +10 @@', lines: ['--- a removed line', '+++ an added line'] },
      { file: 'new.txt', header: '@@ -0,0 +1 @@', lines: ['+hello'] },
    ]);
  });
});

describe('browser panel sessions', () => {
  it('keeps the agent in its own session that is never written to disk', () => {
    expect(AGENT_BROWSER_PARTITION).not.toBe(USER_BROWSER_PARTITION);
    // Electron persists a partition only when its name starts with "persist:".
    expect(AGENT_BROWSER_PARTITION.startsWith('persist:')).toBe(false);
    expect(USER_BROWSER_PARTITION).toBe('persist:browser');
  });

  it('attaches webviews only in the two browser sessions', () => {
    expect(allowsWebviewAttach(USER_BROWSER_PARTITION, 'about:blank')).toBe(true);
    expect(allowsWebviewAttach(AGENT_BROWSER_PARTITION, 'about:blank')).toBe(true);
    expect(allowsWebviewAttach(AGENT_BROWSER_PARTITION, undefined)).toBe(true);
    for (const partition of [undefined, '', 'other', 'persist:other', 'persist:agent-browser']) {
      expect(allowsWebviewAttach(partition, 'about:blank')).toBe(false);
    }
  });

  it('attaches a guest only to about:blank or a web page', () => {
    expect(allowsWebviewAttach(AGENT_BROWSER_PARTITION, 'https://example.test/')).toBe(true);
    expect(allowsWebviewAttach(AGENT_BROWSER_PARTITION, 'file:///etc/passwd')).toBe(false);
    expect(allowsWebviewAttach(USER_BROWSER_PARTITION, 'javascript:alert(1)')).toBe(false);
  });
});
