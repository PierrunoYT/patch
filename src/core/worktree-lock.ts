/**
 * Cross-session mutation serialization for one worktree.
 *
 * `SerialTaskQueue` orders the work of a single application session. Terminal,
 * watch, and local HTTP/SSE sessions are independent sessions that share one
 * checkout, so their mutation phases — checkpoint, apply, commit, lint, model
 * commands, test, and undo — must also be ordered against each other. Every
 * session created for the same resolved root acquires the same lock, so a
 * second session observes a completed mutation instead of interleaving with it.
 *
 * The lock is re-entrant per async context: a mutation region that acquires the
 * lock may call helpers that acquire it again without deadlocking.
 *
 * Scope: this serializes sessions inside one Node process. Separate `patch`
 * processes on one worktree remain ordered only by Git's own index lock, which
 * is an intentional and documented limit rather than a guarantee.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { SerialTaskQueue } from "./serial-queue.js";

const heldLocks = new AsyncLocalStorage<ReadonlySet<WorktreeMutationLock>>();

export class WorktreeMutationLock {
  readonly #queue = new SerialTaskQueue();

  /**
   * Run `task` with exclusive access to the worktree. Nested calls from within
   * a region that already holds this lock run immediately.
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const held = heldLocks.getStore();
    if (held?.has(this)) return task();
    const nested = new Set(held ?? []);
    nested.add(this);
    return this.#queue.run(() => heldLocks.run(nested, task), signal);
  }

  /** Resolve once every mutation region queued so far has settled. */
  async idle(): Promise<void> {
    await this.#queue.idle();
  }
}

const locks = new Map<string, WeakRef<WorktreeMutationLock>>();
const collectedLocks = new FinalizationRegistry<{
  root: string;
  reference: WeakRef<WorktreeMutationLock>;
}>(({ root, reference }) => {
  if (locks.get(root) === reference) locks.delete(root);
});

/**
 * The process-wide lock for `root`, which must already be a resolved real path
 * so two services opened through different symlinks share one lock.
 */
export function worktreeMutationLock(root: string): WorktreeMutationLock {
  const existing = locks.get(root)?.deref();
  if (existing !== undefined) return existing;
  const created = new WorktreeMutationLock();
  const reference = new WeakRef(created);
  locks.set(root, reference);
  collectedLocks.register(created, { root, reference });
  return created;
}
