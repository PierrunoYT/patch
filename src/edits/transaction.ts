import type { FileSystemAdapter } from "../io/filesystem.js";
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
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

  /** Call only after the staged operations have received user authorization. */
  async commit(): Promise<void> {
    if (this.#committed) {
      throw new EditTransactionStateError("An edit transaction commits once");
    }

    // Revalidate the complete batch before the first mutation.
    for (const operation of this.operations) {
      await validateSnapshot(this.#files, operation);
    }
    for (const operation of this.operations) {
      if (operation.kind === "delete") {
        await this.#files.deleteFile(operation.path);
      } else {
        await this.#files.writeText(operation.path, operation.content);
      }
    }
    this.#committed = true;
  }
}
