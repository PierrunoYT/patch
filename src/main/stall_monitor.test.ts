import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStallMonitor } from './stall_monitor';

describe('startStallMonitor', () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  const setup = () => {
    const warn = vi.fn();
    const probes: Array<() => void> = [];
    stop = startStallMonitor({
      probePath: 'userData',
      log: { warn },
      probe: () => new Promise<void>((resolve) => probes.push(resolve)),
    });
    return { warn, probes };
  };

  it('logs nothing while file system calls finish quickly', async () => {
    const { warn, probes } = setup();
    for (let tick = 0; tick < 3; tick++) {
      await vi.advanceTimersByTimeAsync(5_000);
      probes.shift()?.();
      await Promise.resolve();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a file system call that does not finish, once, and then how long it took', async () => {
    const { warn, probes } = setup();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probes).toHaveLength(1);
    expect(warn.mock.calls).toEqual([['main', 'File system calls are stalled.', { ms: 5_000 }]]);
    await vi.advanceTimersByTimeAsync(1_000);
    probes[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenLastCalledWith('main', 'File system calls were delayed.', { ms: 11_000 });
  });

  it('reports timers that fire late because the event loop was blocked', async () => {
    const { warn } = setup();
    // A synchronous block: the clock moves on without the timer getting a turn.
    vi.setSystemTime(Date.now() + 8_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledWith('main', 'The event loop was blocked.', { ms: 8_000 });
  });
});
