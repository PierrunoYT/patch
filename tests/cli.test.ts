import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

describe("CLI", () => {
  it("identifies the executable and its purpose in help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: patch [options]");
    expect(help).toContain("AI pair programming in your terminal");
    expect(help).toContain("--help");
    expect(help).toContain("--message <text>");
    expect(help).toContain("--message-file <path>");
    expect(help).toContain("--input-history-file <path>");
    expect(help).toContain("--chat-history-file <path>");
  });

  it("persists explicitly configured input and returned chat messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-cli-history-"));
    const input = join(root, "input.jsonl");
    const chat = join(root, "chat.md");

    await createProgram({
      handleMessage: (message) => `reply to ${message}`,
    }).parseAsync(
      [
        "--message",
        "hello",
        "--input-history-file",
        input,
        "--chat-history-file",
        chat,
      ],
      { from: "user" },
    );

    expect(await readFile(input, "utf8")).toBe('"hello"\n');
    expect(await readFile(chat, "utf8")).toBe(
      "## User\n\nhello\n\n## Assistant\n\nreply to hello\n\n",
    );
  });

  it("runs one-shot text and message-file input exactly once", async () => {
    const received: string[] = [];
    const create = () =>
      createProgram({
        handleMessage: (message) => {
          received.push(message);
        },
        readMessageFile: async (path) => `from ${path}`,
      });

    await create().parseAsync(["--message", "hello"], { from: "user" });
    await create().parseAsync(["--message-file", "task.txt"], { from: "user" });

    expect(received).toEqual(["hello", "from task.txt"]);
  });

  it("prints shell completions without starting an input session", async () => {
    let output = "";
    await createProgram({ writeOutput: (text) => (output += text) }).parseAsync(
      ["--shell-completions", "bash"],
      { from: "user" },
    );
    expect(output).toContain("complete -F _patch patch");
  });

  it("notifies after a completed response when explicitly enabled", async () => {
    let output = "";
    await createProgram({
      handleMessage: () => "done",
      writeOutput: (text) => (output += text),
    }).parseAsync(["--message", "hello", "--notifications"], { from: "user" });
    expect(output).toBe("\u0007");
  });

  it("processes non-empty interactive lines serially until EOF", async () => {
    const received: string[] = [];
    const lines = (async function* () {
      yield "first";
      yield "   ";
      yield "second";
    })();

    await createProgram({
      lines,
      handleMessage: async (message) => {
        received.push(message);
      },
    }).parseAsync([], { from: "user" });

    expect(received).toEqual(["first", "second"]);
  });

  it("rejects ambiguous one-shot input", async () => {
    await expect(
      createProgram({ handleMessage: () => undefined }).parseAsync(
        ["--message", "hello", "--message-file", "task.txt"],
        { from: "user" },
      ),
    ).rejects.toThrow(/cannot be combined/);
  });
});
