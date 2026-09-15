import { describe, expect, it } from "vitest";

import { CommandParseError, parseCommand } from "../src/index.js";

describe("parseCommand", () => {
  it.each([
    [
      "/add src/a.ts 'docs/user guide.md'",
      { type: "add", paths: ["src/a.ts", "docs/user guide.md"] },
    ],
    ["/attach diagram.png", { type: "attach", paths: ["diagram.png"] }],
    ["/drop", { type: "drop", paths: [] }],
    ["/read-only README.md", { type: "read-only", paths: ["README.md"] }],
    ["/help", { type: "help" }],
    ["/help repository map", { type: "help", query: "repository map" }],
    ["/report", { type: "report" }],
    [
      "/report Unexpected failure",
      { type: "report", title: "Unexpected failure" },
    ],
    ["/settings", { type: "settings" }],
    ["/diff", { type: "diff" }],
    ["/tokens", { type: "tokens" }],
    ["/map", { type: "map" }],
    ["/ls", { type: "ls" }],
    ["/clear", { type: "clear" }],
    ["/models", { type: "models" }],
    ["/models claude", { type: "models", query: "claude" }],
    ["/weak-model", { type: "weak-model" }],
    ["/weak-model 4o", { type: "weak-model", model: "4o" }],
    ["/editor-model", { type: "editor-model" }],
    ["/editor-model 4o", { type: "editor-model", model: "4o" }],
    ["/reasoning-effort", { type: "reasoning-effort" }],
    ["/reasoning-effort high", { type: "reasoning-effort", effort: "high" }],
    ["/think-tokens", { type: "think-tokens" }],
    ["/think-tokens 8192", { type: "think-tokens", tokens: 8192 }],
    ["/model anthropic/claude", { type: "model", model: "anthropic/claude" }],
    ["/chat-mode ask", { type: "chat-mode", mode: "ask" }],
    ["/chat-mode code", { type: "chat-mode", mode: "code" }],
    ["/run npm test -- --run", { type: "run", command: "npm test -- --run" }],
    ["/test", { type: "test" }],
    ["/lint", { type: "lint" }],
    [
      "/commit explain the change",
      { type: "commit", message: "explain the change" },
    ],
    ["/commit", { type: "commit" }],
    ["/undo", { type: "undo" }],
    ["/exit", { type: "exit", code: 0 }],
  ])("parses %s", (input, expected) => {
    expect(parseCommand(input)).toEqual(expected);
  });

  it("asks for a PTY only when the user says so", () => {
    // Upstream infers a PTY from the environment; Patch requires the flag.
    expect(parseCommand("/run --interactive python")).toEqual({
      type: "run",
      command: "python",
      interactive: true,
    });
    // `--` ends the flags, so a command may start with one of them.
    expect(parseCommand("/run -- --interactive --help")).toEqual({
      type: "run",
      command: "--interactive --help",
    });
    expect(() => parseCommand("/run --interactive")).toThrow(
      /requires an argument/u,
    );
  });

  it("returns ordinary text as a submit effect without rewriting it", () => {
    expect(parseCommand("  explain this  ")).toEqual({
      type: "submit",
      message: "  explain this  ",
    });
  });

  it("bounds and validates local help queries", () => {
    expect(() => parseCommand(`/help ${"x".repeat(257)}`)).toThrow(
      /at most 256/u,
    );
    expect(() => parseCommand("/help unsafe\u0000query")).toThrow(
      /control characters/u,
    );
  });

  it("bounds and validates local model queries", () => {
    expect(() => parseCommand(`/models ${"x".repeat(257)}`)).toThrow(
      /at most 256/u,
    );
    expect(() => parseCommand("/models unsafe\u001bquery")).toThrow(
      /control characters/u,
    );
  });

  it("validates mutable reasoning controls", () => {
    expect(() => parseCommand("/reasoning-effort extreme")).toThrow(/low/u);
    expect(() => parseCommand("/think-tokens 1")).toThrow(/1024/u);
    expect(parseCommand("/think-tokens 0")).toEqual({
      type: "think-tokens",
      tokens: 0,
    });
  });

  it("bounds and validates local report titles", () => {
    expect(() => parseCommand(`/report ${"x".repeat(161)}`)).toThrow(
      /at most 160/u,
    );
    expect(() => parseCommand("/report unsafe\u001btitle")).toThrow(
      /control characters/u,
    );
  });

  it("bounds explicit URL input", () => {
    expect(() =>
      parseCommand(`/web https://example.com/${"x".repeat(4096)}`),
    ).toThrow(/at most 4096/u);
  });

  it("parses text clipboard commands without native image behavior", () => {
    expect(parseCommand("/copy")).toEqual({ type: "clipboard-copy" });
    expect(parseCommand("/paste")).toEqual({ type: "clipboard-paste" });
    expect(() => parseCommand("/copy now")).toThrow(/does not accept/u);
  });

  it("rejects arguments to the read-only diff command", () => {
    expect(() => parseCommand("/diff one.txt")).toThrow(/does not accept/u);
    expect(() => parseCommand("/tokens now")).toThrow(/does not accept/u);
    expect(() => parseCommand("/map now")).toThrow(/does not accept/u);
  });

  it.each([
    [String.raw`/add C:\repo\file.ts`, [String.raw`C:\repo\file.ts`]],
    [
      String.raw`/attach "\\server\share\diagram.png"`,
      [String.raw`\\server\share\diagram.png`],
    ],
    [
      String.raw`/drop .\relative\one.ts ..\other\two.ts`,
      [String.raw`.\relative\one.ts`, String.raw`..\other\two.ts`],
    ],
    [
      String.raw`/read-only "C:\Program Files\Patch\read me.ts"`,
      [String.raw`C:\Program Files\Patch\read me.ts`],
    ],
    [
      String.raw`/add src/with\ space.ts docs/quote\"name.md literal\\slash.ts`,
      ["src/with space.ts", 'docs/quote"name.md', String.raw`literal\slash.ts`],
    ],
    ["/add C:\\", ["C:\\"]],
  ])("preserves Windows paths and POSIX escapes in %s", (input, paths) => {
    expect(parseCommand(input)).toMatchObject({ paths });
  });

  it.each([
    "/add",
    "/attach",
    "/read-only",
    "/model",
    "/run",
    "/chat-mode invalid",
    "/chat-mode architect",
    "/add 'open",
    "/ls now",
    "/settings now",
    "/wat",
  ])("rejects malformed command %s", (input) => {
    expect(() => parseCommand(input)).toThrow(CommandParseError);
  });
});
