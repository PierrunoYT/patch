import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import upstream from "../upstream.json" with { type: "json" };
import {
  ALL_FENCES,
  ChatChunks,
  COMMON_PROMPTS,
  EditFormatSchema,
  selectFence,
  type ChatMessage,
} from "../src/index.js";

interface FenceResult {
  fence: [string, string];
  fellBack: boolean;
}

interface UpstreamFixture {
  schemaVersion: number;
  upstream: { repository: string; commit: string };
  configPrecedence: Record<string, string>;
  chatChunks: {
    order: string[];
    withCacheHeaders: ChatMessage[];
    cacheable: ChatMessage[];
  };
  fences: {
    candidates: [string, string][];
    cases: Record<string, FenceResult>;
  };
  promptResources: Record<string, unknown>;
  editFormats: string[];
  searchReplace: { parsed: unknown[]; replacements: Record<string, string> };
  gitDiff: string;
  repoMap: {
    tags: unknown[];
    rankOrder: string[];
    rendered: string;
    normalizedMap: string[];
  };
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
    expect(fixture.schemaVersion).toBe(4);
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
    expect(fixture.repoMap.rendered).toContain("greet");
  });

  it("matches upstream common prompts exactly", () => {
    expect(COMMON_PROMPTS).toEqual(fixture.promptResources);
  });

  it("matches upstream fence order and selection", () => {
    expect(ALL_FENCES).toEqual(fixture.fences.candidates);
    expect(selectFence([])).toEqual(fixture.fences.cases.empty);
    expect(selectFence(["before\n```text\nafter"])).toEqual(
      fixture.fences.cases.tripleBackticks,
    );
    expect(selectFence(["````text"])).toEqual(
      fixture.fences.cases.quadrupleBackticks,
    );
    expect(selectFence(["  ```text"])).toEqual(
      fixture.fences.cases.indentedBackticks,
    );
    expect(selectFence(ALL_FENCES.flat())).toEqual(
      fixture.fences.cases.exhausted,
    );
  });

  it("matches upstream chunk ordering and prompt-cache boundaries", () => {
    const message = (content: string): ChatMessage => ({
      role: "user",
      content,
    });
    const chunks = new ChatChunks({
      system: [message("system")],
      examples: [message("examples")],
      done: [message("done")],
      repo: [message("repo")],
      readonlyFiles: [message("readonly_files")],
      chatFiles: [message("chat_files")],
      current: [message("cur")],
      reminder: [message("reminder")],
    }).withCacheControl();

    expect(chunks.allMessages()).toEqual(fixture.chatChunks.withCacheHeaders);
    expect(chunks.cacheableMessages()).toEqual(fixture.chatChunks.cacheable);
  });
});
