import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitRepository,
  GitRepositoryError,
  UndoNotAllowedError,
} from "../src/index.js";

const executeFile = promisify(execFile);
const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patch-commit-"));
  directories.push(root);
  await executeFile("git", ["init", "--quiet", root]);
  for (const [key, value] of [
    ["user.name", "Original"],
    ["user.email", "original@example.com"],
    ["commit.gpgsign", "false"],
  ] satisfies [string, string][]) {
    await executeFile("git", ["-C", root, "config", key, value]);
  }
  await writeFile(join(root, "selected.txt"), "base\n");
  await writeFile(join(root, "unrelated.txt"), "base\n");
  await executeFile("git", ["-C", root, "add", "."]);
  await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  return { root, git: await GitRepository.open(root) };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("GitRepository commits", () => {
  it("generates and commits only selected paths with attribution, then safely undoes", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "selected.txt"), "selected\n");
    await writeFile(join(root, "unrelated.txt"), "unrelated\n");
    await executeFile("git", ["-C", root, "add", "unrelated.txt"]);
    let generatedFrom = "";

    const result = await git.commitGenerated({
      paths: ["selected.txt"],
      generateMessage: (diff) => {
        generatedFrom = diff.patch;
        return "Generated message";
      },
      attribution: {
        authorName: "Patch Author",
        committerName: "Patch Committer",
        coAuthor: "Model <model@example.com>",
      },
    });

    expect(generatedFrom).toContain("selected");
    expect(result).toMatchObject({
      message: "Generated message",
      paths: ["selected.txt"],
    });
    const show = (
      await executeFile("git", [
        "-C",
        root,
        "show",
        "-s",
        "--format=%an|%cn|%B",
        "HEAD",
      ])
    ).stdout;
    expect(show).toContain("Patch Author|Patch Committer|Generated message");
    expect(show).toContain("Co-authored-by: Model <model@example.com>");
    expect(show).toContain("Patch-Commit: true");
    expect(
      (
        await executeFile("git", [
          "-C",
          root,
          "show",
          "--format=",
          "--name-only",
          "HEAD",
        ])
      ).stdout.trim(),
    ).toBe("selected.txt");
    expect((await git.status()).stagedPaths).toEqual(["unrelated.txt"]);

    await expect(git.undoLastPatchCommit()).resolves.toMatchObject({
      commit: result?.commit,
      paths: ["selected.txt"],
    });
    expect((await git.status()).modifiedPaths).toContain("selected.txt");
    await expect(git.undoLastPatchCommit()).rejects.toBeInstanceOf(
      UndoNotAllowedError,
    );
  });

  it("honors hook verification and permits an explicit no-verify commit", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "selected.txt"), "changed\n");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await executeFile("git", [
      "-C",
      root,
      "config",
      "core.hooksPath",
      ".git/hooks",
    ]);
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await expect(
      git.commit({
        paths: ["selected.txt"],
        message: "verified",
        verify: true,
      }),
    ).rejects.toBeInstanceOf(GitRepositoryError);
    await expect(
      git.commit({ paths: ["selected.txt"], message: "skip", verify: false }),
    ).resolves.toMatchObject({ message: "skip" });
  });

  it("commits an untracked selected path", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "new.txt"), "new\n");

    const result = await git.commitGenerated({
      paths: ["new.txt"],
      generateMessage: (diff) => `Add ${diff.paths.join(", ")}`,
    });

    expect(result).toMatchObject({
      message: "Add new.txt",
      paths: ["new.txt"],
    });
    expect(
      (
        await executeFile("git", [
          "-C",
          root,
          "show",
          "--format=",
          "--name-only",
          "HEAD",
        ])
      ).stdout.trim(),
    ).toBe("new.txt");
  });
});
