import { afterEach, describe, expect, it } from 'vitest';
import { RegexWorker } from './regex_worker';

const CATASTROPHIC = `${'a'.repeat(10_000)}!`;

describe('RegexWorker', () => {
  const workers: RegexWorker[] = [];
  const start = (source: string, flags = '') => {
    const worker = new RegexWorker(source, flags);
    workers.push(worker);
    return worker;
  };
  afterEach(() => {
    for (const worker of workers.splice(0)) worker.close();
  });

  it('returns matching line indexes, at most `take`, and whether more matched', async () => {
    const worker = start('^hit');
    const text = ['hit 0', 'miss', 'hit 2', 'hit 3', 'HIT 4'].join('\r\n');
    expect(await worker.match({ text }, { timeoutMs: 2000 })).toEqual({
      status: 'done',
      found: [0, 2, 3],
      more: false,
    });
    expect(await worker.match({ text }, { take: 2, timeoutMs: 2000 })).toEqual({
      status: 'done',
      found: [0, 2],
      more: true,
    });
  });

  it('matches a list of items with the flags it was given', async () => {
    const worker = start('\\.ts$', 'i');
    expect(await worker.match({ items: ['a.ts', 'b.js', 'C.TS'] }, { timeoutMs: 2000 })).toEqual({
      status: 'done',
      found: [0, 2],
      more: false,
    });
  });

  it('terminates a catastrophically backtracking pattern at the time limit', async () => {
    const worker = start('(a+)+b');
    const started = Date.now();
    expect(await worker.match({ text: CATASTROPHIC }, { timeoutMs: 200 })).toEqual({ status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    // A terminated worker is not used again.
    expect(await worker.match({ text: 'aab' }, { timeoutMs: 200 })).toEqual({ status: 'aborted' });
  });

  it('stops at once when the signal aborts, including before it starts', async () => {
    const controller = new AbortController();
    const worker = start('(a+)+b');
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    expect(await worker.match({ text: CATASTROPHIC }, { timeoutMs: 30_000, signal: controller.signal })).toEqual({
      status: 'aborted',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await start('a').match({ text: 'a' }, { timeoutMs: 2000, signal: controller.signal })).toEqual({
      status: 'aborted',
    });
  });
});
