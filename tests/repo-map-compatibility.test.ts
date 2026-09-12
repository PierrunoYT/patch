import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import upstreamFixture from "./fixtures/upstream/aider-5dc9490b.json" with { type: "json" };
import {
  rankRepoMapTags,
  RepositoryMap,
  TagExtractor,
  type RepoMapTag,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-map-compat-"));
  temporaryDirectories.push(root);
  await writeFile(
    join(root, "definitions.py"),
    'def greet(name):\n    return f"Hello {name}"\n\ndef farewell(name):\n    return f"Goodbye {name}"\n',
  );
  await writeFile(
    join(root, "usage.py"),
    'from definitions import farewell, greet\n\nprint(greet("Ada"))\nprint(greet("Grace"))\nprint(farewell("Linus"))\n',
  );
  return root;
}

function normalizeMap(rendered: string): string[] {
  return rendered
    .split("\n")
    .filter((line) => line.trim() && line.trim() !== "⋮")
    .map((line) => line.replace(/^│/u, "").trimEnd());
}

describe("pinned upstream repository-map compatibility", () => {
  it("matches normalized tags and definition rank order", async () => {
    const root = await fixture();
    const extractor = await TagExtractor.create(root);
    const tags: RepoMapTag[] = [];
    for (const path of ["definitions.py", "usage.py"]) {
      tags.push(...(await extractor.extract(path)));
    }

    const normalizedTags = [...tags]
      .filter((tag) => tag.line >= 0)
      .sort((left, right) =>
        `${left.kind}\0${left.line}\0${left.name}\0${left.path}`.localeCompare(
          `${right.kind}\0${right.line}\0${right.name}\0${right.path}`,
        ),
      );
    expect(normalizedTags).toEqual(upstreamFixture.repoMap.tags);
    expect(
      rankRepoMapTags(tags).map(
        ({ tag }) => `${tag.path}:${tag.name}:${tag.line}`,
      ),
    ).toEqual(upstreamFixture.repoMap.rankOrder);
  });

  it("matches normalized rendered context within its budget", async () => {
    const root = await fixture();
    const map = await RepositoryMap.create({
      root,
      maxTokens: 512,
      countTokens: (text) => Math.ceil(text.length / 4),
      refresh: "always",
    });
    const rendered = await map.getMap({
      chatPaths: [],
      otherPaths: ["definitions.py", "usage.py"],
    });

    expect(normalizeMap(rendered)).toEqual(
      upstreamFixture.repoMap.normalizedMap,
    );
    expect(Math.ceil(rendered.length / 4)).toBeLessThanOrEqual(512);
  });

  it("renders a definition ranked by a lexical fallback reference", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "target.ts"),
      "export function uncommonTarget(): number { return 1; }\n",
    );
    await writeFile(
      join(root, "notes.md"),
      "The uncommonTarget implementation needs review.\n",
    );
    const map = await RepositoryMap.create({
      root,
      maxTokens: 512,
      countTokens: (text) => Math.ceil(text.length / 4),
      refresh: "always",
    });

    const rendered = await map.getMap({
      chatPaths: ["notes.md"],
      otherPaths: ["target.ts"],
    });

    expect(rendered).toContain("target.ts:");
    expect(rendered).toContain("uncommonTarget");
    expect(rendered).not.toContain("notes.md");
  });
});
