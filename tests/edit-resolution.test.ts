import { describe, expect, it } from "vitest";

import {
  EditResolutionError,
  MissingFileSnapshotError,
  resolveEditBatch,
  SearchReplaceNoMatchError,
} from "../src/index.js";

describe("resolveEditBatch", () => {
  it("resolves sequential edits against isolated working copies", () => {
    const snapshots = [{ path: "file.ts", content: "one\ntwo\n" }];

    const result = resolveEditBatch(
      {
        edits: [
          {
            kind: "replace",
            path: "file.ts",
            search: "one\n",
            replacement: "first\n",
          },
          {
            kind: "replace",
            path: "file.ts",
            search: "two\n",
            replacement: "second\n",
          },
        ],
        shellCommands: ["npm test\n"],
      },
      snapshots,
    );

    expect(result).toEqual({
      files: [
        {
          path: "file.ts",
          before: "one\ntwo\n",
          after: "first\nsecond\n",
        },
      ],
      shellCommands: ["npm test\n"],
    });
    expect(snapshots).toEqual([{ path: "file.ts", content: "one\ntwo\n" }]);
  });

  it("returns no partial result when a later edit cannot resolve", () => {
    const batch = {
      edits: [
        {
          kind: "rewrite" as const,
          path: "first.ts",
          content: "changed\n",
        },
        {
          kind: "replace" as const,
          path: "second.ts",
          search: "not present\n",
          replacement: "replacement\n",
        },
      ],
      shellCommands: [],
    };
    const snapshots = [
      { path: "first.ts", content: "original\n" },
      { path: "second.ts", content: "actual\n" },
    ];

    let caught: unknown;
    try {
      resolveEditBatch(batch, snapshots);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EditResolutionError);
    expect(caught).toMatchObject({ editIndex: 1, path: "second.ts" });
    expect((caught as Error).cause).toBeInstanceOf(SearchReplaceNoMatchError);
    expect(snapshots[0]?.content).toBe("original\n");
  });

  it("requires an explicit snapshot for every model-selected path", () => {
    expect(() =>
      resolveEditBatch(
        {
          edits: [{ kind: "rewrite", path: "unseen.ts", content: "new\n" }],
          shellCommands: [],
        },
        [],
      ),
    ).toThrow(EditResolutionError);

    try {
      resolveEditBatch(
        {
          edits: [{ kind: "rewrite", path: "unseen.ts", content: "new\n" }],
          shellCommands: [],
        },
        [],
      );
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(MissingFileSnapshotError);
    }
  });

  it("suppresses a sequence whose final content equals its snapshot", () => {
    expect(
      resolveEditBatch(
        {
          edits: [
            { kind: "rewrite", path: "file.ts", content: "temporary\n" },
            { kind: "rewrite", path: "file.ts", content: "original\n" },
          ],
          shellCommands: [],
        },
        [{ path: "file.ts", content: "original\n" }],
      ).files,
    ).toEqual([]);
  });
});
