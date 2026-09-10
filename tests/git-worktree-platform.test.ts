import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitRepository } from "../src/index.js";

const executeFile = promisify(execFile);

describe("Git worktrees on the host platform", () => {
  it("opens a linked worktree as its own canonical root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "patch-worktree-"));
    const primary = join(parent, "primary");
    const linked = join(parent, "linked");
    await executeFile("git", ["init", "--quiet", primary]);
    await executeFile("git", [
      "-C",
      primary,
      "config",
      "user.name",
      "Patch Test",
    ]);
    await executeFile("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "patch@test.invalid",
    ]);
    await executeFile("git", [
      "-C",
      primary,
      "config",
      "commit.gpgsign",
      "false",
    ]);
    await writeFile(join(primary, "tracked.txt"), "tracked\n");
    await executeFile("git", ["-C", primary, "add", "."]);
    await executeFile("git", [
      "-C",
      primary,
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    await executeFile("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked",
      linked,
    ]);

    const repository = await GitRepository.open(linked);
    expect((await repository.status()).trackedPaths).toEqual(["tracked.txt"]);
    expect(repository.root).toBe(await realpath(linked));
  });
});
