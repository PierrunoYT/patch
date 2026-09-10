import { lstat, realpath, stat } from "node:fs/promises";
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
}
