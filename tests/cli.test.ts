import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ApplicationSubmitOptions } from "../src/core/application-service.js";
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

  it("uses staged YAML history and notification settings in the executable path", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-cli-configured-"));
    const input = join(root, "input.jsonl");
    const chat = join(root, "chat.md");
    await writeFile(
      join(root, ".patch.conf.yml"),
      `input-history-file: ${input}\nchat-history-file: ${chat}\nnotifications: true\n`,
    );
    let output = "";

    await createProgram({
      cwd: root,
      environment: {},
      handleMessage: (message) => `reply to ${message}`,
      writeOutput: (text) => (output += text),
    }).parseAsync(["--message", "configured"], { from: "user" });

    expect(await readFile(input, "utf8")).toBe('"configured"\n');
    expect(await readFile(chat, "utf8")).toContain("reply to configured");
    expect(output).toBe("\u0007");
  });

  it("keeps a configured web port out of an ordinary terminal start", async () => {
    // The guard exists to refuse a CLI flag pair that cannot be honored. Read
    // from the merged configuration it also caught a persisted `web-port:`,
    // which made every non-web run fail at startup.
    const root = await mkdtemp(join(tmpdir(), "patch-cli-web-port-"));
    await writeFile(join(root, ".patch.conf.yml"), "web-port: 9123\n");
    const received: string[] = [];

    await createProgram({
      cwd: root,
      environment: {},
      handleMessage: (message) => {
        received.push(message);
      },
    }).parseAsync(["--message", "hello"], { from: "user" });
    expect(received).toEqual(["hello"]);

    await createProgram({
      cwd: root,
      environment: { PATCH_WEB_PORT: "9124" },
      handleMessage: (message) => {
        received.push(message);
      },
    }).parseAsync(["--message", "again"], { from: "user" });
    expect(received).toEqual(["hello", "again"]);

    // Asking for the pair on the command line is still refused.
    await expect(
      createProgram({
        cwd: root,
        environment: {},
        handleMessage: () => undefined,
      }).parseAsync(["--web-port", "9125", "--message", "hello"], {
        from: "user",
      }),
    ).rejects.toThrow("web-port and web-token-file require web");
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
    // An option that does nothing must not be completable.
    expect(output).not.toContain("--vim");
  });

  it("completes every option the parser registers", async () => {
    // The inventory used to be a hand-kept list here and had silently fallen
    // behind the parser; it is now derived from it, and this keeps it derived.
    let output = "";
    const program = createProgram({ writeOutput: (text) => (output += text) });
    await program.parseAsync(["--shell-completions", "bash"], { from: "user" });

    const advertised = program.options
      .filter((option) => !option.hidden)
      .map((option) => option.long);
    expect(advertised.length).toBeGreaterThan(15);
    for (const option of advertised) {
      expect(output).toContain(`${String(option)} `);
    }
    expect(output).toContain("--help");
    // A hidden option is registered so it can be refused, never completed.
    expect(output).not.toContain("--vim");
  });

  it("refuses the unimplemented Vi binding by name", async () => {
    await expect(
      createProgram({ handleMessage: () => undefined }).parseAsync(
        ["--vim", "--message", "hello"],
        { from: "user" },
      ),
    ).rejects.toThrow(/--vim is not implemented/u);
  });

  it("notifies after a completed response when explicitly enabled", async () => {
    let output = "";
    await createProgram({
      handleMessage: () => "done",
      writeOutput: (text) => (output += text),
    }).parseAsync(["--message", "hello", "--notifications"], { from: "user" });
    expect(output).toBe("\u0007");
  });

  it("notifies for a provider turn only, and survives a failing notifier", async () => {
    let output = "";
    const submitted: string[] = [];
    async function* lines() {
      yield "/ls";
      yield "a question";
    }
    await createProgram({
      writeOutput: (text) => (output += text),
      lines: lines(),
      createApplication: async () =>
        ({
          createSession: () => ({
            snapshot: () => ({}),
            submit: (message: string) => {
              submitted.push(message);
              return Promise.resolve(
                message.startsWith("/")
                  ? { kind: "command", response: "Editable: (none)" }
                  : { kind: "turn", response: "answered" },
              );
            },
          }),
          close: () => undefined,
        }) as never,
    }).parseAsync(["--model", "4o", "--notifications"], { from: "user" });

    expect(submitted).toEqual(["/ls", "a question"]);
    // A slash command answers immediately; only the provider turn rings.
    expect([...output].filter((one) => one === "\u0007")).toHaveLength(1);
  });

  it("reports a failing notification command instead of ending input", async () => {
    let output = "";
    const submitted: string[] = [];
    async function* lines() {
      yield "first";
      yield "second";
    }
    await createProgram({
      writeOutput: (text) => (output += text),
      lines: lines(),
      createApplication: async () =>
        ({
          createSession: () => ({
            snapshot: () => ({}),
            submit: (message: string) => {
              submitted.push(message);
              return Promise.resolve({ kind: "turn", response: "answered" });
            },
          }),
          close: () => undefined,
        }) as never,
    }).parseAsync(
      [
        "--model",
        "4o",
        "--notifications",
        "--notifications-command",
        "patch-no-such-notifier",
      ],
      { from: "user" },
    );

    // The turn after the failure still runs: a broken notifier is not fatal.
    expect(submitted).toEqual(["first", "second"]);
    expect(output).toContain("Notification failed");
  });

  it("renders streamed application output and edit previews without unsafe control sequences", async () => {
    let output = "";
    await createProgram({
      outputIsTTY: true,
      environment: { NO_COLOR: "1" },
      writeOutput: (text) => (output += text),
      createApplication: async () =>
        ({
          createSession: () => ({
            snapshot: () => ({}),
            submit: async (
              _message: string,
              options: ApplicationSubmitOptions,
            ) => {
              options.emit({
                type: "text-delta",
                data: {
                  text: "# Result\nSafe\u001b]2;hostile\u0007 text\n",
                },
              });
              options.emit({
                type: "edit-preview",
                data: {
                  changedPaths: ["src/a.ts"],
                  operations: [
                    {
                      kind: "update",
                      path: "src/a.ts",
                      before: "old",
                      content: "new",
                    },
                  ],
                },
              });
              return { response: "Result" };
            },
          }),
          close: () => undefined,
        }) as never,
    }).parseAsync(["--message", "change it"], { from: "user" });

    expect(output).toContain("Result\nSafe text");
    expect(output).toContain("--- a/src/a.ts\n+++ b/src/a.ts");
    expect(output).toContain("-old\n+new");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("hostile");
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
