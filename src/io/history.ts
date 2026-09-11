/**
 * Persistent history behavior adapted from aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to require explicit paths and use JSON Lines for multiline input.
 * Licensed under the Apache License, Version 2.0.
 */

import { mkdir, open, readFile } from "node:fs/promises";
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

  /**
   * Previously submitted inputs, oldest first, for seeding recall in a new
   * session. A line that is not valid JSON is skipped rather than failing
   * startup: this file is appended to by every session and may be truncated.
   */
  async readInput(limit = 1000): Promise<string[]> {
    const path = this.#paths.input;
    if (path === undefined) return [];
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const inputs: string[] = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "string" && value !== "") inputs.push(value);
      } catch {
        continue;
      }
    }
    return inputs.slice(-limit);
  }

  async appendChat(role: "user" | "assistant", message: string): Promise<void> {
    if (this.#paths.chat === undefined || message === "") return;
    const heading = role === "user" ? "User" : "Assistant";
    await appendPrivate(this.#paths.chat, `## ${heading}\n\n${message}\n\n`);
  }
}
