import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyUnifiedDiff,
  resolveEditBatch,
  UnifiedDiffEditStrategy,
  UnifiedDiffNoMatchError,
  UnifiedDiffNotUniqueError,
  UnifiedDiffParseError,
} from "../src/index.js";

const context = { editablePaths: ["src/a.ts"], fence: ["```", "```"] as const };

describe("UnifiedDiffEditStrategy", () => {
  it("parses a git-style fenced diff into independently resolvable hunks", () => {
    const batch = new UnifiedDiffEditStrategy().parse(
      "```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n alpha\n-old\n+new\n```",
      context,
    );
    expect(
      resolveEditBatch(batch, [
        { path: "src/a.ts", content: "alpha\nold\nomega\n" },
      ]).operations[0],
    ).toMatchObject({
      content: "alpha\nnew\nomega\n",
    });
  });

  it("follows every file-header transition inside one fence", () => {
    const batch = new UnifiedDiffEditStrategy().parse(
      [
        "```diff",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-old",
        "+new",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1,1 +1,1 @@",
        "-second",
        "+changed",
        "```",
      ].join("\n"),
      context,
    );

    expect(batch.edits).toMatchObject([
      { path: "src/a.ts", search: "alpha\nold\n", replacement: "alpha\nnew\n" },
      { path: "src/b.ts", search: "second\n", replacement: "changed\n" },
    ]);
    expect(
      resolveEditBatch(batch, [
        { path: "src/a.ts", content: "alpha\nold\n" },
        { path: "src/b.ts", content: "second\n" },
      ]).operations,
    ).toMatchObject([
      { path: "src/a.ts", content: "alpha\nnew\n" },
      { path: "src/b.ts", content: "changed\n" },
    ]);
  });

  it("strips git prefixes only when both headers carry them", () => {
    const strategy = new UnifiedDiffEditStrategy();
    const created = strategy.parse(
      "```diff\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+added\n```",
      context,
    );
    const plain = strategy.parse(
      "```diff\n--- src/plain.ts\n+++ src/plain.ts\n@@ -1 +1 @@\n-old\n+new\n```",
      context,
    );

    expect(created.edits).toMatchObject([{ path: "src/new.ts" }]);
    expect(plain.edits).toMatchObject([{ path: "src/plain.ts" }]);
  });

  it.each([
    {
      name: "preserves missing newlines on both sides",
      hunk: [
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ],
      original: "old",
      expected: "new",
    },
    {
      name: "adds a final newline",
      hunk: ["-old", "\\ No newline at end of file", "+new"],
      original: "old",
      expected: "new\n",
    },
    {
      name: "removes a final newline",
      hunk: ["-old", "+new", "\\ No newline at end of file"],
      original: "old\n",
      expected: "new",
    },
  ])("$name from standard marker placement", ({ hunk, original, expected }) => {
    const batch = new UnifiedDiffEditStrategy().parse(
      [
        "```diff",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        ...hunk,
        "```",
      ].join("\n"),
      context,
    );

    expect(batch.edits[0]).toMatchObject({
      search: original,
      replacement: expected,
    });
    expect(
      resolveEditBatch(batch, [{ path: "src/a.ts", content: original }])
        .operations[0],
    ).toMatchObject({ content: expected });
  });

  it("rejects a detached no-newline marker", () => {
    expect(() =>
      new UnifiedDiffEditStrategy().parse(
        [
          "```diff",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "\\ No newline at end of file",
          "-old",
          "+new",
          "```",
        ].join("\n"),
        context,
      ),
    ).toThrow(UnifiedDiffParseError);
  });

  it("keeps ambiguity rejection for no-newline hunks", () => {
    expect(() => applyUnifiedDiff("oldold", "old", "new", "a.ts")).toThrow(
      UnifiedDiffNotUniqueError,
    );
  });

  it("distinguishes absent context from non-unique context", () => {
    expect(() =>
      applyUnifiedDiff("actual\n", "missing\n", "new\n", "a.ts"),
    ).toThrow(UnifiedDiffNoMatchError);
    expect(() =>
      applyUnifiedDiff("same\nsame\n", "same\n", "new\n", "a.ts"),
    ).toThrow(UnifiedDiffNotUniqueError);
  });

  it("distinguishes whitespace-only lines from empty hunk sides", () => {
    expect(applyUnifiedDiff("prefix\n \nsuffix\n", " \n", "", "a.ts")).toBe(
      "prefix\nsuffix\n",
    );
    expect(applyUnifiedDiff("existing\n", "", "added\n", "a.ts")).toBe(
      "existing\nadded\n",
    );
  });

  it("replaces every generated unique asymmetric hunk exactly", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => {
          if (value.includes("\n")) return false;
          const content = `prefix\n${value}\nsuffix\n`;
          const hunk = `${value}\n`;
          return content.indexOf(hunk) === content.lastIndexOf(hunk);
        }),
        fc.string(),
        (oldValue, newValue) => {
          expect(
            applyUnifiedDiff(
              `prefix\n${oldValue}\nsuffix\n`,
              `${oldValue}\n`,
              `${newValue}\n`,
              "a.ts",
            ),
          ).toBe(`prefix\n${newValue}\nsuffix\n`);
        },
      ),
    );
  });
});
