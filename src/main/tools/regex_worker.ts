import { Worker } from 'node:worker_threads';

// Regular expressions the model writes (grep patterns, glob patterns) run here, off the main process. A pattern that
// backtracks catastrophically, such as (a+)+b, would otherwise block the event loop: the whole app freezes, and Stop
// cannot interrupt it because Stop needs the same event loop. A worker can be terminated instead (#122).

// Plain JavaScript evaluated by the worker, so the build needs no separate worker entry.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', ({ id, text, items, take }) => {
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

export type MatchResult =
  // Indexes of the matching lines or items, at most `take`, and whether another one matched after them.
  | { status: 'done'; found: number[]; more: boolean }
  // The pattern ran longer than the time limit; the worker was terminated and cannot be used again.
  | { status: 'timeout' }
  | { status: 'aborted' };

export class RegexWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private closed = false;

  // The pattern must already be known to compile (callers build a RegExp first to report syntax errors).
  constructor(source: string, flags: string) {
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { source, flags } });
    // Errors surface as a failed match below; an unhandled 'error' event would crash the main process.
    this.worker.on('error', () => {});
  }

  // Tests each line of `text`, or each entry of `items`. Without `take`, every match is returned.
  match(
    input: { text: string } | { items: string[] },
    options: { take?: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<MatchResult> {
    if (this.closed) return Promise.resolve({ status: 'aborted' });
    if (options.signal?.aborted) {
      this.close();
      return Promise.resolve({ status: 'aborted' });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (result: MatchResult | Error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.worker.off('message', onMessage);
        this.worker.off('error', onError);
        this.worker.off('exit', onExit);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onMessage = (message: { id: number; found: number[]; more: boolean }) => {
        if (message.id === id) finish({ status: 'done', found: message.found, more: message.more });
      };
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error('The search worker stopped unexpectedly.'));
      const onAbort = () => {
        this.close();
        finish({ status: 'aborted' });
      };
      const timer = setTimeout(() => {
        this.close();
        finish({ status: 'timeout' });
      }, options.timeoutMs);
      this.worker.on('message', onMessage);
      this.worker.on('error', onError);
      this.worker.on('exit', onExit);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.worker.postMessage({ id, take: options.take ?? Number.POSITIVE_INFINITY, ...input });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.worker.terminate();
  }
}
