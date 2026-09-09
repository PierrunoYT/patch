import { describe, expect, it } from "vitest";

import { CommandParseError, parseCommand } from "../src/index.js";

describe("parseCommand", () => {
  it.each([
    [
      "/add src/a.ts 'docs/user guide.md'",
      { type: "add", paths: ["src/a.ts", "docs/user guide.md"] },
    ],
    ["/drop", { type: "drop", paths: [] }],
    ["/read-only README.md", { type: "read-only", paths: ["README.md"] }],
    ["/ls", { type: "ls" }],
    ["/clear", { type: "clear" }],
    ["/model anthropic/claude", { type: "model", model: "anthropic/claude" }],
    ["/chat-mode architect", { type: "chat-mode", mode: "architect" }],
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

  it("returns ordinary text as a submit effect without rewriting it", () => {
    expect(parseCommand("  explain this  ")).toEqual({
      type: "submit",
      message: "  explain this  ",
    });
  });

  it("parses text clipboard commands without native image behavior", () => {
    expect(parseCommand("/copy")).toEqual({ type: "clipboard-copy" });
    expect(parseCommand("/paste")).toEqual({ type: "clipboard-paste" });
    expect(() => parseCommand("/copy now")).toThrow(/does not accept/u);
  });

  it.each([
    "/add",
    "/read-only",
    "/model",
    "/run",
    "/chat-mode invalid",
    "/add 'open",
    "/ls now",
    "/wat",
  ])("rejects malformed command %s", (input) => {
    expect(() => parseCommand(input)).toThrow(CommandParseError);
  });
});
