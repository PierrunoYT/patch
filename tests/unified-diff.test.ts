import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyUnifiedDiff,
  resolveEditBatch,
  UnifiedDiffEditStrategy,
  UnifiedDiffNoMatchError,
  UnifiedDiffNotUniqueError,
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

  it("distinguishes absent context from non-unique context", () => {
    expect(() =>
      applyUnifiedDiff("actual\n", "missing\n", "new\n", "a.ts"),
    ).toThrow(UnifiedDiffNoMatchError);
    expect(() =>
      applyUnifiedDiff("same\nsame\n", "same\n", "new\n", "a.ts"),
    ).toThrow(UnifiedDiffNotUniqueError);
  });

  it("replaces every generated unique asymmetric hunk exactly", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => !value.includes("\n")),
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
