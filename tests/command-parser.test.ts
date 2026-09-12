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
    ["/settings", { type: "settings" }],
    ["/ls", { type: "ls" }],
    ["/clear", { type: "clear" }],
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

  it("parses text clipboard commands without native image behavior", () => {
    expect(parseCommand("/copy")).toEqual({ type: "clipboard-copy" });
    expect(parseCommand("/paste")).toEqual({ type: "clipboard-paste" });
    expect(() => parseCommand("/copy now")).toThrow(/does not accept/u);
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
