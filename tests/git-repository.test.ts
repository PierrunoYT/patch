import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitRepository, GitRepositoryError } from "../src/index.js";

const executeFile = promisify(execFile);
const directories: string[] = [];

async function repository(commit = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-git-"));
  directories.push(root);
  await executeFile("git", ["init", "--quiet", root]);
  await executeFile("git", ["-C", root, "config", "user.name", "Test"]);
  await executeFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await executeFile("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  if (commit) {
    await writeFile(join(root, "staged.txt"), "base staged\n");
    await writeFile(join(root, "working.txt"), "base working\n");
    await writeFile(join(root, "space name.txt"), "base\n");
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("GitRepository", () => {
  it("reports NUL-delimited staged, modified, tracked, untracked, and ignored paths", async () => {
    const root = await repository();
    await writeFile(join(root, "staged.txt"), "staged change\n");
    await executeFile("git", ["-C", root, "add", "staged.txt"]);
    await writeFile(join(root, "working.txt"), "working change\n");
    await writeFile(join(root, "new file.txt"), "new\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, ".aiderignore"), "secret.txt\n");
    const git = await GitRepository.open(root);

    const status = await git.status();

    expect(status.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(status.branch).toBeTruthy();
    expect(status.trackedPaths).toContain("space name.txt");
    expect(status.stagedPaths).toEqual(["staged.txt"]);
    expect(status.modifiedPaths).toEqual(["working.txt"]);
    expect(status.untrackedPaths).toEqual([
      ".aiderignore",
      ".gitignore",
      "new file.txt",
    ]);
    await expect(git.isIgnored("ignored.txt")).resolves.toBe(true);
    await expect(git.isIgnored("secret.txt")).resolves.toBe(true);
    await expect(git.isDirty("working.txt")).resolves.toBe(true);
    await expect(git.diff()).resolves.toMatchObject({
      patch: expect.stringMatching(/staged change[\s\S]*working change/u),
      paths: expect.arrayContaining([
        "staged.txt",
        "working.txt",
        "new file.txt",
      ]),
    });
    expect(() => git.relativePath("../outside")).toThrow(GitRepositoryError);
  });

  it("filters tracked Git and aider ignore matches in one batch", async () => {
    const root = await repository();
    await writeFile(join(root, ".aiderignore"), "private.ts\n");
    await writeFile(join(root, "private.ts"), "private\n");
    await writeFile(join(root, "visible.ts"), "visible\n");
    await executeFile("git", [
      "-C",
      root,
      "add",
      "--force",
      "private.ts",
      "visible.ts",
    ]);
    await executeFile("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "tracked ignore fixture",
    ]);
    const git = await GitRepository.open(root);
    const tracked = (await git.status()).trackedPaths;

    expect(tracked).toEqual(
      expect.arrayContaining(["private.ts", "visible.ts"]),
    );
    await expect(git.filterIgnored(tracked)).resolves.toContain("visible.ts");
    await expect(git.filterIgnored(tracked)).resolves.not.toContain(
      "private.ts",
    );
  });

  it("represents unborn and detached HEAD without guessing a branch", async () => {
    const unbornRoot = await repository(false);
    const unborn = await GitRepository.open(unbornRoot);
    expect(await unborn.status()).toMatchObject({ head: null });

    const detachedRoot = await repository();
    await executeFile("git", [
      "-C",
      detachedRoot,
      "checkout",
      "--quiet",
      "--detach",
    ]);
    const detached = await GitRepository.open(detachedRoot);
    expect(await detached.status()).toMatchObject({
      head: expect.stringMatching(/^[0-9a-f]{40}$/u),
      branch: null,
    });
  });
});
