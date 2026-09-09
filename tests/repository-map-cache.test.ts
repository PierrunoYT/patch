import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryMap, TagExtractor } from "../src/index.js";

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
});
