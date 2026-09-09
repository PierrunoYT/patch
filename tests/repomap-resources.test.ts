import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertRepoMapResources,
  repoMapGrammarPath,
  repoMapQueryPath,
  type RepoMapLanguage,
} from "../src/context/repomap-resources.js";

const languages: readonly RepoMapLanguage[] = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
];

describe("repository-map resources", () => {
  it.each(languages)(
    "resolves the packaged %s query and grammar",
    async (language) => {
      await expect(assertRepoMapResources(language)).resolves.toBeUndefined();
      await expect(
        readFile(repoMapQueryPath(language), "utf8"),
      ).resolves.toContain("@name.definition.");
      await expect(
        readFile(repoMapGrammarPath(language)),
      ).resolves.not.toHaveLength(0);
    },
  );
});
