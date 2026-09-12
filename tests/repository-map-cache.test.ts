import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryMap, TagExtractor, repoMapTokens } from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-map-cache-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, "defs.py"), "def first_name():\n    return 1\n");
  await writeFile(join(root, "use.py"), "first_name()\n");
  return root;
}

const countTokens = (text: string): number => Math.ceil(text.length / 4);
const request = {
  chatPaths: [] as string[],
  otherPaths: ["defs.py", "use.py"],
};

describe("RepositoryMap cache", () => {
  it("recovers a corrupt persistent cache and rewrites valid JSON", async () => {
    const root = await fixture();
    await writeFile(join(root, ".cache.json"), "not json");
    const map = await RepositoryMap.create({
      root,
      maxTokens: 100,
      countTokens,
      refresh: "always",
      cacheFile: ".cache.json",
    });

    await expect(map.getMap(request)).resolves.toContain("first_name");
    const cache = await readFile(join(root, ".cache.json"), "utf8");
    expect(() => JSON.parse(cache)).not.toThrow();
  });

  it("reuses content-keyed tags across instances", async () => {
    const root = await fixture();
    const extractor = await TagExtractor.create(root);
    let calls = 0;
    const source = {
      extract: async (path: string) => {
        calls += 1;
        return extractor.extract(path);
      },
    };
    const options = {
      root,
      maxTokens: 100,
      countTokens,
      refresh: "always" as const,
      tagSource: source,
    };

    await (await RepositoryMap.create(options)).getMap(request);
    expect(calls).toBe(2);
    await (await RepositoryMap.create(options)).getMap(request);
    expect(calls).toBe(2);

    const path = join(root, "defs.py");
    const originalTime = (await stat(path)).mtime;
    await writeFile(path, "def other_name():\n    return 2\n");
    await utimes(path, originalTime, originalTime);
    await (await RepositoryMap.create(options)).getMap(request);
    expect(calls).toBe(3);
  });

  it.each([
    { refresh: "manual" as const, stale: true },
    { refresh: "files" as const, stale: true },
    { refresh: "always" as const, stale: false },
    { refresh: "auto" as const, stale: true },
  ])("implements $refresh refresh behavior", async ({ refresh, stale }) => {
    const root = await fixture();
    const map = await RepositoryMap.create({
      root,
      maxTokens: 100,
      countTokens,
      refresh,
      autoCacheThresholdMs: -1,
    });
    const first = await map.getMap(request);
    await writeFile(
      join(root, "defs.py"),
      "def second_name():\n    return 2\n",
    );
    await writeFile(join(root, "use.py"), "second_name()\n");

    const second = await map.getMap(request);
    expect(second === first).toBe(stale);
    const forced = await map.getMap({ ...request, forceRefresh: true });
    expect(forced).toContain("second_name");
  });

  it("discards tags cached by a different extractor fingerprint", async () => {
    const root = await fixture();
    const extractor = await TagExtractor.create(root);
    let calls = 0;
    const source = (fingerprint: string) => ({
      fingerprint,
      extract: async (path: string) => {
        calls += 1;
        return extractor.extract(path);
      },
    });
    const options = (fingerprint: string) => ({
      root,
      maxTokens: 100,
      countTokens,
      refresh: "always" as const,
      tagSource: source(fingerprint),
    });

    await (await RepositoryMap.create(options("queries-v1"))).getMap(request);
    expect(calls).toBe(2);
    // The same fingerprint reuses the persisted tags.
    await (await RepositoryMap.create(options("queries-v1"))).getMap(request);
    expect(calls).toBe(2);
    // A changed query or grammar would read the same content differently, so
    // those tags cannot be reused.
    await (await RepositoryMap.create(options("queries-v2"))).getMap(request);
    expect(calls).toBe(4);
  });

  it("sizes the budget from the model's context window", () => {
    // A larger window earns a larger map, within fixed bounds.
    expect(repoMapTokens(undefined)).toBe(1024);
    expect(repoMapTokens(4000)).toBe(1024);
    expect(repoMapTokens(32000)).toBe(4000);
    expect(repoMapTokens(128000)).toBe(4096);
  });

  it("widens the budget when nothing is in the chat", async () => {
    const root = await fixture();
    await writeFile(join(root, "held.py"), "def held_name():\n    return 3\n");
    const map = await RepositoryMap.create({
      root,
      // Small enough that the base budget truncates this fixture and the
      // widened one (2 * 8) does not.
      maxTokens: 2,
      maxContextWindow: 5000,
      refresh: "always",
      countTokens,
    });
    const otherPaths = ["defs.py", "use.py"];

    // With nothing in the chat there is room for a wider view of the repo.
    const wide = await map.getMap({ chatPaths: [], otherPaths });
    const narrow = await map.getMap({ chatPaths: ["held.py"], otherPaths });

    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(map.maxContextWindow).toBe(5000);
  });

  it("isolates tracked paths it cannot read and keeps the rest of the map", async () => {
    const root = await fixture();
    const map = await RepositoryMap.create({
      root,
      maxTokens: 100,
      countTokens,
      refresh: "files",
    });

    // A path Git still tracks but that is no longer readable must not fail the
    // turn that asked for the map.
    const rendered = await map.getMap({
      chatPaths: [],
      otherPaths: ["defs.py", "use.py", "deleted.py"],
    });

    expect(rendered).toContain("first_name");
    expect(map.skippedPaths).toEqual(["deleted.py"]);

    await writeFile(
      join(root, "deleted.py"),
      "def third_name():\n    return 3\n",
    );
    const recovered = await map.getMap({
      chatPaths: [],
      otherPaths: ["defs.py", "use.py", "deleted.py"],
      forceRefresh: true,
    });
    expect(recovered).toContain("third_name");
    expect(map.skippedPaths).toEqual([]);
  });

  it("isolates a path that disappears after it was tagged", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "gone.py"),
      "def vanishing_name():\n    return 2\n",
    );
    // Rendering happens repeatedly while the map is fitted to its budget, so
    // removing the file from the first measurement lands between tagging, which
    // already read it, and a later render, which cannot.
    let measured = 0;
    const map = await RepositoryMap.create({
      root,
      maxTokens: 100,
      refresh: "files",
      countTokens: (text) => {
        if (measured++ === 0) rmSync(join(root, "gone.py"));
        return Math.ceil(text.length / 4);
      },
    });

    const rendered = await map.getMap({
      chatPaths: [],
      otherPaths: ["defs.py", "use.py", "gone.py"],
    });

    // The turn asked for advisory context, so losing one file drops that file
    // rather than the map — and rather than the turn.
    expect(rendered).toContain("first_name");
    expect(map.skippedPaths).toEqual(["gone.py"]);
  });
});
