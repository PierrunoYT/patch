export class SerialTaskQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.#tail.then(async () => {
      if (signal?.aborted) throw signal.reason ?? new Error("Task cancelled");
      return task();
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async idle(): Promise<void> {
    await this.#tail;
  }
}
