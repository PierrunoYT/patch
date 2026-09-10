import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathOutsideRootError, SafePathResolver } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-safe-path-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SafePathResolver", () => {
  it("canonicalizes the root and resolves existing and missing in-root paths", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    await mkdir(join(root, "source files"), { recursive: true });
    await writeFile(join(root, "source files", "café.ts"), "export {};\n");
    await symlink(root, join(parent, "project-link"), "dir");

    const resolver = await SafePathResolver.create(
      join(parent, "project-link"),
    );

    expect(resolver.root).toBe(await realpath(root));
    await expect(resolver.resolve("source files/café.ts")).resolves.toBe(
      join(resolver.root, "source files", "café.ts"),
    );
    await expect(resolver.resolve("new/nested/file.ts")).resolves.toBe(
      join(resolver.root, "new", "nested", "file.ts"),
    );
    await expect(
      resolver.resolve(join(resolver.root, "source files", "café.ts")),
    ).resolves.toBe(join(resolver.root, "source files", "café.ts"));
  });

  it("allows symlinks whose canonical targets remain inside the root", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "actual"));
    await writeFile(join(root, "actual", "file.ts"), "export {};\n");
    await symlink(join(root, "actual"), join(root, "linked"), "dir");
    const resolver = await SafePathResolver.create(root);

    await expect(resolver.resolve("linked/file.ts")).resolves.toBe(
      join(resolver.root, "actual", "file.ts"),
    );
    await expect(resolver.resolve("linked/new.ts")).resolves.toBe(
      join(resolver.root, "actual", "new.ts"),
    );
  });

  it("rejects traversal and absolute paths outside the root", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    const sibling = join(parent, "project-secret");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(sibling, "secret.txt"), "secret\n");
    const resolver = await SafePathResolver.create(root);

    await expect(
      resolver.resolve("../project-secret/secret.txt"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(
      resolver.resolve("../missing/file.txt"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(
      resolver.resolve(resolve(sibling, "secret.txt")),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it("rejects existing and missing targets reached through an escaping symlink", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "existing.txt"), "outside\n");
    await symlink(outside, join(root, "escape"), "dir");
    const resolver = await SafePathResolver.create(root);

    await expect(
      resolver.resolve("escape/existing.txt"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(resolver.resolve("escape/new.txt")).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });

  it("rejects dangling symlinks instead of treating them as missing files", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    await mkdir(root);
    await symlink(join(parent, "missing-target"), join(root, "dangling"));
    const resolver = await SafePathResolver.create(root);

    await expect(resolver.resolve("dangling")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolves a contained path whose ancestor is not a directory", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "blocked"), "not a directory\n");
    const resolver = await SafePathResolver.create(root);

    // ENOTDIR means the target cannot exist, not that resolution failed: the
    // path stays contained, and only an attempt to create it fails.
    await expect(resolver.resolve("blocked/child.txt")).resolves.toBe(
      join(root, "blocked", "child.txt"),
    );
    await expect(
      resolver.resolve("blocked/../../escape.txt"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it("requires an existing directory as the selected root", async () => {
    const parent = await temporaryDirectory();
    const file = join(parent, "file.txt");
    await writeFile(file, "not a directory\n");

    await expect(SafePathResolver.create(file)).rejects.toThrow(
      "is not a directory",
    );
    await expect(
      SafePathResolver.create(join(parent, "missing")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(SafePathResolver.create("")).rejects.toThrow(
      "cannot be empty",
    );
  });
});
