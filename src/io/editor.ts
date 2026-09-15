/**
 * External-editor behavior adapted from aider/editor.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to spawn an argv command without a shell and always remove its file.
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { splitQuotedWords, UnterminatedWordQuoteError } from "./word-split.js";

const DEFAULT_MAX_DRAFT_BYTES = 1024 * 1024;
const EDITOR_TERMINATION_GRACE_MS = 1_000;

export function discoverEditor(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    environment.VISUAL ??
    environment.EDITOR ??
    (platform === "win32" ? "notepad" : platform === "darwin" ? "vim" : "vi")
  );
}

export function splitEditorCommand(command: string): string[] {
  let result: string[];
  try {
    result = splitQuotedWords(command.trim());
  } catch (error) {
    if (error instanceof UnterminatedWordQuoteError) {
      throw new Error("Editor command contains an unterminated quote", {
        cause: error,
      });
    }
    throw error;
  }
  if (result.length === 0) throw new Error("Editor command cannot be empty");
  return result;
}

async function runEditor(
  command: readonly string[],
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined)
    throw new Error("Editor command cannot be empty");
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args, path], { stdio: "inherit" });
    let cancelled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(
        () => child.kill("SIGKILL"),
        EDITOR_TERMINATION_GRACE_MS,
      );
      forceKillTimer.unref();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (error) => {
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", cancel);
      if (cancelled) reject(signal?.reason);
      else if (code === 0) resolve();
      else reject(new Error(`Editor exited with status ${String(code)}`));
    });
  });
}

async function readEditedDraft(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const handle = await open(path, "r");
  try {
    const information = await handle.stat();
    if (information.size > maximumBytes)
      throw new Error(
        `Edited draft exceeds the ${String(maximumBytes)}-byte read limit`,
      );
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximumBytes + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += bytesRead;
      if (total > maximumBytes)
        throw new Error(
          `Edited draft exceeds the ${String(maximumBytes)}-byte read limit`,
        );
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

export async function editInExternalEditor(
  input: string,
  options: {
    readonly editor?: string;
    readonly suffix?: string;
    readonly signal?: AbortSignal;
    readonly maxDraftBytes?: number;
  } = {},
): Promise<string> {
  const maxDraftBytes = options.maxDraftBytes ?? DEFAULT_MAX_DRAFT_BYTES;
  if (!Number.isSafeInteger(maxDraftBytes) || maxDraftBytes <= 0)
    throw new TypeError("maxDraftBytes must be a positive integer");
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "patch-editor-"));
  const path = join(directory, `input.${options.suffix ?? "md"}`);
  try {
    await writeFile(path, input, { encoding: "utf8", mode: 0o600 });
    await runEditor(
      splitEditorCommand(options.editor ?? discoverEditor()),
      path,
      options.signal,
    );
    options.signal?.throwIfAborted();
    return (await readEditedDraft(path, maxDraftBytes)).replace(/\n+$/u, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
