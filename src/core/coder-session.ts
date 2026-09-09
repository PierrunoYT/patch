/**
 * Session ownership adapted from aider/coders/base_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to use injected provider and EditStrategy contracts instead of a
 * subclass for each complete coder mode.
 */

import { resolveEditBatch, type FileSnapshot } from "../edits/resolve.js";
import type { EditStrategy } from "../edits/strategy.js";
import { EditTransaction } from "../edits/transaction.js";
import { EditBatchSchema, type EditBatch } from "../edits/types.js";
import type { FileSystemAdapter } from "../io/filesystem.js";
import type { ModelProvider } from "../providers/events.js";
import { ChatMessageSchema, type ChatMessage } from "./messages.js";
import {
  SessionConfigSchema,
  SessionStateSchema,
  type SessionConfig,
  type SessionState,
} from "./session.js";

export interface CoderSessionOptions {
  readonly config: unknown;
  readonly provider: ModelProvider;
  readonly strategy: EditStrategy;
  readonly editablePaths?: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  readonly messages?: readonly ChatMessage[];
  readonly fence?: readonly [string, string];
}

export class CoderSession {
  readonly config: SessionConfig;
  readonly provider: ModelProvider;
  readonly strategy: EditStrategy;
  readonly fence: readonly [string, string];
  readonly #initialState: SessionState;

  constructor(options: CoderSessionOptions) {
    this.config = SessionConfigSchema.parse(options.config);
    this.provider = options.provider;
    this.strategy = options.strategy;
    this.fence = [...(options.fence ?? ["```", "```"])];
    this.#initialState = SessionStateSchema.parse({
      config: this.config,
      phase: "waiting",
      messages: (options.messages ?? []).map((message) =>
        ChatMessageSchema.parse(message),
      ),
      editablePaths: [...(options.editablePaths ?? [])],
      readOnlyPaths: [...(options.readOnlyPaths ?? [])],
      pendingEdits: [],
      partialResponse: "",
      reflectionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      lastPatchCommit: null,
    });
  }

  snapshot(): SessionState {
    return structuredClone(this.#initialState);
  }

  parseResponse(response: string): EditBatch {
    return EditBatchSchema.parse(
      this.strategy.parse(response, {
        editablePaths: this.#initialState.editablePaths,
        fence: this.fence,
      }),
    );
  }

  resolveResponse(response: string, snapshots: readonly FileSnapshot[]) {
    return resolveEditBatch(this.parseResponse(response), snapshots);
  }

  async stageResponse(
    response: string,
    snapshots: readonly FileSnapshot[],
    files: FileSystemAdapter,
  ): Promise<EditTransaction> {
    return EditTransaction.stage(
      files,
      this.resolveResponse(response, snapshots),
    );
  }
}
