/**
 * Command execution behavior ported from aider/run_cmd.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to require explicit approval and provide bounded, cancellable
 * child-process output without PTY support.
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export interface ModelCommandDependencies {
  readonly show: (command: string) => void | Promise<void>;
  readonly approve: (command: string) => boolean | Promise<boolean>;
}

export interface ModelCommandOptions {
  readonly root: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ModelCommandResult {
  readonly command: string;
  readonly status: "denied" | "completed" | "timed-out" | "cancelled";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export class ModelCommandError extends Error {
  override readonly name = "ModelCommandError";
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ModelCommandError(`${name} must be a positive integer`);
  }
}

export async function executeModelCommand(
  command: string,
  options: ModelCommandOptions,
  dependencies: ModelCommandDependencies,
): Promise<ModelCommandResult> {
  if (command.trim() === "") {
    throw new ModelCommandError("A model-suggested command cannot be empty");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  validatePositiveInteger(timeoutMs, "timeoutMs");
  validatePositiveInteger(maxOutputBytes, "maxOutputBytes");

  if (options.signal?.aborted) {
    return {
      command,
      status: "cancelled",
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
    };
  }
  await dependencies.show(command);
  const approved = await dependencies.approve(command);
  if (!approved) {
    return {
      command,
      status: "denied",
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
    };
  }
  if (options.signal?.aborted) {
    return {
      command,
      status: "cancelled",
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
    };
  }

  const root = await realpath(options.root);
  return new Promise<ModelCommandResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd: root,
      detached: process.platform !== "win32",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let stopped: "timed-out" | "cancelled" | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const captured = chunk.subarray(0, remaining);
      target.push(captured);
      capturedBytes += captured.length;
      if (captured.length < chunk.length) truncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const stop = (reason: "timed-out" | "cancelled") => {
      stopped ??= reason;
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // The process group already exited.
          }
        }, 1_000);
        forceKillTimer.unref();
      } catch {
        child.kill();
      }
    };
    const timer = setTimeout(() => stop("timed-out"), timeoutMs);
    const cancel = () => stop("cancelled");
    options.signal?.addEventListener("abort", cancel, { once: true });

    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      reject(
        new ModelCommandError("Unable to start model-suggested command", {
          cause: error,
        }),
      );
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      resolve({
        command,
        status: stopped ?? "completed",
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      });
    });
  });
}

export async function executeModelCommands(
  commands: readonly string[],
  options: ModelCommandOptions,
  dependencies: ModelCommandDependencies,
): Promise<ModelCommandResult[]> {
  const results: ModelCommandResult[] = [];
  for (const command of commands) {
    const result = await executeModelCommand(command, options, dependencies);
    results.push(result);
    if (result.status === "timed-out" || result.status === "cancelled") break;
  }
  return results;
}
