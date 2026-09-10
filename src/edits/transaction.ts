import type { FileSystemAdapter } from "../io/filesystem.js";
import { isMissingPathError } from "../io/safe-path.js";
import type { ResolvedEditBatch, ResolvedFileOperation } from "./resolve.js";

export class StaleFileSnapshotError extends Error {
  override readonly name = "StaleFileSnapshotError";

  constructor(path: string) {
    super(`File changed after edit resolution: ${path}`);
  }
}

export class EditTransactionStateError extends Error {
  override readonly name = "EditTransactionStateError";
}

async function readCurrent(
  files: FileSystemAdapter,
  path: string,
): Promise<string | null> {
  try {
    return (await files.readText(path)).content;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function expectedContent(operation: ResolvedFileOperation): string | null {
  return operation.kind === "create" ? null : operation.before;
}

async function validateSnapshot(
  files: FileSystemAdapter,
  operation: ResolvedFileOperation,
): Promise<void> {
  if (
    (await readCurrent(files, operation.path)) !== expectedContent(operation)
  ) {
    throw new StaleFileSnapshotError(operation.path);
  }
}

export class EditTransaction {
  readonly operations: readonly ResolvedFileOperation[];
  readonly shellCommands: readonly string[];
  readonly #files: FileSystemAdapter;
  #committed = false;

  private constructor(files: FileSystemAdapter, batch: ResolvedEditBatch) {
    this.#files = files;
    this.operations = structuredClone(batch.operations);
    this.shellCommands = [...batch.shellCommands];
  }

  static async stage(
    files: FileSystemAdapter,
    batch: ResolvedEditBatch,
  ): Promise<EditTransaction> {
    const transaction = new EditTransaction(files, batch);
    for (const operation of transaction.operations) {
      await validateSnapshot(files, operation);
      if (operation.kind === "delete") {
        await files.deleteFile(operation.path, { dryRun: true });
      } else {
        await files.writeText(operation.path, operation.content, {
          dryRun: true,
        });
      }
    }
    return transaction;
  }

  async validate(): Promise<void> {
    for (const operation of this.operations) {
      await validateSnapshot(this.#files, operation);
    }
  }

  /** Call only after the staged operations have received user authorization. */
  async commit(signal?: AbortSignal): Promise<void> {
    if (this.#committed) {
      throw new EditTransactionStateError("An edit transaction commits once");
    }

    // Revalidate the complete batch before the first mutation.
    await this.validate();

    // Creations and updates run before deletions so a move keeps its source
    // until the destination has been written and synced. A crash or failure
    // between the two phases leaves both paths present rather than neither.
    for (const operation of this.operations) {
      if (operation.kind === "delete") continue;
      signal?.throwIfAborted();
      await this.#files.writeText(operation.path, operation.content);
    }
    for (const operation of this.operations) {
      if (operation.kind !== "delete") continue;
      signal?.throwIfAborted();
      // A destination written above can be the same file on a case-insensitive
      // filesystem, so confirm the source still holds its resolved content.
      await validateSnapshot(this.#files, operation);
      await this.#files.deleteFile(operation.path);
    }
    this.#committed = true;
  }
}
