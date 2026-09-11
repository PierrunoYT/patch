/**
 * Input flow adapted from aider/main.py and aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with async Node.js line input and an injected session handler.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";

import { completeInput, type CompletionSources } from "./io/completion.js";

export interface TerminalInputOptions {
  /**
   * Read when the user asks for completion, so the candidates reflect the files
   * selected right now rather than those selected at startup.
   */
  readonly completionSources?: () => CompletionSources;
  /** Earlier inputs, oldest first, made recallable with the arrow keys. */
  readonly history?: readonly string[];
}

/** One reader owns both input queues and fresh, explicit terminal answers. */
export class TerminalInput implements AsyncIterable<string> {
  readonly #reader;
  readonly #queue: string[] = [];
  readonly #write: (text: string) => void;
  readonly #completionSources: (() => CompletionSources) | undefined;
  #wake: (() => void) | undefined;
  #answer: ((answer: boolean) => void) | undefined;
  #closed = false;

  constructor(
    input: Readable,
    write: (text: string) => void,
    signal: AbortSignal,
    interrupt: () => void = () => this.close(),
    options: TerminalInputOptions = {},
  ) {
    this.#write = write;
    this.#completionSources = options.completionSources;
    // No second readline/question consumer; queued messages stay messages.
    const output = new Writable({
      write(chunk, _encoding, done) {
        write(String(chunk));
        done();
      },
    });
    this.#reader = createInterface({
      input,
      output,
      terminal: true,
      signal,
      ...(options.completionSources === undefined
        ? {}
        : { completer: (line: string) => this.complete(line) }),
      // Readline recalls most-recent-first; the history file is oldest-first.
      ...(options.history === undefined
        ? {}
        : { history: [...options.history].reverse() }),
    });
    this.#reader.on("SIGINT", interrupt);
    this.#reader.on("line", (line) => {
      if (this.#answer !== undefined) {
        const answer = this.#answer;
        this.#answer = undefined;
        setImmediate(() => answer(!this.#closed && /^(y|yes)$/iu.test(line)));
      } else {
        this.#queue.push(line);
        this.#wake?.();
      }
    });
    this.#reader.on("close", () => {
      this.#closed = true;
      this.#answer?.(false);
      this.#answer = undefined;
      this.#wake?.();
    });
  }

  async confirm(label: string, value: string): Promise<boolean> {
    // Drain the current input event (including pasted lines) before arming.
    await new Promise<void>((done) => setImmediate(done));
    if (
      this.#closed ||
      this.#answer !== undefined ||
      this.#queue.length > 0 ||
      this.#reader.line !== ""
    ) {
      this.#write(
        "\nApproval denied: input is closed or already queued/partially typed.\n",
      );
      return false;
    }
    const literal = JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028\u2029]|\p{Cf}/gu,
      (character) =>
        character
          .split("")
          .map(
            (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
          .join(""),
    );
    return new Promise<boolean>((done) => {
      this.#answer = done;
      this.#write(
        `\n${label} (JSON-quoted literal): ${literal}\nApprove? [y/yes; anything else denies] `,
      );
    });
  }

  /**
   * Readline's completer contract: the candidate values, and the substring they
   * replace. An empty list with the whole line leaves the input untouched.
   */
  complete(line: string): [string[], string] {
    const sources = this.#completionSources?.();
    if (sources === undefined) return [[], line];
    const found = completeInput(line, line.length, sources);
    const replaceFrom = found[0]?.replaceFrom;
    if (replaceFrom === undefined) return [[], line];
    return [found.map(({ value }) => value), line.slice(replaceFrom)];
  }

  close(): void {
    this.#reader.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const line = this.#queue.shift();
      if (line !== undefined) yield line;
      else if (this.#closed) return;
      else
        await new Promise<void>((done) => {
          this.#wake = done;
        });
    }
  }
}

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
