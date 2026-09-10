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
    return (await this.#tryGit(arguments_, false)) !== undefined;
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

  async undoLastPatchCommit(): Promise<UndoResult> {
    const current = await this.lastPatchCommit();
    // Keep the unrelated index intact; leave only the undone paths unstaged.
    await this.#git(["reset", "--soft", "HEAD^"]);
    await this.#git(["reset", "HEAD", "--", ...current.paths]);
    return current;
  }

  async lastPatchCommit(): Promise<LastPatchCommit> {
    const commit = (await this.#git(["rev-parse", "HEAD"])).trim();
    const message = await this.#git(["show", "-s", "--format=%B", "HEAD"]);
    if (!/^Patch-Commit: true$/mu.test(message)) {
      throw new UndoNotAllowedError("HEAD was not created by Patch");
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
    return { commit, paths };
  }
}
