/**
 * Persistent history behavior adapted from aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to require explicit paths and use JSON Lines for multiline input.
 * Licensed under the Apache License, Version 2.0.
 */

import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export interface HistoryPaths {
  readonly input?: string;
  readonly chat?: string;
}

async function appendPrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

export class TerminalHistory {
  readonly #paths: HistoryPaths;

  constructor(paths: HistoryPaths = {}) {
    this.#paths = paths;
  }

  async appendInput(input: string): Promise<void> {
    if (this.#paths.input === undefined || input.trim() === "") return;
    await appendPrivate(this.#paths.input, `${JSON.stringify(input)}\n`);
  }

  async appendChat(role: "user" | "assistant", message: string): Promise<void> {
    if (this.#paths.chat === undefined || message === "") return;
    const heading = role === "user" ? "User" : "Assistant";
    await appendPrivate(this.#paths.chat, `## ${heading}\n\n${message}\n\n`);
  }
}
