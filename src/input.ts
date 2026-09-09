/**
 * Input flow adapted from aider/main.py and aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for async Node.js line input and an injected session handler.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

export interface InputOptions {
  readonly message?: string;
  readonly messageFile?: string;
}

export interface InputDependencies {
  readonly handleMessage: (
    message: string,
  ) => void | string | Promise<void | string>;
  readonly recordInput?: (message: string) => void | Promise<void>;
  readonly recordChat?: (
    role: "user" | "assistant",
    message: string,
  ) => void | Promise<void>;
  readonly lines?: AsyncIterable<string>;
  readonly readMessageFile?: (path: string) => Promise<string>;
}

export class InputModeError extends Error {
  override readonly name = "InputModeError";
}

async function submit(
  message: string,
  dependencies: InputDependencies,
): Promise<void> {
  await dependencies.recordInput?.(message);
  await dependencies.recordChat?.("user", message);
  const response = await dependencies.handleMessage(message);
  if (typeof response === "string") {
    await dependencies.recordChat?.("assistant", response);
  }
}

function terminalLines(): AsyncIterable<string> {
  return createInterface({ input: process.stdin, output: process.stdout });
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

  for await (const line of dependencies.lines ?? terminalLines()) {
    if (line.trim() !== "") {
      await submit(line, dependencies);
    }
  }
}
