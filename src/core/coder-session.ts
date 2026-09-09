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
import {
  CompletionRequestSchema,
  type CompletionRequest,
  type ModelProvider,
} from "../providers/events.js";
import { ChatChunks } from "./chat-chunks.js";
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

export interface TurnPrompt {
  readonly system?: readonly ChatMessage[];
  readonly examples?: readonly ChatMessage[];
  readonly readOnlyFiles?: readonly ChatMessage[];
  readonly repository?: readonly ChatMessage[];
  readonly editableFiles?: readonly ChatMessage[];
  readonly reminder?: readonly ChatMessage[];
}

export interface PreparedTurn {
  readonly id: number;
  readonly userMessage: ChatMessage;
  readonly request: CompletionRequest;
  readonly inputTokens: number;
}

export class TokenBudgetExceededError extends Error {
  override readonly name = "TokenBudgetExceededError";

  constructor(tokens: number, maximum: number) {
    super(
      `Prompt needs about ${tokens} tokens but the model limit is ${maximum}`,
    );
  }
}

function contentLength(message: ChatMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }
  if (message.content === null) {
    return 0;
  }
  return message.content.reduce(
    (length, part) =>
      length + (part.type === "text" ? part.text.length : part.data.length),
    0,
  );
}

export function estimateMessageTokens(
  messages: readonly ChatMessage[],
): number {
  return messages.reduce(
    (tokens, message) => tokens + 4 + Math.ceil(contentLength(message) / 4),
    0,
  );
}

export class CoderSession {
  readonly config: SessionConfig;
  readonly provider: ModelProvider;
  readonly strategy: EditStrategy;
  readonly fence: readonly [string, string];
  #state: SessionState;
  #nextTurnId = 1;
  #activeTurn: PreparedTurn | undefined;

  constructor(options: CoderSessionOptions) {
    this.config = SessionConfigSchema.parse(options.config);
    this.provider = options.provider;
    this.strategy = options.strategy;
    this.fence = [...(options.fence ?? ["```", "```"])];
    this.#state = SessionStateSchema.parse({
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
    return structuredClone(this.#state);
  }

  parseResponse(response: string): EditBatch {
    return EditBatchSchema.parse(
      this.strategy.parse(response, {
        editablePaths: this.#state.editablePaths,
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

  prepareTurn(userInput: string, prompt: TurnPrompt = {}): PreparedTurn {
    if (this.#activeTurn !== undefined) {
      throw new Error("A session turn is already active");
    }
    const userMessage = ChatMessageSchema.parse({
      role: "user",
      content: userInput,
    });
    const messages = new ChatChunks({
      system: prompt.system,
      examples: prompt.examples,
      readonlyFiles: prompt.readOnlyFiles,
      repo: prompt.repository,
      done: this.#state.messages,
      chatFiles: prompt.editableFiles,
      current: [userMessage],
      reminder: prompt.reminder,
    }).allMessages();
    const inputTokens = estimateMessageTokens(messages);
    const maximum = this.config.model.maxInputTokens;
    if (maximum !== undefined && inputTokens > maximum) {
      throw new TokenBudgetExceededError(inputTokens, maximum);
    }
    const request = CompletionRequestSchema.parse({
      model: this.config.model.name,
      messages,
      maxOutputTokens: this.config.model.maxOutputTokens,
      extraParameters: this.config.model.extraParameters,
    });
    const turn = {
      id: this.#nextTurnId,
      userMessage,
      request,
      inputTokens,
    };
    this.#nextTurnId += 1;
    this.#activeTurn = turn;
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      phase: "streaming",
      pendingEdits: [],
      partialResponse: "",
      reflectionCount: 0,
      inputTokens,
      outputTokens: 0,
    });
    return structuredClone(turn);
  }

  finalizeTurn(turn: PreparedTurn, response: string): EditBatch {
    if (this.#activeTurn?.id !== turn.id) {
      throw new Error("Cannot finalize an inactive session turn");
    }
    const parsed = this.parseResponse(response);
    const assistantMessage = ChatMessageSchema.parse({
      role: "assistant",
      content: response,
    });
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      phase: parsed.edits.length > 0 ? "reviewing" : "waiting",
      messages: [...this.#state.messages, turn.userMessage, assistantMessage],
      pendingEdits: parsed.edits,
      partialResponse: response,
    });
    this.#activeTurn = undefined;
    return parsed;
  }

  abandonTurn(turn: PreparedTurn): void {
    if (this.#activeTurn?.id !== turn.id) {
      throw new Error("Cannot abandon an inactive session turn");
    }
    this.#activeTurn = undefined;
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      phase: "waiting",
      pendingEdits: [],
      partialResponse: "",
    });
  }
}
