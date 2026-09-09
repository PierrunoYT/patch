import type { EditBatch, EditFormat } from "./types.js";
import type { FileSnapshot } from "./resolve.js";

export interface EditStrategyContext {
  readonly editablePaths: readonly string[];
  readonly fence: readonly [string, string];
  readonly files?: readonly FileSnapshot[];
}

export interface EditStrategy {
  readonly format: EditFormat;
  parse(response: string, context: EditStrategyContext): EditBatch;
}
