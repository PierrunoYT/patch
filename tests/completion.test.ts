import { describe, expect, it } from "vitest";

import { completeInput, extractIdentifiers } from "../src/io/completion.js";

const sources = {
  commands: ["add", "drop", "read-only", "run"],
  files: ["src/apple.ts", "src/apricot.ts", "tests/apple.test.ts"],
  identifiers: ["AppleService", "applyPatch", "banana"],
  modes: ["code", "ask", "whole", "diff", "diff-fenced", "udiff", "patch"],
};

describe("terminal completion", () => {
  it("completes commands case-insensitively and replaces only the prefix", () => {
    expect(completeInput("/R", 2, sources)).toEqual([
      {
        value: "/read-only",
        display: "/read-only",
        kind: "command",
        replaceFrom: 0,
      },
      {
        value: "/run",
        display: "/run",
        kind: "command",
        replaceFrom: 0,
      },
    ]);
  });

  it("uses file-only completion for path commands", () => {
    const result = completeInput("/add src/ap", 11, sources);
    expect(result.map(({ value, kind }) => ({ value, kind }))).toEqual([
      { value: "src/apple.ts", kind: "file" },
      { value: "src/apricot.ts", kind: "file" },
    ]);
    expect(result[0]?.replaceFrom).toBe(5);
  });

  it("completes only constructed chat modes", () => {
    expect(
      completeInput("/chat-mode d", 12, sources).map(({ value }) => value),
    ).toEqual(["diff", "diff-fenced"]);
    expect(completeInput("/chat-mode a", 12, sources)[0]?.value).toBe("ask");
    expect(sources.modes).not.toContain("architect");
  });

  it("requires three characters for general file and identifier completion", () => {
    expect(completeInput("ap", 2, sources)).toEqual([]);
    expect(completeInput("app", 3, sources).map((item) => item.value)).toEqual([
      "AppleService",
      "applyPatch",
    ]);
  });

  it("extracts deterministic Unicode identifiers and ignores short names", () => {
    expect(
      extractIdentifiers([
        "const caféValue = tiny; const caféValue = other;",
        "class ΩmegaService {} let ok = 1;",
      ]),
    ).toEqual(["caféValue", "other", "tiny", "ΩmegaService"]);
  });
});
