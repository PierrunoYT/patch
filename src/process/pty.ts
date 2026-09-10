/**
 * PTY execution adapted from aider/run_cmd.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with optional node-pty loading, typed lifecycle input, and sanitized
 * output that cannot inject child-controlled terminal sequences.
 * Licensed under the Apache License, Version 2.0.
 */

import { realpath } from "node:fs/promises";

import { ControlSequenceSanitizer } from "../io/sanitize.js";

export type PtyInput =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "interrupt" }
  | { readonly type: "eof" }
  | {
      readonly type: "resize";
      readonly columns: number;
      readonly rows: number;
    };

interface Disposable {
  dispose(): void;
}

interface PtyProcess {
  onData(listener: (data: string) => void): Disposable;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      readonly name: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
    },
  ): PtyProcess;
}

export interface PtyCommandOptions {
  readonly root: string;
  readonly input?: AsyncIterable<PtyInput>;
  readonly signal?: AbortSignal;
  readonly columns?: number;
  readonly rows?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onOutput?: (text: string) => void;
  readonly loadPty?: () => Promise<PtyModule>;
}

export interface PtyCommandResult {
  readonly status: "completed" | "cancelled";
  readonly exitCode: number;
  readonly signal?: number;
  readonly output: string;
}

export class PtyUnavailableError extends Error {
  override readonly name = "PtyUnavailableError";
}

async function loadNodePty(): Promise<PtyModule> {
  try {
    const moduleName = "node-pty";
    return (await import(moduleName)) as PtyModule;
  } catch (error) {
    throw new PtyUnavailableError(
      "Interactive PTY support requires the optional node-pty package",
      { cause: error },
    );
  }
}

function dimension(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return selected;
}

export async function runPtyCommand(
  file: string,
  args: readonly string[],
  options: PtyCommandOptions,
): Promise<PtyCommandResult> {
  if (file.trim() === "") throw new TypeError("PTY executable cannot be empty");
  const columns = dimension(options.columns, 80, "columns");
  const rows = dimension(options.rows, 24, "rows");
  const root = await realpath(options.root);
  const module = await (options.loadPty ?? loadNodePty)();
  let pty: PtyProcess;
  try {
    pty = module.spawn(file, [...args], {
      name: "xterm-256color",
      cols: columns,
      rows,
      cwd: root,
      env: options.environment ?? process.env,
    });
  } catch (error) {
    throw new PtyUnavailableError("Unable to start an interactive PTY", {
      cause: error,
    });
  }

  return new Promise<PtyCommandResult>((resolve, reject) => {
    const sanitizer = new ControlSequenceSanitizer();
    let output = "";
    let cancelled = false;
    let inputError: unknown;
    const dataListener = pty.onData((data) => {
      const safe = sanitizer.write(data);
      output += safe;
      if (safe !== "") options.onOutput?.(safe);
    });
    const cancel = () => {
      cancelled = true;
      pty.kill();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const exitListener = pty.onExit((event) => {
      dataListener.dispose();
      exitListener.dispose();
      options.signal?.removeEventListener("abort", cancel);
      if (inputError !== undefined) reject(inputError);
      else
        resolve({
          status: cancelled ? "cancelled" : "completed",
          exitCode: event.exitCode,
          ...(event.signal === undefined ? {} : { signal: event.signal }),
          output,
        });
    });

    if (options.signal?.aborted) cancel();
    void (async () => {
      try {
        for await (const input of options.input ?? []) {
          if (cancelled) break;
          if (input.type === "data") pty.write(input.data);
          else if (input.type === "interrupt") pty.write("\u0003");
          else if (input.type === "eof")
            pty.write(process.platform === "win32" ? "\u001a" : "\u0004");
          else {
            pty.resize(
              dimension(input.columns, 80, "columns"),
              dimension(input.rows, 24, "rows"),
            );
          }
        }
      } catch (error) {
        inputError = error;
        pty.kill();
      }
    })();
  });
}
