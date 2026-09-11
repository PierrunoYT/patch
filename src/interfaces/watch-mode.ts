/**
 * Watch behavior adapted from aider/watch.py and aider/watch_prompts.py at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with bounded reads, safe paths, debounce, cancellation, and a shared
 * serialized session queue.
 * Licensed under the Apache License, Version 2.0.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { SerialTaskQueue } from "../core/serial-queue.js";
import type {
  ApplicationEvent,
  ApplicationSession,
} from "../core/application-service.js";
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
  readonly submit?: (request: WatchRequest) => Promise<void>;
  readonly session?: ApplicationSession;
  readonly queue?: SerialTaskQueue;
  readonly isIgnored?: (path: string) => boolean | Promise<boolean>;
  readonly maxFileBytes?: number;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
  readonly emit?: (event: ApplicationEvent) => void;
  /**
   * Paths already in the chat. A triggered turn refreshes their AI comments too,
   * so a comment written earlier in another selected file is not lost because
   * only one file changed.
   */
  readonly selectedPaths?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * Reports a failure watch mode cannot act on. Watching runs behind the input
   * loop, so without this a failed turn or a dead native watcher is invisible.
   */
  readonly onError?: (error: unknown, source: WatchErrorSource) => void;
}

export type WatchErrorSource = "watcher" | "submit";

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
  readonly #queue: SerialTaskQueue | undefined;
  readonly #controller = new AbortController();
  readonly #onAbort = () => this.close();
  #paths = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #resolver: SafePathResolver | undefined;

  constructor(options: WatchModeOptions) {
    if (options.submit === undefined && options.session === undefined) {
      throw new Error(
        "Watch mode requires an application session or submit callback",
      );
    }
    this.#options = options;
    this.#queue =
      options.session === undefined
        ? (options.queue ?? new SerialTaskQueue())
        : undefined;
    options.signal?.addEventListener("abort", this.#onAbort, {
      once: true,
    });
    if (options.signal?.aborted) this.close();
  }

  async start(): Promise<void> {
    this.#controller.signal.throwIfAborted();
    if (this.#watcher !== undefined)
      throw new Error("Watch mode is already started");
    this.#resolver = await SafePathResolver.create(this.#options.root);
    this.#controller.signal.throwIfAborted();
    this.#watcher = watch(
      this.#resolver.root,
      { recursive: true },
      (_event, filename) => {
        if (filename !== null) this.notify(String(filename));
      },
    );
    this.#watcher.on("error", (error: unknown) => {
      this.#report(error, "watcher");
      this.close();
    });
  }

  notify(path: string): void {
    if (this.#controller.signal.aborted) return;
    this.#paths.add(path);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const paths = [...this.#paths];
      this.#paths.clear();
      void (
        this.#queue === undefined
          ? this.#process(paths)
          : this.#queue.run(() => this.#process(paths), this.#controller.signal)
      ).catch((error: unknown) => this.#report(error, "submit"));
    }, this.#options.debounceMs ?? 100);
  }

  /** A reporter that throws must not take the watcher down with it. */
  #report(error: unknown, source: WatchErrorSource): void {
    if (this.#controller.signal.aborted && source === "submit") return;
    try {
      this.#options.onError?.(error, source);
    } catch {
      // The reporter is a display concern; watch mode keeps running without it.
    }
  }

  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      const paths = [...this.#paths];
      this.#paths.clear();
      if (this.#queue === undefined) await this.#process(paths);
      else
        await this.#queue.run(
          () => this.#process(paths),
          this.#controller.signal,
        );
    }
    await this.#queue?.idle();
  }

  close(): void {
    this.#options.signal?.removeEventListener("abort", this.#onAbort);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#paths.clear();
    this.#controller.abort(new Error("Watch mode stopped"));
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /**
   * Reads the AI comments in one path, or `undefined` when the path is ignored,
   * unreadable, too large, or not a file.
   */
  async #read(
    resolver: SafePathResolver,
    requested: string,
  ): Promise<
    | { path: string; comments: readonly WatchComment[]; action?: WatchAction }
    | undefined
  > {
    let absolute: string;
    try {
      absolute = await resolver.resolve(requested);
    } catch {
      return undefined;
    }
    const path = relative(resolver.root, absolute).split(sep).join("/");
    if (
      path === "" ||
      defaultIgnored(path) ||
      (await this.#options.isIgnored?.(path))
    )
      return undefined;
    try {
      const metadata = await stat(absolute);
      if (
        !metadata.isFile() ||
        metadata.size > (this.#options.maxFileBytes ?? 1024 * 1024)
      )
        return undefined;
      const parsed = parseWatchComments(await readFile(absolute, "utf8"));
      return { path, ...parsed };
    } catch {
      return undefined;
    }
  }

  async #process(changedPaths: readonly string[]): Promise<void> {
    const resolver =
      this.#resolver ?? (await SafePathResolver.create(this.#options.root));
    const triggering = new Map<string, WatchAction>();
    const selected: Array<{
      path: string;
      comments: readonly WatchComment[];
    }> = [];
    const seen = new Set<string>();
    for (const changedPath of [...new Set(changedPaths)].sort()) {
      const read = await this.#read(resolver, changedPath);
      if (read === undefined || read.action === undefined) continue;
      triggering.set(read.path, read.action);
      seen.add(read.path);
      selected.push({ path: read.path, comments: read.comments });
    }
    if (triggering.size === 0 || this.#controller.signal.aborted) return;
    // A trigger in one file runs a turn about every AI comment in the chat, so a
    // comment written earlier in another selected file is not silently dropped.
    for (const path of [
      ...new Set(await (this.#options.selectedPaths?.() ?? [])),
    ].sort()) {
      if (seen.has(path)) continue;
      const read = await this.#read(resolver, path);
      if (read === undefined || read.comments.length === 0) continue;
      seen.add(read.path);
      selected.push({ path: read.path, comments: read.comments });
    }
    if (this.#controller.signal.aborted) return;
    const action = [...triggering.values()].includes("edit") ? "edit" : "ask";
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
    if (this.#options.session !== undefined) {
      await this.#options.session.submit(prompt, {
        signal: this.#controller.signal,
        emit: this.#options.emit ?? (() => undefined),
        readOnly: action === "ask",
      });
    } else {
      await this.#options.submit?.({
        action,
        paths: selected.map(({ path }) => path),
        prompt,
        signal: this.#controller.signal,
      });
    }
  }
}
