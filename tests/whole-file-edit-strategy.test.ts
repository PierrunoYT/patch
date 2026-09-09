import { describe, expect, it } from "vitest";

import { WholeFileEditStrategy, WholeFileParseError } from "../src/index.js";

const strategy = new WholeFileEditStrategy();
const fence = ["```", "```"] as const;

describe("WholeFileEditStrategy", () => {
  it("parses explicit decorated filenames and preserves trailing newlines", () => {
    const response = `**src/first.ts**
\`\`\`ts
export const first = 1;
\`\`\`
# src/second.ts
\`\`\`ts
export const second = 2;
\`\`\``;

    expect(
      strategy.parse(response, {
        editablePaths: ["src/first.ts", "src/second.ts"],
        fence,
      }),
    ).toEqual({
      edits: [
        {
          kind: "rewrite",
          path: "src/first.ts",
          content: "export const first = 1;\n",
        },
        {
          kind: "rewrite",
          path: "src/second.ts",
          content: "export const second = 2;\n",
        },
      ],
      shellCommands: [],
    });
  });

  it("preserves a missing trailing newline in an unclosed final block", () => {
    expect(
      strategy.parse("only.txt\n```text\nno newline", {
        editablePaths: ["only.txt"],
        fence,
      }).edits,
    ).toEqual([{ kind: "rewrite", path: "only.txt", content: "no newline" }]);
  });

  it("infers filenames from mentions and a single editable file", () => {
    const mentioned = strategy.parse(
      "I will update `src/a.ts`.\n\n```ts\nconst a = 1;\n```",
      { editablePaths: ["src/a.ts", "src/b.ts"], fence },
    );
    expect(mentioned.edits).toEqual([
      {
        kind: "rewrite",
        path: "src/a.ts",
        content: "const a = 1;\n",
      },
    ]);

    const single = strategy.parse("```ts\nconst only = true;\n```", {
      editablePaths: ["only.ts"],
      fence,
    });
    expect(single.edits[0]).toMatchObject({ path: "only.ts" });
  });

  it("prefers an explicit block filename over weaker duplicate inference", () => {
    const response = `I will update \`file.ts\`.

\`\`\`ts
const weak = true;
\`\`\`
file.ts
\`\`\`ts
const explicit = true;
\`\`\``;

    expect(
      strategy.parse(response, { editablePaths: ["file.ts"], fence }).edits,
    ).toEqual([
      {
        kind: "rewrite",
        path: "file.ts",
        content: "const explicit = true;\n",
      },
    ]);
  });

  it("corrects a common placeholder prefix for root-level files", () => {
    const result = strategy.parse("path/to/index.ts\n```ts\nexport {};\n```", {
      editablePaths: ["index.ts"],
      fence,
    });
    expect(result.edits[0]).toMatchObject({ path: "index.ts" });
  });

  it("supports distinct XML fences and rejects ambiguous unnamed blocks", () => {
    expect(
      strategy.parse("file.ts\n<source>\ntext\n</source>", {
        editablePaths: ["file.ts", "other.ts"],
        fence: ["<source>", "</source>"],
      }).edits,
    ).toEqual([{ kind: "rewrite", path: "file.ts", content: "text\n" }]);

    expect(() =>
      strategy.parse("```ts\ntext\n```", {
        editablePaths: ["first.ts", "second.ts"],
        fence,
      }),
    ).toThrow(WholeFileParseError);
  });
});
