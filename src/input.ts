/**
 * Input flow adapted from aider/main.py and aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with async Node.js line input and an injected session handler.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

export interface InputOptions {
  readonly message?: string;
  readonly messageFile?: string;
  readonly multiline?: boolean;
}

export interface InputDependencies {
  readonly signal?: AbortSignal;
  readonly handleMessage: (
    message: string,
  ) => void | string | InputResponse | Promise<void | string | InputResponse>;
  readonly recordInput?: (message: string) => void | Promise<void>;
  readonly recordChat?: (
    role: "user" | "assistant",
    message: string,
  ) => void | Promise<void>;
  readonly lines?: AsyncIterable<string>;
  readonly readMessageFile?: (path: string) => Promise<string>;
}

export interface InputResponse {
  readonly response?: string;
  readonly exit?: boolean;
}

export class InputModeError extends Error {
  override readonly name = "InputModeError";
}

async function submit(
  message: string,
  dependencies: InputDependencies,
): Promise<boolean> {
  await dependencies.recordInput?.(message);
  await dependencies.recordChat?.("user", message);
  const response = await dependencies.handleMessage(message);
  const assistant =
    typeof response === "string" ? response : response?.response;
  if (assistant !== undefined)
    await dependencies.recordChat?.("assistant", assistant);
  return typeof response === "object" && response?.exit === true;
}

function terminalLines(signal?: AbortSignal): AsyncIterable<string> {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function* collectInputMessages(
  lines: AsyncIterable<string>,
  multiline = false,
): AsyncIterable<string> {
  let block: string[] | undefined;
  let closing = "}";
  for await (const line of lines) {
    if (block !== undefined) {
      if (line === closing) {
        yield block.join("\n");
        block = undefined;
        closing = "}";
      } else {
        block.push(line);
      }
      continue;
    }
    const marker = /^\{([\p{Letter}\p{Number}]*)$/u.exec(line);
    if (marker !== null) {
      block = [];
      closing = `${marker[1] ?? ""}}`;
    } else if (!multiline && line.trim() !== "") {
      yield line;
    } else if (multiline) {
      block = [line];
      closing = "\u0000";
    }
  }
  if (block !== undefined && closing === "\u0000") {
    const message = block.join("\n");
    if (message.trim() !== "") yield message;
  }
}

export async function runInput(
  options: InputOptions,
  dependencies: InputDependencies,
): Promise<void> {
  if (options.message !== undefined && options.messageFile !== undefined) {
    throw new InputModeError("--message and --message-file cannot be combined");
  }
  if (options.message !== undefined) {
    await submit(options.message, dependencies);
    return;
  }
  if (options.messageFile !== undefined) {
    const read =
      dependencies.readMessageFile ?? ((path) => readFile(path, "utf8"));
    await submit(await read(options.messageFile), dependencies);
    return;
  }

  for await (const message of collectInputMessages(
    dependencies.lines ?? terminalLines(dependencies.signal),
    options.multiline,
  )) {
    dependencies.signal?.throwIfAborted();
    if (await submit(message, dependencies)) break;
  }
}
