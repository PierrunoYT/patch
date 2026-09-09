/**
 * Repository behavior ported from aider/repo.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to use the installed Git CLI with NUL-delimited machine output.
 */

import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  DiffResultSchema,
  RepositoryStatusSchema,
  type DiffResult,
  type RepositoryStatus,
} from "./types.js";

const executeFile = promisify(execFile);

export class GitRepositoryError extends Error {
  override readonly name = "GitRepositoryError";
}

function nulFields(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  return fields;
}

export class GitRepository {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<GitRepository> {
    const canonical = await realpath(root);
    const repository = new GitRepository(canonical);
    const topLevel = (
      await repository.#git(["rev-parse", "--show-toplevel"])
    ).trim();
    if ((await realpath(topLevel)) !== canonical) {
      throw new GitRepositoryError(`${root} is not a Git worktree root`);
    }
    return repository;
  }

  async #git(arguments_: readonly string[]): Promise<string> {
    try {
      const { stdout } = await executeFile(
        "git",
        ["-C", this.root, ...arguments_],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
      );
      return stdout;
    } catch (error) {
      throw new GitRepositoryError(
        `Git command failed: git ${arguments_.join(" ")}`,
        { cause: error },
      );
    }
  }

  async #tryGit(arguments_: readonly string[]): Promise<string | undefined> {
    try {
      return await this.#git(arguments_);
    } catch {
      return undefined;
    }
  }

  relativePath(path: string): string {
    const absolute = resolve(this.root, path);
    const result = relative(this.root, absolute);
    if (
      result === "" ||
      result === ".." ||
      result.startsWith(`..${sep}`) ||
      isAbsolute(result)
    ) {
      throw new GitRepositoryError(`Path is outside the Git worktree: ${path}`);
    }
    return result.split(sep).join("/");
  }

  async status(): Promise<RepositoryStatus> {
    const trackedPaths = nulFields(await this.#git(["ls-files", "-z"])).sort();
    const records = nulFields(
      await this.#git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    );
    const staged = new Set<string>();
    const modified = new Set<string>();
    const untracked = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? "";
      const x = record[0] ?? " ";
      const y = record[1] ?? " ";
      const path = record.slice(3);
      if (x === "?" && y === "?") {
        untracked.add(path);
      } else {
        if (x !== " ") staged.add(path);
        if (y !== " ") modified.add(path);
        if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
      }
    }
    const head =
      (await this.#tryGit(["rev-parse", "--verify", "HEAD"]))?.trim() || null;
    const branch =
      (
        await this.#tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"])
      )?.trim() || null;
    return RepositoryStatusSchema.parse({
      root: this.root,
      head,
      branch,
      trackedPaths,
      stagedPaths: [...staged].sort(),
      modifiedPaths: [...modified].sort(),
      untrackedPaths: [...untracked].sort(),
    });
  }

  async diff(paths: string[] = []): Promise<DiffResult> {
    const selected = paths.map((path) => this.relativePath(path));
    const pathspec = selected.length === 0 ? [] : ["--", ...selected];
    const hasHead =
      (await this.#tryGit(["rev-parse", "--verify", "HEAD"])) !== undefined;
    const patch = hasHead
      ? await this.#git(["diff", "--no-ext-diff", "HEAD", ...pathspec])
      : `${await this.#git(["diff", "--no-ext-diff", "--cached", ...pathspec])}${await this.#git(["diff", "--no-ext-diff", ...pathspec])}`;
    const status = await this.status();
    const changed = new Set([
      ...status.stagedPaths,
      ...status.modifiedPaths,
      ...status.untrackedPaths,
    ]);
    return DiffResultSchema.parse({
      patch,
      paths: selected.length === 0 ? [...changed].sort() : selected,
    });
  }

  async isIgnored(path: string): Promise<boolean> {
    const selected = this.relativePath(path);
    const aiderIgnore = resolve(this.root, ".aiderignore");
    const arguments_ = [
      "check-ignore",
      "--no-index",
      "--quiet",
      "--",
      selected,
    ];
    try {
      await access(aiderIgnore);
      arguments_.unshift("-c", `core.excludesFile=${aiderIgnore}`);
    } catch {
      // The project has no aider-specific ignore file.
    }
    return (await this.#tryGit(arguments_)) !== undefined;
  }

  async isDirty(path?: string): Promise<boolean> {
    const status = await this.status();
    if (path === undefined) {
      return (
        status.stagedPaths.length > 0 ||
        status.modifiedPaths.length > 0 ||
        status.untrackedPaths.length > 0
      );
    }
    const selected = this.relativePath(path);
    return [
      ...status.stagedPaths,
      ...status.modifiedPaths,
      ...status.untrackedPaths,
    ].includes(selected);
  }
}
