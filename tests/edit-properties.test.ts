import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  applySearchReplace,
  EditTransaction,
  FileSystemAdapter,
  PathOutsideRootError,
  SearchReplaceAmbiguousError,
  SearchReplaceEditStrategy,
  SearchReplaceParseError,
  WholeFileEditStrategy,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const unicodeText = fc
  .array(fc.constantFrom("a", "Z", "0", " ", "β", "中", "🙂", "é"), {
    maxLength: 20,
  })
  .map((characters) => characters.join(""));
const nonemptyLine = unicodeText.filter((value) => value.trim().length > 0);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-properties-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("edit engine properties", () => {
  it("exactly replaces asymmetric Unicode blocks", () => {
    fc.assert(
      fc.property(unicodeText, unicodeText, unicodeText, (a, b, c) => {
        const whole = `prefix:${a}\nneedle:${b}\nsuffix:${c}\n`;
        const search = `needle:${b}\n`;
        const replacement = `replacement:${c}:${a}\nextra:${b}\n`;

        expect(applySearchReplace(whole, search, replacement)).toBe(
          `prefix:${a}\nreplacement:${c}:${a}\nextra:${b}\nsuffix:${c}\n`,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("preserves CRLF for exact replacements", () => {
    fc.assert(
      fc.property(unicodeText, unicodeText, (before, after) => {
        const whole = `head\r\ntarget:${before}\r\ntail\r\n`;
        expect(
          applySearchReplace(
            whole,
            `target:${before}\r\n`,
            `changed:${after}\r\n`,
          ),
        ).toBe(`head\r\nchanged:${after}\r\ntail\r\n`);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects every repeated exact SEARCH line", () => {
    fc.assert(
      fc.property(nonemptyLine, (line) => {
        expect(() =>
          applySearchReplace(`${line}\n${line}\n`, `${line}\n`, "changed\n"),
        ).toThrow(SearchReplaceAmbiguousError);
      }),
      { numRuns: 100 },
    );
  });

  it("appends Unicode content to empty files", () => {
    fc.assert(
      fc.property(nonemptyLine, (content) => {
        expect(applySearchReplace("", "", content)).toBe(`${content}\n`);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects incomplete valid markers and ignores invalid marker lengths", () => {
    const strategy = new SearchReplaceEditStrategy();
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 9 }),
        nonemptyLine,
        (count, body) => {
          const response = `file.ts\n${"<".repeat(count)} SEARCH\n${body}\n`;
          expect(() =>
            strategy.parse(response, {
              editablePaths: ["file.ts"],
              fence: ["```", "```"],
            }),
          ).toThrow(SearchReplaceParseError);
        },
      ),
      { numRuns: 50 },
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 10, max: 20 }),
        ),
        (count) => {
          const result = strategy.parse(
            `file.ts\n${"<".repeat(count)} SEARCH\nignored\n`,
            { editablePaths: ["file.ts"], fence: ["```", "```"] },
          );
          expect(result.edits).toEqual([]);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("emits one rewrite for duplicate whole-file blocks", () => {
    const strategy = new WholeFileEditStrategy();
    fc.assert(
      fc.property(nonemptyLine, nonemptyLine, (first, second) => {
        const result = strategy.parse(
          `file.ts\n\`\`\`text\n${first}\n\`\`\`\nfile.ts\n\`\`\`text\n${second}\n\`\`\``,
          { editablePaths: ["file.ts"], fence: ["```", "```"] },
        );
        expect(result.edits).toEqual([
          { kind: "rewrite", path: "file.ts", content: `${first}\n` },
        ]);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects generated traversal paths during transaction staging", async () => {
    const root = await temporaryDirectory();
    const files = await FileSystemAdapter.create(root);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.stringMatching(/^[a-z]{1,12}$/),
        async (depth, name) => {
          const path = `${"../".repeat(depth)}outside/${name}.ts`;
          await expect(
            EditTransaction.stage(files, {
              operations: [{ kind: "create", path, content: "unsafe\n" }],
              shellCommands: [],
            }),
          ).rejects.toBeInstanceOf(PathOutsideRootError);
        },
      ),
      { numRuns: 40 },
    );
  });
});
