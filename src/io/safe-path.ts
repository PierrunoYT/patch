import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

/**
 * A path that cannot exist right now. `ENOTDIR` means an ancestor is not a
 * directory, so the target is as absent as an `ENOENT` target and callers that
 * tolerate a missing file must tolerate it identically; a caller that creates
 * the path still fails when it tries to make the parent directory.
 */
export function isMissingPathError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

interface DirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function sameObject(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveExistingAncestor(target: string): Promise<string> {
  let current = target;
  const missingParts: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(current), ...missingParts.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }

      try {
        await lstat(current);
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) {
          throw lstatError;
        }

        const parent = dirname(current);
        if (parent === current) {
          throw error;
        }
        missingParts.push(basename(current));
        current = parent;
        continue;
      }

      // The path exists but cannot be canonicalized, as with a dangling symlink.
      throw error;
    }
  }
}

export class PathOutsideRootError extends Error {
  override readonly name = "PathOutsideRootError";
  readonly root: string;
  readonly target: string;

  constructor(root: string, target: string) {
    super(`Path resolves outside the selected root: ${target}`);
    this.root = root;
    this.target = target;
  }
}

export class PathChangedDuringReadError extends Error {
  override readonly name = "PathChangedDuringReadError";
  readonly target: string;

  constructor(target: string) {
    super(`Path changed while opening a contained read: ${target}`);
    this.target = target;
  }
}

export interface ContainedReadHandle {
  readonly path: string;
  readonly handle: FileHandle;
}

export class SafePathResolver {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<SafePathResolver> {
    if (root.length === 0) {
      throw new TypeError("The selected root cannot be empty");
    }

    const canonicalRoot = await realpath(resolve(root));
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new TypeError(`The selected root is not a directory: ${root}`);
    }

    return new SafePathResolver(canonicalRoot);
  }

  async resolve(target: string): Promise<string> {
    if (target.length === 0) {
      throw new TypeError("A path cannot be empty");
    }

    const absoluteTarget = resolve(this.root, target);
    const canonicalTarget = await resolveExistingAncestor(absoluteTarget);
    if (!isContained(this.root, canonicalTarget)) {
      throw new PathOutsideRootError(this.root, canonicalTarget);
    }

    return canonicalTarget;
  }

  /**
   * Opens a file without consuming bytes until the canonical path, opened
   * object, and every in-root ancestor have been revalidated. Node has no
   * portable openat(2), so retaining a verified handle is the smallest
   * cross-platform way to prevent a pathname swap from redirecting the later
   * read. Callers own and must close the returned handle.
   */
  async openFileForRead(target: string): Promise<ContainedReadHandle> {
    const path = await this.resolve(target);
    const ancestors = await this.#directoryIdentities(path);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const resolvedAgain = await this.resolve(target);
      if (resolvedAgain !== path) throw new PathChangedDuringReadError(target);
      const opened = await handle.stat();
      const current = await stat(path);
      if (!sameObject(opened, current))
        throw new PathChangedDuringReadError(target);
      await this.#assertDirectoryIdentities(ancestors, target);
      return { path, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #directoryIdentities(target: string): Promise<DirectoryIdentity[]> {
    const parent = target === this.root ? this.root : dirname(target);
    if (!isContained(this.root, parent))
      throw new PathOutsideRootError(this.root, target);
    const paths: string[] = [];
    for (let path = parent; ; path = dirname(path)) {
      paths.push(path);
      if (path === this.root) break;
    }
    paths.reverse();
    return Promise.all(
      paths.map(async (path) => {
        const information = await stat(path);
        if (!information.isDirectory())
          throw new PathChangedDuringReadError(target);
        return { path, device: information.dev, inode: information.ino };
      }),
    );
  }

  async #assertDirectoryIdentities(
    expected: readonly DirectoryIdentity[],
    target: string,
  ): Promise<void> {
    for (const identity of expected) {
      const current = await stat(identity.path);
      if (
        !current.isDirectory() ||
        current.dev !== identity.device ||
        current.ino !== identity.inode
      )
        throw new PathChangedDuringReadError(target);
    }
  }
}
