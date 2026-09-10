/**
 * Repository behavior ported from aider/repo.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to use the installed Git CLI with NUL-delimited machine output.
 * Licensed under the Apache License, Version 2.0.
 */

import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  CommitRequestSchema,
  CommitResultSchema,
  DiffResultSchema,
  RepositoryStatusSchema,
  type DiffResult,
  type CommitRequest,
  type CommitResult,
  type RepositoryStatus,
} from "./types.js";

const executeFile = promisify(execFile);

export class GitRepositoryError extends Error {
  override readonly name = "GitRepositoryError";
}

export interface GeneratedCommitRequest {
  readonly paths: readonly string[];
  readonly message?: string;
  readonly generateMessage?: (diff: DiffResult) => string | Promise<string>;
  readonly verify?: boolean;
  readonly attribution?: CommitRequest["attribution"];
}

export interface UndoResult {
  readonly commit: string;
  readonly paths: readonly string[];
}

export interface LastPatchCommit {
  readonly commit: string;
  readonly paths: readonly string[];
  /** Absent only for a repository's first commit, which cannot be undone. */
  readonly parent?: string;
}

export class UndoNotAllowedError extends Error {
  override readonly name = "UndoNotAllowedError";
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

  async #git(
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>> = {},
    literalPathspecs = true,
  ): Promise<string> {
    try {
      const { stdout } = await executeFile(
        "git",
        ["-C", this.root, ...arguments_],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            ...environment,
            GIT_OPTIONAL_LOCKS: "0",
            ...(literalPathspecs ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
          },
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

  async #gitWithInput(
    arguments_: readonly string[],
    input: string,
  ): Promise<string> {
    return new Promise<string>((resolveOutput, rejectOutput) => {
      const child = execFile(
        "git",
        ["-C", this.root, ...arguments_],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout) => {
          if (error === null) {
            resolveOutput(stdout);
            return;
          }
          rejectOutput(
            new GitRepositoryError(
              `Git command failed: git ${arguments_.join(" ")}`,
              { cause: error },
            ),
          );
        },
      );
      child.stdin?.end(input, "utf8");
    });
  }

  async #tryGit(
    arguments_: readonly string[],
    literalPathspecs = true,
  ): Promise<string | undefined> {
    try {
      return await this.#git(arguments_, {}, literalPathspecs);
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
    const trackedPatch = hasHead
      ? await this.#git(["diff", "--no-ext-diff", "HEAD", ...pathspec])
      : `${await this.#git(["diff", "--no-ext-diff", "--cached", ...pathspec])}${await this.#git(["diff", "--no-ext-diff", ...pathspec])}`;
    const status = await this.status();
    const selectedSet = new Set(selected);
    const untrackedPaths = status.untrackedPaths.filter(
      (path) => selected.length === 0 || selectedSet.has(path),
    );
    const untrackedSummary = untrackedPaths
      .map((path) => `Untracked file: ${path}\n`)
      .join("");
    const changed = new Set([
      ...status.stagedPaths,
      ...status.modifiedPaths,
      ...status.untrackedPaths,
    ]);
    return DiffResultSchema.parse({
      patch: `${trackedPatch}${untrackedSummary}`,
      paths: selected.length === 0 ? [...changed].sort() : selected,
    });
  }

  async filterIgnored(paths: readonly string[]): Promise<string[]> {
    const selected = paths.map((path) => this.relativePath(path));
    if (selected.length === 0) return [];
    const aiderIgnore = resolve(this.root, ".aiderignore");
    const arguments_ = ["check-ignore", "--no-index", "-z", "--stdin"];
    try {
      await access(aiderIgnore);
      arguments_.unshift("-c", `core.excludesFile=${aiderIgnore}`);
    } catch {
      // The project has no aider-specific ignore file.
    }
    let output: string;
    try {
      output = await this.#gitWithInput(arguments_, `${selected.join("\0")}\0`);
    } catch (error) {
      const cause =
        error instanceof GitRepositoryError ? error.cause : undefined;
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === 1
      ) {
        return selected;
      }
      throw error;
    }
    const ignored = new Set(nulFields(output));
    return selected.filter((path) => !ignored.has(path));
  }

  async isIgnored(path: string): Promise<boolean> {
    return (await this.filterIgnored([path])).length === 0;
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

  async commit(request: CommitRequest): Promise<CommitResult | undefined> {
    const validated = CommitRequestSchema.parse(request);
    const paths = validated.paths.map((path) => this.relativePath(path));
    const diff = await this.diff(paths);
    if (diff.patch === "") {
      return undefined;
    }
    await this.#git(["add", "--", ...paths]);
    const trailers = [
      validated.attribution?.coAuthor === undefined
        ? undefined
        : `Co-authored-by: ${validated.attribution.coAuthor}`,
      "Patch-Commit: true",
    ].filter((line): line is string => line !== undefined);
    const fullMessage = `${validated.message}\n\n${trailers.join("\n")}`;
    const environment: Record<string, string> = {};
    if (validated.attribution?.authorName !== undefined) {
      environment.GIT_AUTHOR_NAME = validated.attribution.authorName;
    }
    if (validated.attribution?.committerName !== undefined) {
      environment.GIT_COMMITTER_NAME = validated.attribution.committerName;
    }
    await this.#git(
      [
        "commit",
        ...(validated.verify ? [] : ["--no-verify"]),
        "-m",
        fullMessage,
        "--",
        ...paths,
      ],
      environment,
    );
    const commit = (await this.#git(["rev-parse", "HEAD"])).trim();
    return CommitResultSchema.parse({
      commit,
      message: validated.message,
      paths,
    });
  }

  async commitGenerated(
    request: GeneratedCommitRequest,
  ): Promise<CommitResult | undefined> {
    const paths = request.paths.map((path) => this.relativePath(path));
    const diff = await this.diff(paths);
    if (diff.patch === "") {
      return undefined;
    }
    const message =
      request.message ?? (await request.generateMessage?.(diff))?.trim();
    if (!message) {
      throw new GitRepositoryError(
        "A commit message or message generator is required",
      );
    }
    return this.commit({
      paths,
      message,
      verify: request.verify ?? true,
      ...(request.attribution === undefined
        ? {}
        : { attribution: request.attribution }),
    });
  }

  /**
   * Undoes `expected`, which must still be HEAD. The caller owns the commit:
   * pass the commit this session created so an unrelated Patch commit from
   * another session or an earlier run is never reset.
   */
  async undoLastPatchCommit(expected?: string): Promise<UndoResult> {
    const current = await this.lastPatchCommit();
    if (expected !== undefined && expected !== current.commit) {
      throw new UndoNotAllowedError(
        `HEAD is ${current.commit}, not the expected commit ${expected}`,
      );
    }
    if (current.parent === undefined) {
      throw new UndoNotAllowedError(
        `${current.commit} is the first commit in the repository`,
      );
    }
    if (await this.#isPublished(current.commit)) {
      throw new UndoNotAllowedError(
        `${current.commit} has already been pushed to its upstream branch`,
      );
    }

    // Compare-and-swap HEAD so a commit created between the checks above and
    // this reset is never discarded. Keep the unrelated index intact and leave
    // only the undone paths unstaged.
    await this.#git([
      "update-ref",
      "-m",
      `patch: undo ${current.commit}`,
      "HEAD",
      current.parent,
      current.commit,
    ]);
    await this.#git(["reset", "HEAD", "--", ...current.paths]);
    return { commit: current.commit, paths: current.paths };
  }

  async #isPublished(commit: string): Promise<boolean> {
    const upstream = await this.#tryGit([
      "rev-parse",
      "--verify",
      "--quiet",
      "@{upstream}",
    ]);
    if (upstream === undefined) return false;
    return (
      (await this.#tryGit([
        "merge-base",
        "--is-ancestor",
        commit,
        upstream.trim(),
      ])) !== undefined
    );
  }

  async lastPatchCommit(): Promise<LastPatchCommit> {
    const lineage = (
      await this.#git(["rev-list", "--parents", "-n", "1", "HEAD"])
    )
      .trim()
      .split(/\s+/u);
    const commit = lineage[0] ?? "";
    const parents = lineage.slice(1);
    const message = await this.#git(["show", "-s", "--format=%B", "HEAD"]);
    if (!/^Patch-Commit: true$/mu.test(message)) {
      throw new UndoNotAllowedError("HEAD was not created by Patch");
    }
    if (parents.length > 1) {
      throw new UndoNotAllowedError(`${commit} is a merge commit`);
    }
    const paths = nulFields(
      await this.#git([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "HEAD",
      ]),
    );
    return {
      commit,
      paths,
      ...(parents[0] === undefined ? {} : { parent: parents[0] }),
    };
  }
}
