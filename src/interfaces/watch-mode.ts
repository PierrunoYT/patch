/**
 * Watch behavior adapted from aider/watch.py and aider/watch_prompts.py at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for bounded reads, safe paths, debounce, cancellation, and a shared
 * serialized session queue.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { SerialTaskQueue } from "../core/serial-queue.js";
import { SafePathResolver } from "../io/safe-path.js";

const markerPattern = /(?:#|\/\/|--|;+)\s*(?:ai\b.*|.*\bai[?!]?)\s*$/iu;
const alwaysIgnored = [
  /^\.git(?:\/|$)/u,
  /^\.aider/u,
  /(?:^|\/)node_modules(?:\/|$)/u,
  /(?:^|\/)vendor(?:\/|$)/u,
  /(?:^|\/)\.vscode(?:\/|$)/u,
  /(?:^|\/)\.idea(?:\/|$)/u,
  /(?:^|\/)(?:\.env|\.DS_Store|Thumbs\.db)$/u,
  /(?:~|\.(?:bak|sw[op]|tmp|temp|orig|pyc|log|svg|pdf))$/u,
];

export type WatchAction = "edit" | "ask";

export interface WatchComment {
  readonly line: number;
  readonly text: string;
}

export interface WatchRequest {
  readonly action: WatchAction;
  readonly paths: readonly string[];
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface WatchModeOptions {
  readonly root: string;
  readonly submit: (request: WatchRequest) => Promise<void>;
  readonly queue?: SerialTaskQueue;
  readonly isIgnored?: (path: string) => boolean | Promise<boolean>;
  readonly maxFileBytes?: number;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
}

export function parseWatchComments(content: string): {
  comments: readonly WatchComment[];
  action?: WatchAction;
} {
  const comments: WatchComment[] = [];
  let action: WatchAction | undefined;
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const match = markerPattern.exec(line);
    if (match === null) continue;
    const text = match[0].trim();
    comments.push({ line: index + 1, text });
    const normalized = text
      .toLowerCase()
      .replace(/^[/#;\s-]+/u, "")
      .trim();
    if (normalized.startsWith("ai!") || normalized.endsWith("ai!")) {
      action = "edit";
    } else if (
      action === undefined &&
      (normalized.startsWith("ai?") || normalized.endsWith("ai?"))
    ) {
      action = "ask";
    }
  }
  return action === undefined ? { comments } : { comments, action };
}

function defaultIgnored(path: string): boolean {
  return alwaysIgnored.some((pattern) => pattern.test(path));
}

export class AiWatchMode {
  readonly #options: WatchModeOptions;
  readonly #queue: SerialTaskQueue;
  readonly #controller = new AbortController();
  #paths = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #resolver: SafePathResolver | undefined;

  constructor(options: WatchModeOptions) {
    this.#options = options;
    this.#queue = options.queue ?? new SerialTaskQueue();
    options.signal?.addEventListener("abort", () => this.close(), {
      once: true,
    });
  }

  async start(): Promise<void> {
    if (this.#watcher !== undefined)
      throw new Error("Watch mode is already started");
    this.#resolver = await SafePathResolver.create(this.#options.root);
    this.#watcher = watch(
      this.#resolver.root,
      { recursive: true },
      (_event, filename) => {
        if (filename !== null) this.notify(String(filename));
      },
    );
    this.#watcher.on("error", () => this.close());
  }

  notify(path: string): void {
    if (this.#controller.signal.aborted) return;
    this.#paths.add(path);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const paths = [...this.#paths];
      this.#paths.clear();
      void this.#queue
        .run(() => this.#process(paths), this.#controller.signal)
        .catch(() => undefined);
    }, this.#options.debounceMs ?? 100);
  }

  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      const paths = [...this.#paths];
      this.#paths.clear();
      await this.#queue.run(
        () => this.#process(paths),
        this.#controller.signal,
      );
    }
    await this.#queue.idle();
  }

  close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#paths.clear();
    this.#controller.abort(new Error("Watch mode stopped"));
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  async #process(changedPaths: readonly string[]): Promise<void> {
    const resolver =
      this.#resolver ?? (await SafePathResolver.create(this.#options.root));
    const selected: Array<{
      path: string;
      comments: readonly WatchComment[];
      action: WatchAction;
    }> = [];
    for (const changedPath of [...new Set(changedPaths)].sort()) {
      let absolute: string;
      try {
        absolute = await resolver.resolve(changedPath);
      } catch {
        continue;
      }
      const path = relative(resolver.root, absolute).split(sep).join("/");
      if (
        path === "" ||
        defaultIgnored(path) ||
        (await this.#options.isIgnored?.(path))
      )
        continue;
      try {
        const metadata = await stat(absolute);
        if (
          !metadata.isFile() ||
          metadata.size > (this.#options.maxFileBytes ?? 1024 * 1024)
        )
          continue;
        const parsed = parseWatchComments(await readFile(absolute, "utf8"));
        if (parsed.action !== undefined)
          selected.push({
            path,
            comments: parsed.comments,
            action: parsed.action,
          });
      } catch {
        continue;
      }
    }
    if (selected.length === 0 || this.#controller.signal.aborted) return;
    const action = selected.some((item) => item.action === "edit")
      ? "edit"
      : "ask";
    const intro =
      action === "edit"
        ? "Follow the AI comments below, then remove those comments."
        : "Answer the questions in the AI comments below without editing files.";
    const prompt = [
      intro,
      ...selected.map(
        ({ path, comments }) =>
          `${path}:\n${comments.map(({ line, text }) => `  Line ${line}: ${text}`).join("\n")}`,
      ),
    ].join("\n\n");
    await this.#options.submit({
      action,
      paths: selected.map(({ path }) => path),
      prompt,
      signal: this.#controller.signal,
    });
  }
}
