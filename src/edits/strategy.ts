import type { EditBatch, EditFormat } from "./types.js";

export interface EditStrategyContext {
  readonly editablePaths: readonly string[];
  readonly fence: readonly [string, string];
}

export interface EditStrategy {
  readonly format: EditFormat;
  parse(response: string, context: EditStrategyContext): EditBatch;
}
