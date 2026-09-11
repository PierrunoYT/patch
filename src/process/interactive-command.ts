/**
 * Interactive command dispatch adapted from aider/run_cmd.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch so a PTY is used only when the user explicitly asks for one,
 * with the optional native dependency loaded at that point and child output still
 * passing through the shared sanitizer.
 * Licensed under the Apache License, Version 2.0.
 */

import type { Readable } from "node:stream";

import { runPtyCommand, type PtyInput, type PtyModule } from "./pty.js";

export interface InteractiveCommandResult {
  readonly status: "completed" | "cancelled";
  readonly exitCode: number;
  readonly output: string;
}

export interface InteractiveCommandOptions {
  readonly root: string;
  /** The raw terminal stream, already released by the line reader. */
  readonly input: Readable & { setRawMode?: (mode: boolean) => void };
  /** Receives sanitized child output as it arrives. */
  readonly write: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly columns?: number;
  readonly rows?: number;
  /** Subscribes to terminal resizes and returns the unsubscribe function. */
  readonly onResize?: (
    listener: (size: { columns: number; rows: number }) => void,
  ) => () => void;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly loadPty?: () => Promise<PtyModule>;
}

/**
 * The shell that interprets a command string, chosen the same way Node chooses
 * one for `spawn(..., { shell: true })`, so an interactive command and a captured
 * one are read by the same interpreter.
 */
export function interactiveShell(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): [string, string[]] {
  if (platform === "win32") {
    return [environment["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", command]];
  }
  return ["/bin/sh", ["-c", command]];
}

/** Queue between the terminal's data events and the PTY's input contract. */
class InputQueue implements AsyncIterable<PtyInput> {
  readonly #queue: PtyInput[] = [];
  #wake: (() => void) | undefined;
  #done = false;

  push(value: PtyInput): void {
    this.#queue.push(value);
    this.#wake?.();
    this.#wake = undefined;
  }

  end(): void {
    this.#done = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PtyInput> {
    while (true) {
      const next = this.#queue.shift();
      if (next !== undefined) yield next;
      else if (this.#done) return;
      else
        await new Promise<void>((done) => {
          this.#wake = done;
        });
    }
  }
}

/**
 * Runs one command under a PTY with the user's terminal attached.
 *
 * Keystrokes are forwarded verbatim, so the child's own line discipline decides
 * what Ctrl-C and Ctrl-D mean, and the caller is responsible for having released
 * the terminal first. Output is still sanitized: a child cannot repaint or
 * retitle the terminal, which is why full-screen programs are not usable here
 * and only prompts and line-oriented sessions are.
 */
export async function runInteractiveCommand(
  command: string,
  options: InteractiveCommandOptions,
): Promise<InteractiveCommandResult> {
  if (command.trim() === "") {
    throw new TypeError("An interactive command cannot be empty");
  }
  const environment = options.environment ?? process.env;
  const [file, args] = interactiveShell(
    command,
    options.platform ?? process.platform,
    environment,
  );
  const queue = new InputQueue();
  const onData = (chunk: Buffer | string) =>
    queue.push({
      type: "data",
      data: typeof chunk === "string" ? chunk : chunk.toString("utf8"),
    });
  const unsubscribe = options.onResize?.((size) =>
    queue.push({ type: "resize", ...size }),
  );
  options.input.setRawMode?.(true);
  options.input.on("data", onData);
  options.input.resume();
  try {
    const result = await runPtyCommand(file, args, {
      root: options.root,
      input: queue,
      onOutput: options.write,
      environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.columns === undefined ? {} : { columns: options.columns }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
      ...(options.loadPty === undefined ? {} : { loadPty: options.loadPty }),
    });
    return {
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
    };
  } finally {
    queue.end();
    unsubscribe?.();
    options.input.off("data", onData);
    options.input.pause();
    options.input.setRawMode?.(false);
  }
}
