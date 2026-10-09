import { Worker } from 'node:worker_threads';

// Regular expressions the model writes (grep patterns, glob patterns) run here, off the main process. A pattern that
// backtracks catastrophically, such as (a+)+b, would otherwise block the event loop: the whole app freezes, and Stop
// cannot interrupt it because Stop needs the same event loop. A worker can be terminated instead (#122).

// Plain JavaScript evaluated by the worker, so the build needs no separate worker entry. Each message names its
// pattern, so one worker serves any number of grep and glob calls; the last pattern stays compiled.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let key = null;
let regex = null;
parentPort.on('message', ({ id, source, flags, text, items, take }) => {
  if (key !== flags + '/' + source) {
    regex = new RegExp(source, flags);
    key = flags + '/' + source;
  }
  const list = items ?? text.split(/\\r?\\n/);
  const found = [];
  let more = false;
  for (let index = 0; index < list.length; index++) {
    if (!regex.test(list[index])) continue;
    if (found.length < take) found.push(index);
    else {
      more = true;
      break;
    }
  }
  parentPort.postMessage({ id, found, more });
});
`;

// Starting a worker costs tens of milliseconds, and the model often sends several searches at once (#201). A worker
// that finished its search goes back here for the next one; one that timed out or was stopped is terminated instead.
const MAX_IDLE_WORKERS = 4;
const idle: Worker[] = [];

function takeWorker(): Worker {
  const reused = idle.pop();
  if (reused) {
    reused.ref();
    return reused;
  }
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  // Errors surface as a failed match below; an unhandled 'error' event would crash the main process.
  worker.on('error', () => {});
  // A worker that exits by itself (it should not) is never handed out again.
  worker.once('exit', () => {
    const index = idle.indexOf(worker);
    if (index >= 0) idle.splice(index, 1);
  });
  return worker;
}

function returnWorker(worker: Worker): void {
  if (idle.length >= MAX_IDLE_WORKERS) {
    void worker.terminate();
    return;
  }
  // Idle workers must not keep the app (or a test run) alive.
  worker.unref();
  idle.push(worker);
}

// For tests: how many finished workers wait for the next search.
export function idleRegexWorkers(): number {
  return idle.length;
}

export type MatchResult =
  // Indexes of the matching lines or items, at most `take`, and whether another one matched after them.
  | { status: 'done'; found: number[]; more: boolean }
  // The pattern ran longer than the time limit; the worker was terminated and cannot be used again.
  | { status: 'timeout' }
  | { status: 'aborted' };

// One search with one pattern, on a worker borrowed from the pool until close().
export class RegexWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private closed = false;

  // The pattern must already be known to compile (callers build a RegExp first to report syntax errors).
  constructor(
    private readonly source: string,
    private readonly flags: string,
  ) {}

  // Tests each line of `text`, or each entry of `items`. Without `take`, every match is returned.
  match(
    input: { text: string } | { items: string[] },
    options: { take?: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<MatchResult> {
    if (this.closed) return Promise.resolve({ status: 'aborted' });
    if (options.signal?.aborted) {
      this.terminate();
      return Promise.resolve({ status: 'aborted' });
    }
    const worker = (this.worker ??= takeWorker());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (result: MatchResult | Error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (result instanceof Error) {
          this.terminate();
          reject(result);
        } else {
          resolve(result);
        }
      };
      const onMessage = (message: { id: number; found: number[]; more: boolean }) => {
        if (message.id === id) finish({ status: 'done', found: message.found, more: message.more });
      };
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error('The search worker stopped unexpectedly.'));
      const onAbort = () => {
        this.terminate();
        finish({ status: 'aborted' });
      };
      const timer = setTimeout(() => {
        this.terminate();
        finish({ status: 'timeout' });
      }, options.timeoutMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({
        id,
        source: this.source,
        flags: this.flags,
        take: options.take ?? Number.POSITIVE_INFINITY,
        ...input,
      });
    });
  }

  // Ends the search and hands the worker back to the pool. Callers close only after their last match has settled.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) returnWorker(worker);
  }

  // A worker stuck in a pattern, or one whose search was stopped, cannot be trusted with the next search.
  private terminate(): void {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
  }
}
