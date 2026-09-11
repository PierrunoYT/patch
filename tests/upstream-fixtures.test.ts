import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import upstream from "../upstream.json" with { type: "json" };
import {
  ALL_FENCES,
  ChatChunks,
  COMMON_PROMPTS,
  EditFormatSchema,
  filterImportantFiles,
  selectFence,
  TagExtractor,
  UnifiedDiffEditStrategy,
  type ChatMessage,
} from "../src/index.js";

interface FenceResult {
  fence: [string, string];
  fellBack: boolean;
}

interface LanguageTag {
  line: number;
  name: string;
  kind: "definition" | "reference";
}

interface LanguageSample {
  source: string;
  tags: LanguageTag[];
}

interface UpstreamFixture {
  schemaVersion: number;
  upstream: { repository: string; commit: string };
  repoMapLanguages: Record<string, LanguageSample>;
  importantFiles: { candidates: string[]; important: string[] };
  unifiedDiff: {
    response: string;
    diffs: { path: string; hunk: string[]; before: string; after: string }[];
    applied: string;
  };
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
    expect(fixture.schemaVersion).toBe(5);
    expect(fixture.upstream).toEqual({
      repository: upstream.repository,
      commit: upstream.commit,
    });
  });

  it("pins a blob hash for every upstream file the fixtures derive from", () => {
    // The exporter refuses a dirty checkout and compares each of these against
    // both the pinned commit and the file on disk. Keeping the list honest here
    // means CI enforces the contract without needing the upstream checkout.
    const sources = Object.entries(upstream.fixtureSources);
    expect(sources.length).toBeGreaterThan(0);
    for (const [path, blob] of sources) {
      expect(path).toMatch(/^aider\/[\w/]+\.py$/u);
      expect(blob).toMatch(/^[0-9a-f]{40}$/u);
    }
    // Every module the fixture driver imports must be pinned, or a fixture can
    // change without any recorded hash changing.
    expect(sources.map(([path]) => path)).toEqual(
      [
        "aider/args.py",
        "aider/coders/base_coder.py",
        "aider/coders/base_prompts.py",
        "aider/coders/chat_chunks.py",
        "aider/coders/editblock_coder.py",
        "aider/io.py",
        "aider/models.py",
        "aider/repo.py",
        "aider/repomap.py",
      ].sort(),
    );
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

  it("selects the same important root files upstream does", () => {
    expect(filterImportantFiles(fixture.importantFiles.candidates)).toEqual(
      fixture.importantFiles.important,
    );
  });

  it("extracts the same tags upstream does for every shipped language", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-language-golden-"));
    try {
      const samples = Object.entries(fixture.repoMapLanguages);
      // Every language Patch ships a grammar for is pinned against upstream's
      // own extractor, so a grammar or query that drifts fails here instead of
      // quietly ranking different symbols in production maps.
      expect(samples.length).toBe(11);
      for (const [name, { source }] of samples) {
        await writeFile(join(root, name), source);
      }
      const extractor = await TagExtractor.create(root);
      for (const [name, { tags }] of samples) {
        const extracted = (await extractor.extract(name))
          .map(({ line, name: symbol, kind }) => ({ kind, line, name: symbol }))
          .sort(
            (left, right) =>
              left.line - right.line ||
              left.kind.localeCompare(right.kind) ||
              left.name.localeCompare(right.name),
          );
        // Keyed so a failure names the language instead of a bare array diff.
        expect({ [name]: extracted }).toEqual({ [name]: tags });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses the same unified-diff hunks upstream does, and retargets where upstream does not", () => {
    const parsed = new UnifiedDiffEditStrategy().parse(
      fixture.unifiedDiff.response,
      { editablePaths: [], fence: ["```", "```"] },
    );
    const expected = fixture.unifiedDiff.diffs;
    expect(parsed.edits).toHaveLength(expected.length);
    for (const [index, hunk] of expected.entries()) {
      const edit = parsed.edits[index];
      expect(edit?.kind).toBe("replace");
      if (edit?.kind !== "replace") continue;
      expect(edit.search).toBe(hunk.before);
      expect(edit.replacement).toBe(hunk.after);
    }

    // Intentional difference. `process_fenced_block`
    // (aider/coders/udiff_coder.py:337-398) strips `a/`/`b/` prefixes only from
    // the block's leading header pair; a mid-block `--- `/`+++ ` transition
    // keeps the prefix verbatim, so upstream targets a path that does not
    // exist. Patch strips the prefix whenever both headers carry one.
    expect(expected.map(({ path }) => path)).toEqual([
      "first.py",
      "b/second.py",
    ]);
    expect(parsed.edits.map((edit) => edit.path)).toEqual([
      "first.py",
      "second.py",
    ]);
  });
});
