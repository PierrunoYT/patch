import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderRepoMap,
  TreeContextRenderer,
  type RankedRepoMapTag,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-map-render-"));
  temporaryDirectories.push(root);
  return root;
}

function ranked(path: string, line: number, rank: number): RankedRepoMapTag {
  return {
    rank,
    tag: { path, line, name: `name${line}`, kind: "definition" },
  };
}

describe("TreeContextRenderer", () => {
  it("shows parent scopes and elides unrelated function bodies", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "scope.py"),
      "class Greeter:\n    def first(self):\n        return 1\n\n    def target(self):\n        return 2\n",
    );

    const output = await (
      await TreeContextRenderer.create(root)
    ).render("scope.py", new Set([4]));

    expect(output).toContain("│class Greeter:");
    expect(output).toContain("│    def target(self):");
    expect(output).not.toContain("def first");
    expect(output).toContain("⋮");
  });
});

describe("renderRepoMap", () => {
  it("selects the largest ranked prefix under the token budget", async () => {
    const root = await fixture();
    await writeFile(join(root, "a.py"), "def alpha():\n    return 1\n");
    await writeFile(join(root, "b.py"), "def beta():\n    return 2\n");
    const countTokens = (text: string): number => text.length;
    const firstOnly = await renderRepoMap({
      root,
      rankedTags: [ranked("a.py", 0, 2), ranked("b.py", 0, 1)],
      otherPaths: ["a.py", "b.py"],
      maxTokens: 35,
      countTokens,
    });

    expect(firstOnly).toContain("a.py:");
    expect(firstOnly).not.toContain("b.py:");
    expect(countTokens(firstOnly)).toBeLessThanOrEqual(35);
  });

  it("lists untagged files and omits chat files", async () => {
    const root = await fixture();
    await writeFile(join(root, "chat.py"), "def chat(): pass\n");
    await writeFile(join(root, "notes.md"), "notes\n");

    const output = await renderRepoMap({
      root,
      rankedTags: [ranked("chat.py", 0, 1)],
      otherPaths: ["chat.py", "notes.md"],
      chatPaths: new Set(["chat.py"]),
      maxTokens: 100,
      countTokens: (text) => text.length,
    });

    expect(output).toContain("notes.md");
    expect(output).not.toContain("chat.py");
  });
});
