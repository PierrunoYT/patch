/**
 * Shell integration behavior adapted from aider/args.py, aider/io.py, and
 * aider/commands.py at revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to keep desktop commands and clipboard utilities optional.
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn } from "node:child_process";

import { splitEditorCommand } from "./editor.js";

export type CompletionShell = "bash" | "zsh" | "fish";

export function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPIPE"
  );
}

/**
 * Prints a completion script for the options it is given.
 *
 * The inventory is a parameter rather than a list kept here, because a list kept
 * here drifts: it silently omitted several active options while claiming to
 * complete the executable. The caller passes the flags the parser actually
 * registered.
 */
export function generateShellCompletion(
  shell: CompletionShell,
  cliOptions: readonly string[],
): string {
  const unique = [...new Set(cliOptions)].filter((option) =>
    /^--[a-z0-9][a-z0-9-]*$/u.test(option),
  );
  if (unique.length === 0) {
    throw new Error("Shell completion needs at least one option to complete");
  }
  const options = unique.join(" ");
  if (shell === "bash") {
    return `_patch() { COMPREPLY=( $(compgen -W '${options}' -- "${"${COMP_WORDS[COMP_CWORD]}"}") ); }\ncomplete -F _patch patch\n`;
  }
  if (shell === "zsh") {
    return `#compdef patch\n_arguments '*:option:(${options})'\n`;
  }
  return unique
    .map((option) => `complete -c patch -l ${option.slice(2)}\n`)
    .join("");
}

export interface IntegrationResult {
  readonly stdout: string;
}

export interface IntegrationRunOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export type IntegrationRunner = (
  executable: string,
  args: readonly string[],
  input?: string,
  options?: IntegrationRunOptions,
) => Promise<IntegrationResult>;

const DEFAULT_INTEGRATION_TIMEOUT_MS = 10_000;
const DEFAULT_INTEGRATION_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_CLIPBOARD_MAX_BYTES = 1024 * 1024;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
}

function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export async function runIntegration(
  executable: string,
  args: readonly string[],
  input?: string,
  options: IntegrationRunOptions = {},
): Promise<IntegrationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRATION_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_INTEGRATION_MAX_OUTPUT_BYTES;
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(maxOutputBytes, "maxOutputBytes");
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => child.kill());
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
        forceKillTimer ??= setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // The integration process group already exited.
          }
        }, 1_000);
        forceKillTimer.unref();
      } catch {
        child.kill();
      }
    };
    const stop = (error: Error) => {
      if (failure !== undefined) return;
      failure = error;
      terminate();
    };
    const cancel = () =>
      stop(cancellationReason(options.signal as AbortSignal));
    const timer = setTimeout(
      () =>
        stop(new Error(`${executable} timed out after ${String(timeoutMs)}ms`)),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", cancel, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        output.push(captured);
        outputBytes += captured.length;
      }
      if (chunk.length > remaining)
        stop(
          new Error(
            `${executable} output exceeded ${String(maxOutputBytes)} bytes`,
          ),
        );
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      // Keep the unref'ed SIGKILL fallback armed after a forced stop: the
      // direct child can close while a descendant in its process group ignores
      // SIGTERM. Successful utilities need no fallback.
      if (failure === undefined && forceKillTimer !== undefined)
        clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      if (failure !== undefined) reject(failure);
      else if (code === 0)
        resolve({ stdout: Buffer.concat(output).toString("utf8") });
      else
        reject(new Error(`${executable} exited with status ${String(code)}`));
    });
    child.stdin.end(input);
  });
}

export async function notifyUser(
  options: { readonly command?: string } = {},
  dependencies: {
    readonly write?: (text: string) => void;
    readonly run?: IntegrationRunner;
  } = {},
): Promise<void> {
  if (options.command === undefined) {
    (dependencies.write ?? ((text) => process.stdout.write(text)))("\u0007");
    return;
  }
  const [executable, ...args] = splitEditorCommand(options.command);
  if (executable === undefined)
    throw new Error("Notification command cannot be empty");
  await (dependencies.run ?? runIntegration)(executable, args);
}

export class ClipboardUnavailableError extends Error {
  override readonly name = "ClipboardUnavailableError";
}

function clipboardCommand(
  operation: "read" | "write",
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): [string, string[]] {
  if (platform === "darwin")
    return [operation === "read" ? "pbpaste" : "pbcopy", []];
  if (platform === "win32") {
    return operation === "read"
      ? ["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]
      : ["clip.exe", []];
  }
  if (environment.WAYLAND_DISPLAY !== undefined) {
    return [operation === "read" ? "wl-paste" : "wl-copy", []];
  }
  return operation === "read"
    ? ["xclip", ["-selection", "clipboard", "-o"]]
    : ["xclip", ["-selection", "clipboard", "-i"]];
}

async function clipboard(
  operation: "read" | "write",
  text: string | undefined,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly run?: IntegrationRunner;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  },
): Promise<string> {
  const [executable, args] = clipboardCommand(
    operation,
    options.platform ?? process.platform,
    options.environment ?? process.env,
  );
  const maxBytes = options.maxBytes ?? DEFAULT_CLIPBOARD_MAX_BYTES;
  positiveInteger(maxBytes, "maxBytes");
  if (text !== undefined && Buffer.byteLength(text) > maxBytes)
    throw new ClipboardUnavailableError(
      `Clipboard text exceeds ${String(maxBytes)} bytes`,
    );
  try {
    const result = await (options.run ?? runIntegration)(
      executable,
      args,
      text,
      {
        maxOutputBytes: maxBytes,
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (Buffer.byteLength(result.stdout) > maxBytes)
      throw new Error(
        `${executable} output exceeded ${String(maxBytes)} bytes`,
      );
    return result.stdout;
  } catch (error) {
    if (options.signal?.aborted) throw cancellationReason(options.signal);
    throw new ClipboardUnavailableError(
      `Clipboard text requires the optional ${executable} system utility`,
      { cause: error },
    );
  }
}

export async function writeClipboardText(
  text: string,
  options: Parameters<typeof clipboard>[2] = {},
): Promise<void> {
  await clipboard("write", text, options);
}

export function readClipboardText(
  options: Parameters<typeof clipboard>[2] = {},
): Promise<string> {
  return clipboard("read", undefined, options);
}
