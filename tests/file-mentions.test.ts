import { describe, expect, it } from "vitest";

import { findFileMentions } from "../src/index.js";

describe("findFileMentions", () => {
  it("matches normalized full paths and unique useful basenames", () => {
    expect(
      findFileMentions(
        "Edit `src\\nested-file.ts`, then **unique.ts**; not shared.ts.",
        [
          "src/nested-file.ts",
          "other/unique.ts",
          "one/shared.ts",
          "two/shared.ts",
        ],
      ),
    ).toEqual(["other/unique.ts", "src/nested-file.ts"]);
  });

  it("does not infer a basename already represented by a selected path", () => {
    expect(
      findFileMentions("change index.ts", ["other/index.ts"], ["src/index.ts"]),
    ).toEqual([]);
  });
});
