import { describe, expect, it } from 'vitest';
import { findLeftovers, parseProcessRows, parsePsRows, processTree, type ProcessRow } from './shell_leftovers';

describe('processTree and parsePsRows (#117)', () => {
  it('reads ps output with its start times and walks a tree from its root', () => {
    const rows = parsePsRows(
      [
        '    1     0 Mon Oct  5 09:00:00 2026',
        '  100     1 Fri Oct  9 10:00:00 2026',
        '  200   100 Fri Oct  9 10:00:01 2026',
        '  300   200 Fri Oct  9 10:00:02 2026',
        '  400     1 Fri Oct  9 10:00:03 2026',
        'garbage',
      ].join('\n'),
    );
    expect(rows[2]).toEqual({ pid: 200, parent: 100, started: 'Fri Oct  9 10:00:01 2026' });
    expect(processTree(rows, 100).map((row) => row.pid)).toEqual([100, 200, 300]);
    expect(processTree(rows, 999)).toEqual([]);
    // The root has exited, but its children still name it as their parent (Windows).
    expect(processTree(rows.slice(2), 100).map((row) => row.pid)).toEqual([200, 300]);
  });

  it('stops at a cycle in the listing', () => {
    const rows = [
      { pid: 10, parent: 20, started: 'a' },
      { pid: 20, parent: 10, started: 'b' },
    ];
    expect(processTree(rows, 10).map((row) => row.pid)).toEqual([10, 20]);
  });
});

const lifetime = { startedAt: 10_000, endedAt: 20_000 };
const row = (pid: number, parent: number, created: number): ProcessRow => ({ pid, parent, created });

describe('findLeftovers (#165)', () => {
  it('finds the children of the exited shell and everything below them', () => {
    const rows = [row(100, 50, 9_000), row(200, 100, 11_000), row(201, 100, 12_000), row(300, 200, 13_000)];
    expect(findLeftovers(rows, 100, lifetime).sort()).toEqual([200, 201, 300]);
    expect(findLeftovers(rows, 100, lifetime)).not.toContain(100);
  });

  it('ignores a process that took the shell pid after the shell ended', () => {
    const rows = [row(100, 50, 25_000), row(200, 100, 26_000), row(300, 200, 27_000)];
    expect(findLeftovers(rows, 100, lifetime)).toEqual([]);
    // The shell's own child, created before it ended, still counts when an unrelated process took its number later.
    expect(findLeftovers([row(200, 100, 15_000), row(100, 50, 25_000)], 100, lifetime)).toEqual([200]);
  });

  it('ignores a grandchild that is older than its parent, since its parent number was reused', () => {
    const rows = [row(200, 100, 15_000), row(300, 200, 12_000)];
    expect(findLeftovers(rows, 100, lifetime)).toEqual([200]);
  });

  it('allows for a small difference between the clocks', () => {
    expect(findLeftovers([row(200, 100, 9_000)], 100, lifetime)).toEqual([200]);
    expect(findLeftovers([row(200, 100, 5_000)], 100, lifetime)).toEqual([]);
  });

  it('never returns system pids or the excluded ones, and handles a parent loop', () => {
    const rows = [row(4, 100, 11_000), row(200, 100, 12_000), row(300, 200, 13_000), row(200, 300, 14_000)];
    expect(findLeftovers(rows, 100, lifetime, [300])).toEqual([200]);
  });
});

describe('parseProcessRows', () => {
  it('reads pid,parent,created lines and skips anything else', () => {
    expect(parseProcessRows('1,0,5\r\nnoise\r\n 22,1,7 \n,,\n')).toEqual([row(1, 0, 5), row(22, 1, 7)]);
  });
});
