import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  expandSelection,
  globToRegExp,
  isGlobPattern,
  SafePathResolver,
  SelectionTooLargeError,
} from "../src/index.js";

let resolver: SafePathResolver;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "patch-selection-"));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, ".git", "objects"), { recursive: true });
  await mkdir(join(root, "build"));
  await writeFile(join(root, "README.md"), "readme\n");
  await writeFile(join(root, "src", "one.ts"), "one\n");
  await writeFile(join(root, "src", "two.ts"), "two\n");
  await writeFile(join(root, "src", "notes.md"), "notes\n");
  await writeFile(join(root, "src", "deep", "three.ts"), "three\n");
  await writeFile(join(root, "build", "bundle.js"), "bundle\n");
  await writeFile(join(root, ".git", "objects", "pack"), "internals\n");
  resolver = await SafePathResolver.create(root);
});

describe("glob translation", () => {
  it("keeps a single star inside one segment and lets a double star cross", () => {
    expect(isGlobPattern("src/*.ts")).toBe(true);
    expect(isGlobPattern("src/one.ts")).toBe(false);

    expect(globToRegExp("src/*.ts").test("src/one.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/three.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/deep/three.ts")).toBe(true);
    // `**/` also matches no directory at all.
    expect(globToRegExp("src/**/*.ts").test("src/one.ts")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("src/one.?s").test("src/one.ts")).toBe(true);
    expect(globToRegExp("src/[ot]*.ts").test("src/one.ts")).toBe(true);
    expect(globToRegExp("src/[!o]*.ts").test("src/one.ts")).toBe(false);
    // A dot is literal, not "any character".
    expect(globToRegExp("src/one.ts").test("srcXone.ts")).toBe(false);
    // An unterminated class is a literal bracket.
    expect(globToRegExp("src/[one.ts").test("src/[one.ts")).toBe(true);
  });
});

describe("contained selection expansion", () => {
  it("names one path, expands a directory, and matches a glob", async () => {
    await expect(expandSelection(resolver, ["README.md"])).resolves.toEqual([
      "README.md",
    ]);
    // A path that does not exist yet stays selectable.
    await expect(expandSelection(resolver, ["src/new.ts"])).resolves.toEqual([
      "src/new.ts",
    ]);
    await expect(expandSelection(resolver, ["src"])).resolves.toEqual([
      "src/deep/three.ts",
      "src/notes.md",
      "src/one.ts",
      "src/two.ts",
    ]);
    await expect(expandSelection(resolver, ["src/*.ts"])).resolves.toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
    await expect(expandSelection(resolver, ["**/*.ts"])).resolves.toEqual([
      "src/deep/three.ts",
      "src/one.ts",
      "src/two.ts",
    ]);
    // Repeats collapse instead of selecting a path twice.
    await expect(
      expandSelection(resolver, ["src/one.ts", "src/*.ts"]),
    ).resolves.toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("never leaves the root and never selects repository internals", async () => {
    await expect(expandSelection(resolver, ["../outside"])).rejects.toThrow(
      /outside/u,
    );
    await expect(
      expandSelection(resolver, [join(root, "src", "*.ts")]),
    ).rejects.toThrow(/repository-relative/u);
    // `.git` is skipped even when the pattern would reach it.
    await expect(expandSelection(resolver, ["**/pack"])).rejects.toThrow(
      /No file .* matches/u,
    );
    await expect(expandSelection(resolver, ["."])).resolves.not.toContain(
      ".git/objects/pack",
    );
  });

  it("drops ignored matches, reports a fully ignored expansion, and refuses to name an ignored file", async () => {
    const filterIgnored = async (paths: readonly string[]) =>
      paths.filter((path) => !path.startsWith("build/"));

    await expect(
      expandSelection(resolver, ["."], { filterIgnored }),
    ).resolves.not.toContain("build/bundle.js");
    await expect(
      expandSelection(resolver, ["build"], { filterIgnored }),
    ).rejects.toThrow(/Every file selected by build is ignored/u);
    // Naming one path outright is the caller's decision to report on, not the
    // expander's to silently discard.
    await expect(
      expandSelection(resolver, ["build/bundle.js"], { filterIgnored }),
    ).resolves.toEqual(["build/bundle.js"]);
  });

  it("bounds both the result and the walk", async () => {
    await expect(
      expandSelection(resolver, ["."], { limit: 3 }),
    ).rejects.toThrow(SelectionTooLargeError);
    await expect(
      expandSelection(resolver, ["**/*.ts"], { visitLimit: 2 }),
    ).rejects.toThrow(/directory-entry limit/u);
  });

  it("reports a pattern or directory that selects nothing", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    await expect(expandSelection(resolver, ["src/*.rs"])).rejects.toThrow(
      /No file in the repository matches: src\/\*\.rs/u,
    );
    await expect(expandSelection(resolver, ["empty"])).rejects.toThrow(
      /No file to select under: empty/u,
    );
  });
});
