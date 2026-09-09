import type { ResolvedFileOperation } from "./resolve.js";
import type { EditTransaction } from "./transaction.js";

export interface EditPreview {
  readonly operations: readonly ResolvedFileOperation[];
  readonly changedPaths: readonly string[];
}

export interface WriteAuthorizationRequest {
  readonly path: string;
  readonly reason: "new-file" | "out-of-chat";
  readonly operation: ResolvedFileOperation;
}

export interface WriteBoundaryDependencies {
  readonly presentPreview: (preview: EditPreview) => void | Promise<void>;
  readonly authorize: (
    request: WriteAuthorizationRequest,
  ) => boolean | Promise<boolean>;
  readonly isDirty: (path: string) => boolean | Promise<boolean>;
  readonly checkpointDirty: (
    paths: readonly string[],
  ) => string | undefined | Promise<string | undefined>;
}

export interface WriteResult {
  readonly changedPaths: readonly string[];
  readonly checkpoint: string | null;
}

export class WriteAuthorizationError extends Error {
  override readonly name = "WriteAuthorizationError";
  readonly path: string;

  constructor(path: string) {
    super(`Write authorization denied for ${path}`);
    this.path = path;
  }
}

export async function applyAuthorizedEdits(
  transaction: EditTransaction,
  editablePaths: readonly string[],
  dependencies: WriteBoundaryDependencies,
): Promise<WriteResult> {
  const changedPaths = transaction.operations.map(
    (operation) => operation.path,
  );
  const preview = {
    operations: structuredClone(transaction.operations),
    changedPaths: [...changedPaths],
  };
  await dependencies.presentPreview(preview);

  const selected = new Set(editablePaths);
  for (const operation of transaction.operations) {
    const reason =
      operation.kind === "create"
        ? "new-file"
        : selected.has(operation.path)
          ? undefined
          : "out-of-chat";
    if (
      reason !== undefined &&
      !(await dependencies.authorize({
        path: operation.path,
        reason,
        operation: structuredClone(operation),
      }))
    ) {
      throw new WriteAuthorizationError(operation.path);
    }
  }

  const dirtyPaths: string[] = [];
  for (const operation of transaction.operations) {
    if (
      operation.kind !== "create" &&
      (await dependencies.isDirty(operation.path))
    ) {
      dirtyPaths.push(operation.path);
    }
  }
  const checkpoint =
    dirtyPaths.length === 0
      ? undefined
      : await dependencies.checkpointDirty(dirtyPaths);
  await transaction.commit();
  return { changedPaths, checkpoint: checkpoint ?? null };
}
