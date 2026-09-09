import { applySearchReplace } from "./search-replace.js";
import type { EditBatch } from "./types.js";

export interface FileSnapshot {
  readonly path: string;
  /** Null means the path was checked and does not currently contain a file. */
  readonly content: string | null;
}

export interface ResolvedFileChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface ResolvedEditBatch {
  readonly files: readonly ResolvedFileChange[];
  readonly shellCommands: readonly string[];
}

export class EditResolutionError extends Error {
  override readonly name = "EditResolutionError";
  readonly editIndex: number;
  readonly path: string;

  constructor(editIndex: number, path: string, cause: unknown) {
    super(`Unable to resolve edit ${editIndex + 1} for ${path}`, { cause });
    this.editIndex = editIndex;
    this.path = path;
  }
}

export class MissingFileSnapshotError extends Error {
  override readonly name = "MissingFileSnapshotError";

  constructor(path: string) {
    super(`No file snapshot was provided for ${path}`);
  }
}

function snapshotMap(
  snapshots: readonly FileSnapshot[],
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const snapshot of snapshots) {
    if (result.has(snapshot.path)) {
      throw new Error(`Duplicate file snapshot: ${snapshot.path}`);
    }
    result.set(snapshot.path, snapshot.content);
  }
  return result;
}

function requireSnapshot(
  files: ReadonlyMap<string, string | null>,
  path: string,
): string | null {
  if (!files.has(path)) {
    throw new MissingFileSnapshotError(path);
  }
  return files.get(path) ?? null;
}

/**
 * Resolves every proposed edit against isolated file snapshots. This is a pure
 * dry run: it performs no filesystem access and returns nothing on failure.
 */
export function resolveEditBatch(
  batch: EditBatch,
  snapshots: readonly FileSnapshot[],
): ResolvedEditBatch {
  const original = snapshotMap(snapshots);
  const working = new Map(original);
  const touched: string[] = [];
  const markTouched = (path: string) => {
    if (!touched.includes(path)) {
      touched.push(path);
    }
  };

  for (const [index, edit] of batch.edits.entries()) {
    try {
      const current = requireSnapshot(working, edit.path);
      markTouched(edit.path);
      switch (edit.kind) {
        case "create":
          if (current !== null) {
            throw new Error(`Cannot create existing file ${edit.path}`);
          }
          working.set(edit.path, edit.content);
          break;
        case "rewrite":
          working.set(edit.path, edit.content);
          break;
        case "replace":
          working.set(
            edit.path,
            applySearchReplace(
              current ?? "",
              edit.search,
              edit.replacement,
              edit.path,
            ),
          );
          break;
        case "delete":
          if (current === null) {
            throw new Error(`Cannot delete missing file ${edit.path}`);
          }
          working.set(edit.path, null);
          break;
        case "move": {
          if (current !== null) {
            throw new Error(`Cannot move onto existing file ${edit.path}`);
          }
          const source = requireSnapshot(working, edit.fromPath);
          if (source === null) {
            throw new Error(`Cannot move missing file ${edit.fromPath}`);
          }
          markTouched(edit.fromPath);
          working.set(edit.fromPath, null);
          working.set(edit.path, edit.content ?? source);
          break;
        }
      }
    } catch (error) {
      throw new EditResolutionError(index, edit.path, error);
    }
  }

  return {
    files: touched
      .map((path) => ({
        path,
        before: original.get(path) ?? null,
        after: working.get(path) ?? null,
      }))
      .filter((file) => file.before !== file.after),
    shellCommands: [...batch.shellCommands],
  };
}
