import { describe, expect, it } from "vitest";

import { rankRepoMapTags, type RepoMapTag } from "../src/index.js";

const definition = (path: string, name: string, line = 0): RepoMapTag => ({
  path,
  name,
  line,
  kind: "definition",
});
const reference = (path: string, name: string): RepoMapTag => ({
  path,
  name,
  line: 0,
  kind: "reference",
});

describe("repository-map graph ranking", () => {
  it("weights descriptive identifiers above short identifiers", () => {
    const ranked = rankRepoMapTags([
      definition("api.ts", "formatResult"),
      definition("helper.ts", "run"),
      reference("use.ts", "formatResult"),
      reference("use.ts", "run"),
    ]);

    expect(ranked.map(({ tag }) => tag.name)).toEqual(["formatResult", "run"]);
    expect(ranked[0]?.rank).toBeGreaterThan(ranked[1]?.rank ?? 0);
  });

  it("personalizes references from chat files and excludes their definitions", () => {
    const tags = [
      definition("left.ts", "leftName"),
      definition("right.ts", "rightName"),
      reference("chat.ts", "leftName"),
      reference("other.ts", "rightName"),
      definition("chat.ts", "chatDefinition"),
    ];

    const ranked = rankRepoMapTags(tags, { chatPaths: new Set(["chat.ts"]) });

    expect(ranked[0]?.tag.name).toBe("leftName");
    expect(ranked.every(({ tag }) => tag.path !== "chat.ts")).toBe(true);
  });

  it("is deterministic regardless of tag input order", () => {
    const tags = [
      definition("a.ts", "sharedName", 3),
      definition("b.ts", "sharedName", 4),
      reference("use.ts", "sharedName"),
    ];

    expect(rankRepoMapTags(tags)).toEqual(rankRepoMapTags([...tags].reverse()));
  });
});
