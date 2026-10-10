import { stat } from 'node:fs/promises';
import { appLog, type AppLog } from './app_log';

// Records in the local log when the main process stops making progress, for stalls that cannot be reproduced on
// demand (#138): timers that fire late because the event loop was blocked, and a small file system call that does not
// finish because the thread pool behind fs.promises (also used by DNS lookups) is busy or the disk does not answer.
// The log is written synchronously, so an entry gets out even while the thread pool is stuck. Numbers only.
export interface StallMonitorOptions {
  // A folder to stat; the user data folder, where chats are saved.
  probePath: string;
  intervalMs?: number;
  stallMs?: number;
  log?: Pick<AppLog, 'warn'>;
  probe?: (path: string) => Promise<unknown>;
  now?: () => number;
}

export function startStallMonitor(options: StallMonitorOptions): () => void {
  const { probePath, intervalMs = 5_000, stallMs = 2_000, log = appLog, probe = stat, now = Date.now } = options;
  let expected = now() + intervalMs;
  // The probe still running: when it started and whether it was already reported as stalled.
  let pending: { startedAt: number; reported: boolean } | null = null;
  const timer = setInterval(() => {
    const time = now();
    const late = time - expected;
    expected = time + intervalMs;
    if (late > stallMs) log.warn('main', 'The event loop was blocked.', { ms: late });
    if (pending) {
      const waited = time - pending.startedAt;
      if (!pending.reported && waited > stallMs) {
        pending.reported = true;
        log.warn('main', 'File system calls are stalled.', { ms: waited });
      }
      return;
    }
    const current = { startedAt: time, reported: false };
    pending = current;
    const settled = () => {
      const took = now() - current.startedAt;
      // A stall reported while it lasted also gets its end, so the log shows how long it was.
      if (current.reported || took > stallMs) log.warn('main', 'File system calls were delayed.', { ms: took });
      pending = null;
    };
    probe(probePath).then(settled, settled);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
