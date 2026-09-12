import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStrategy,
  EditTransaction,
  FileSystemAdapter,
  resolveEditBatch,
  type EditFormat,
  type FileSnapshot,
  type ResolvedFileOperation,
} from "../src/index.js";

interface GoldenCase {
  readonly format: EditFormat;
  readonly upstreamPath: string;
  readonly classification: string;
  readonly snapshots: readonly FileSnapshot[];
  readonly response: string;
  readonly operations: readonly ResolvedFileOperation[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("fixtures/edit-format-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  schemaVersion: number;
  upstreamRevision: string;
  cases: GoldenCase[];
};
const formats = [
  "ask",
  "whole",
  "diff",
  "diff-fenced",
  "udiff",
  "patch",
] as const;
const mutatingFormats = formats.filter((format) => format !== "ask");
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function context(snapshots: readonly FileSnapshot[]) {
  return {
    editablePaths: snapshots.map(({ path }) => path),
    fence: ["```", "```"] as const,
    files: snapshots,
  };
}

function responseFor(
  format: (typeof mutatingFormats)[number],
  paths: readonly string[],
  oldValues: readonly string[],
  newValues: readonly string[],
): string {
  const blocks = paths.map((path, index) => {
    const oldValue = oldValues[index] ?? "";
    const newValue = newValues[index] ?? "";
    if (format === "whole")
      return `${path}\n\`\`\`text\nhead:${index}\n${newValue}\ntail:${index}\n\`\`\``;
    if (format === "diff")
      return `${path}\n\`\`\`text\n<<<<<<< SEARCH\n${oldValue}\n=======\n${newValue}\n>>>>>>> REPLACE\n\`\`\``;
    if (format === "diff-fenced")
      return `\`\`\`text\n${path}\n<<<<<<< SEARCH\n${oldValue}\n=======\n${newValue}\n>>>>>>> REPLACE\n\`\`\``;
    if (format === "udiff")
      return `--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n head:${index}\n-${oldValue}\n+${newValue}\n tail:${index}`;
    return `*** Update File: ${path}\n@@\n head:${index}\n-${oldValue}\n+${newValue}\n tail:${index}`;
  });
  if (format === "udiff") return `\`\`\`diff\n${blocks.join("\n")}\n\`\`\``;
  if (format === "patch")
    return `*** Begin Patch\n${blocks.join("\n")}\n*** End Patch`;
  return blocks.join("\n");
}

function twoFileBatch(format: (typeof mutatingFormats)[number]) {
  const paths = ["first.txt", "second.txt"] as const;
  const oldValues = ["old:first", "old:second"] as const;
  const newValues = ["new:first", "new:second"] as const;
  const snapshots = paths.map((path, index) => ({
    path,
    content: `head:${index}\n${oldValues[index]}\ntail:${index}\n`,
  }));
  const parsed = createStrategy(format).strategy.parse(
    responseFor(format, paths, oldValues, newValues),
    context(snapshots),
  );
  return { snapshots, resolved: resolveEditBatch(parsed, snapshots) };
}

describe("independent advertised edit-format goldens", () => {
  it("pins one independently authored result for every constructed format", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.upstreamRevision).toBe(
      "5dc9490bb35f9729ef2c95d00a19ccd30c26339c",
    );
    expect(fixture.cases.map(({ format }) => format)).toEqual(formats);
    for (const golden of fixture.cases) {
      expect(golden.upstreamPath).toMatch(/^aider\/coders\//u);
      expect(golden.classification).toContain("upstream-compatible");
      const batch = createStrategy(golden.format).strategy.parse(
        golden.response,
        context(golden.snapshots),
      );
      expect(resolveEditBatch(batch, golden.snapshots).operations).toEqual(
        golden.operations,
      );
    }
  });

  it("applies asymmetric generated content through every constructed format", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        (oldValue, newValue) => {
          fc.pre(oldValue !== newValue);
          for (const format of mutatingFormats) {
            const snapshots = [
              { path: "first.txt", content: `head:0\n${oldValue}\ntail:0\n` },
            ];
            // Built as one file rather than by stripping a second one out of a
            // two-file response: that regex also removed the closing ``` of a
            // udiff fence and the *** End Patch trailer, so two of the five
            // formats were parsing a truncated payload and passing only because
            // their parsers tolerate one.
            const response = responseFor(
              format,
              ["first.txt"],
              [oldValue],
              [newValue],
            );
            const batch = createStrategy(format).strategy.parse(
              response,
              context(snapshots),
            );
            expect(resolveEditBatch(batch, snapshots).operations).toMatchObject(
              [{ path: "first.txt", content: `head:0\n${newValue}\ntail:0\n` }],
            );
          }
          expect(
            createStrategy("ask").strategy.parse(
              `*** Delete File: ${oldValue}`,
              context([]),
            ),
          ).toEqual({ edits: [], shellCommands: [] });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("handles malformed output without converting it into an unintended edit", () => {
    const snapshot = [{ path: "first.txt", content: "same\n" }];
    expect(
      createStrategy("ask").strategy.parse(
        "*** Begin Patch\n*** Delete File: first.txt",
        context(snapshot),
      ),
    ).toEqual({ edits: [], shellCommands: [] });
    expect(
      createStrategy("whole").strategy.parse(
        "first.txt\nnot a fenced body",
        context(snapshot),
      ),
    ).toEqual({ edits: [], shellCommands: [] });
    for (const [format, response] of [
      ["diff", "first.txt\n<<<<<<< SEARCH\nsame\nmissing divider"],
      [
        "diff-fenced",
        "```text\nfirst.txt\n<<<<<<< SEARCH\nsame\nmissing divider\n```",
      ],
      [
        "udiff",
        "```diff\n--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n\\ No newline at end of file\n-same\n+new\n```",
      ],
      ["patch", "*** Begin Patch\n*** Add File: new.txt\nmissing-plus"],
    ] as const) {
      expect(() =>
        createStrategy(format).strategy.parse(response, context(snapshot)),
      ).toThrow();
    }
  });

  it("rejects ambiguous or conflicting targeting in every mutating protocol", () => {
    const repeated = [
      { path: "first.txt", content: "same\nmiddle\nsame\n" },
      { path: "second.txt", content: "other\n" },
    ];
    expect(() =>
      createStrategy("whole").strategy.parse(
        "```text\nunnamed\n```",
        context(repeated),
      ),
    ).toThrow();
    for (const format of ["diff", "diff-fenced", "udiff"] as const) {
      const response =
        format === "udiff"
          ? "```diff\n--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-same\n+new\n```"
          : format === "diff-fenced"
            ? "```text\nfirst.txt\n<<<<<<< SEARCH\nsame\n=======\nnew\n>>>>>>> REPLACE\n```"
            : "first.txt\n```text\n<<<<<<< SEARCH\nsame\n=======\nnew\n>>>>>>> REPLACE\n```";
      const batch = createStrategy(format).strategy.parse(
        response,
        context(repeated),
      );
      expect(() => resolveEditBatch(batch, repeated)).toThrow();
    }
    expect(() =>
      createStrategy("patch").strategy.parse(
        "*** Begin Patch\n*** Add File: new.txt\n+one\n*** Delete File: new.txt\n*** End Patch",
        context(repeated),
      ),
    ).toThrow();
  });

  it.each(mutatingFormats)(
    "retains only the completed first %s write on cancellation",
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), `patch-format-${format}-`));
      roots.push(root);
      const { snapshots, resolved } = twoFileBatch(format);
      for (const snapshot of snapshots)
        await writeFile(join(root, snapshot.path), snapshot.content ?? "");
      const files = await FileSystemAdapter.create(root);
      const transaction = await EditTransaction.stage(files, resolved);
      const controller = new AbortController();
      const original = FileSystemAdapter.prototype.writeText;
      vi.spyOn(FileSystemAdapter.prototype, "writeText").mockImplementation(
        async function (this: FileSystemAdapter, path, content, options) {
          const result = await original.call(this, path, content, options);
          if (
            (options as { dryRun?: boolean } | undefined)?.dryRun !== true &&
            path === "first.txt"
          )
            controller.abort(new Error("cancelled"));
          return result;
        },
      );

      await expect(transaction.commit(controller.signal)).rejects.toThrow(
        "cancelled",
      );
      await expect(
        readFile(join(root, "first.txt"), "utf8"),
      ).resolves.toContain("new:first");
      await expect(
        readFile(join(root, "second.txt"), "utf8"),
      ).resolves.toContain("old:second");
    },
  );

  it.each(mutatingFormats)(
    "reports a second-write failure after the completed first %s write",
    async (format) => {
      const root = await mkdtemp(
        join(tmpdir(), `patch-format-failure-${format}-`),
      );
      roots.push(root);
      const { snapshots, resolved } = twoFileBatch(format);
      for (const snapshot of snapshots)
        await writeFile(join(root, snapshot.path), snapshot.content ?? "");
      const files = await FileSystemAdapter.create(root);
      const transaction = await EditTransaction.stage(files, resolved);
      const original = FileSystemAdapter.prototype.writeText;
      vi.spyOn(FileSystemAdapter.prototype, "writeText").mockImplementation(
        async function (this: FileSystemAdapter, path, content, options) {
          if (
            (options as { dryRun?: boolean } | undefined)?.dryRun !== true &&
            path === "second.txt"
          )
            throw new Error("injected failure");
          return original.call(this, path, content, options);
        },
      );

      await expect(transaction.commit()).rejects.toThrow("injected failure");
      await expect(
        readFile(join(root, "first.txt"), "utf8"),
      ).resolves.toContain("new:first");
      await expect(
        readFile(join(root, "second.txt"), "utf8"),
      ).resolves.toContain("old:second");
    },
  );
});
