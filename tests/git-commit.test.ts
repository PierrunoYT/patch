import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

    await expect(
      git.undoLastPatchCommit(result?.commit ?? ""),
    ).resolves.toMatchObject({
      commit: result?.commit,
      paths: ["selected.txt"],
    });
    expect((await git.status()).modifiedPaths).toContain("selected.txt");
    await expect(
      git.undoLastPatchCommit(result?.commit ?? ""),
    ).rejects.toBeInstanceOf(UndoNotAllowedError);
  });

  it.each([undefined, null, "", "HEAD"])(
    "refuses undo without an explicit matching commit: %s",
    async (expected) => {
      const { root, git } = await fixture();
      await writeFile(join(root, "selected.txt"), "selected\n");
      await git.commit({
        paths: ["selected.txt"],
        message: "Patch change",
        verify: false,
      });
      await writeFile(join(root, "unrelated.txt"), "staged\n");
      await executeFile("git", ["-C", root, "add", "unrelated.txt"]);
      const before = await git.status();
      const index = (
        await executeFile("git", ["-C", root, "ls-files", "--stage"])
      ).stdout;

      await expect(
        Reflect.apply(
          git.undoLastPatchCommit,
          git,
          expected === undefined ? [] : [expected],
        ),
      ).rejects.toBeInstanceOf(UndoNotAllowedError);
      expect(await git.status()).toEqual(before);
      expect(
        (await executeFile("git", ["-C", root, "ls-files", "--stage"])).stdout,
      ).toBe(index);
      expect(await readFile(join(root, "selected.txt"), "utf8")).toBe(
        "selected\n",
      );
      expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
        "staged\n",
      );
    },
  );

  it("refuses to undo when HEAD is no longer the expected commit", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "selected.txt"), "selected\n");
    const owned = await git.commit({
      paths: ["selected.txt"],
      message: "Patch change",
      verify: false,
    });
    await writeFile(join(root, "unrelated.txt"), "later\n");
    await executeFile("git", ["-C", root, "add", "unrelated.txt"]);
    await executeFile("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "later\n\nPatch-Commit: true",
    ]);
    const head = (
      await executeFile("git", ["-C", root, "rev-parse", "HEAD"])
    ).stdout.trim();

    await expect(
      git.undoLastPatchCommit(owned?.commit ?? ""),
    ).rejects.toBeInstanceOf(UndoNotAllowedError);
    expect(
      (
        await executeFile("git", ["-C", root, "rev-parse", "HEAD"])
      ).stdout.trim(),
    ).toBe(head);
  });

  it("refuses to undo a commit that its upstream branch already contains", async () => {
    const { root, git } = await fixture();
    const remote = await mkdtemp(join(tmpdir(), "patch-remote-"));
    directories.push(remote);
    await executeFile("git", ["init", "--quiet", "--bare", remote]);
    await executeFile("git", ["-C", root, "remote", "add", "origin", remote]);
    const branch = (
      await executeFile("git", ["-C", root, "branch", "--show-current"])
    ).stdout.trim();
    await executeFile("git", [
      "-C",
      root,
      "push",
      "--quiet",
      "-u",
      "origin",
      branch,
    ]);

    await writeFile(join(root, "selected.txt"), "selected\n");
    const owned = await git.commit({
      paths: ["selected.txt"],
      message: "Patch change",
      verify: false,
    });
    await executeFile("git", ["-C", root, "push", "--quiet"]);

    await expect(git.undoLastPatchCommit(owned?.commit ?? "")).rejects.toThrow(
      /already been pushed/,
    );
    expect(
      (
        await executeFile("git", ["-C", root, "rev-parse", "HEAD"])
      ).stdout.trim(),
    ).toBe(owned?.commit);
  });

  it("treats selected paths containing pathspec syntax literally", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "[ab].txt"), "literal base\n");
    await writeFile(join(root, "a.txt"), "matching base\n");
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "pathspec fixture",
    ]);
    await writeFile(join(root, "[ab].txt"), "literal changed\n");
    await writeFile(join(root, "a.txt"), "matching changed\n");

    await expect(
      git.commit({
        paths: ["[ab].txt"],
        message: "literal path",
        verify: false,
      }),
    ).resolves.toMatchObject({ paths: ["[ab].txt"] });

    const committedPaths = (
      await executeFile("git", [
        "-C",
        root,
        "show",
        "--format=",
        "--name-only",
        "HEAD",
      ])
    ).stdout.trim();
    expect(committedPaths).toBe("[ab].txt");
    await expect(git.status()).resolves.toMatchObject({
      modifiedPaths: ["a.txt"],
    });
  });

  it("honors hook verification and permits an explicit no-verify commit", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "selected.txt"), "staged selected\n");
    await executeFile("git", ["-C", root, "add", "selected.txt"]);
    await writeFile(join(root, "selected.txt"), "unstaged selected\n");
    await writeFile(join(root, "unrelated.txt"), "staged unrelated\n");
    await executeFile("git", ["-C", root, "add", "unrelated.txt"]);
    await writeFile(join(root, "unrelated.txt"), "unstaged unrelated\n");
    const indexBefore = (
      await executeFile("git", ["-C", root, "diff", "--cached", "--binary"])
    ).stdout;
    const worktreeBefore = (
      await executeFile("git", ["-C", root, "diff", "--binary"])
    ).stdout;
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
    expect(
      (await executeFile("git", ["-C", root, "diff", "--cached", "--binary"]))
        .stdout,
    ).toBe(indexBefore);
    expect(
      (await executeFile("git", ["-C", root, "diff", "--binary"])).stdout,
    ).toBe(worktreeBefore);
    await expect(
      git.commit({ paths: ["selected.txt"], message: "skip", verify: false }),
    ).resolves.toMatchObject({ message: "skip" });
    expect((await git.status()).stagedPaths).toEqual(["unrelated.txt"]);
  });

  it("restores an untracked selected path to untracked after commit failure", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "new.txt"), "new work\n");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    await executeFile("git", [
      "-C",
      root,
      "config",
      "core.hooksPath",
      ".git/hooks",
    ]);

    await expect(
      git.commit({
        paths: ["new.txt"],
        message: "must fail",
        verify: true,
      }),
    ).rejects.toBeInstanceOf(GitRepositoryError);

    expect(await git.status()).toMatchObject({
      stagedPaths: [],
      untrackedPaths: ["new.txt"],
    });
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new work\n");
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

  it("keeps process identity environment unchanged", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "selected.txt"), "changed\n");
    const originalAuthor = process.env.GIT_AUTHOR_NAME;
    const originalCommitter = process.env.GIT_COMMITTER_NAME;
    process.env.GIT_AUTHOR_NAME = "Parent Author";
    process.env.GIT_COMMITTER_NAME = "Parent Committer";
    try {
      await git.commit({
        paths: ["selected.txt"],
        message: "isolated identity",
        verify: true,
        attribution: {
          authorName: "Child Author",
          committerName: "Child Committer",
        },
      });

      expect(process.env.GIT_AUTHOR_NAME).toBe("Parent Author");
      expect(process.env.GIT_COMMITTER_NAME).toBe("Parent Committer");
      expect(
        (
          await executeFile("git", [
            "-C",
            root,
            "show",
            "-s",
            "--format=%an|%cn",
            "HEAD",
          ])
        ).stdout.trim(),
      ).toBe("Child Author|Child Committer");
    } finally {
      if (originalAuthor === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = originalAuthor;
      if (originalCommitter === undefined)
        delete process.env.GIT_COMMITTER_NAME;
      else process.env.GIT_COMMITTER_NAME = originalCommitter;
    }
  });
});
