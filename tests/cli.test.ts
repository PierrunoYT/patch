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
