import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import upstream from "../upstream.json" with { type: "json" };
import { EditFormatSchema } from "../src/index.js";

interface UpstreamFixture {
  schemaVersion: number;
  upstream: { repository: string; commit: string };
  configPrecedence: Record<string, string>;
  chatChunks: { order: string[] };
  editFormats: string[];
  searchReplace: { parsed: unknown[]; replacements: Record<string, string> };
  gitDiff: string;
  repoMap: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      `fixtures/upstream/aider-${upstream.commit.slice(0, 8)}.json`,
      import.meta.url,
    ),
    "utf8",
  ),
) as UpstreamFixture;

describe("upstream compatibility fixtures", () => {
  it("records the configured aider revision", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.upstream).toEqual({
      repository: upstream.repository,
      commit: upstream.commit,
    });
  });

  it("captures each foundation behavior category", () => {
    expect(fixture.configPrecedence).toEqual({
      configFiles: "cwd-model",
      environment: "environment-model",
      cli: "cli-model",
    });
    expect(fixture.chatChunks.order).toEqual([
      "system",
      "examples",
      "readonly_files",
      "repo",
      "done",
      "chat_files",
      "cur",
      "reminder",
    ]);
    expect([...EditFormatSchema.options].sort()).toEqual(fixture.editFormats);
    expect(fixture.searchReplace.parsed).toHaveLength(2);
    expect(fixture.searchReplace.replacements.exact).toContain("new value");
    expect(fixture.gitDiff).toContain("staged change");
    expect(fixture.gitDiff).toContain("working change");
    expect(fixture.repoMap).toContain("greet");
  });
});
