/**
 * Session ownership adapted from aider/coders/base_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to use injected provider and EditStrategy contracts instead of a
 * subclass for each complete coder mode.
 * Licensed under the Apache License, Version 2.0.
 */

import { resolveEditBatch, type FileSnapshot } from "../edits/resolve.js";
import type { EditStrategy } from "../edits/strategy.js";
import { EditTransaction } from "../edits/transaction.js";
import { EditBatchSchema, type EditBatch } from "../edits/types.js";
import type { FileSystemAdapter } from "../io/filesystem.js";
import {
  ModelSettingsSchema,
  requestTemperature,
  type ModelCapabilities,
} from "../models/settings.js";
import {
  conservativeMessageTokens,
  countMessageTokens,
  type MessageTokenCounter,
} from "../models/token-count.js";
import { reportUsage, type UsageReport } from "../models/usage.js";
import {
  CompletionEventSchema,
  CompletionRequestSchema,
  type CompletionEvent,
  type CompletionRequest,
  type ModelProvider,
} from "../providers/events.js";
import { ChatChunks } from "./chat-chunks.js";
import { findFileMentions } from "./file-mentions.js";
import { cacheablePrefix, keepPromptCacheAlive } from "./prompt-cache.js";
import { ReasoningTagSplitter, removeReasoningContent } from "./reasoning.js";
import {
  ChatMessageSchema,
  type ChatMessage,
  type MessageContent,
} from "./messages.js";
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
  readonly retry?: Partial<RetryPolicy>;
  readonly availablePaths?: readonly string[];
  readonly approvePath?: PathApproval;
  readonly tokenCounter?: MessageTokenCounter;
  /**
   * Replaces completed history once it exceeds the model's
   * `maxChatHistoryTokens`. Without one, long history is left alone.
   */
  readonly summarizeHistory?: (
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>;
  readonly promptCacheKeepalive?: {
    readonly pings: number;
    readonly intervalMs?: number;
  };
}

export interface PathApprovalRequest {
  readonly path: string;
  readonly reason: "user-mention" | "model-edit";
}

export type PathApproval = (
  request: PathApprovalRequest,
) => boolean | Promise<boolean>;

export interface SessionSwitchOptions {
  readonly model: unknown;
  readonly provider: ModelProvider;
  readonly strategy: EditStrategy;
  /** Replaces the fence when the caller reselects one for the new model. */
  readonly fence?: readonly [string, string];
  readonly summarizeHistory?: (
    messages: readonly ChatMessage[],
  ) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>;
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

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunTurnOptions {
  readonly prompt?: TurnPrompt;
  readonly snapshots?: readonly FileSnapshot[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: CompletionEvent) => void;
  readonly checks?: ReflectionChecks;
  /** Application-owned resolution, authorization, writes and post-write checks. */
  readonly lifecycle?: {
    readonly context: () => Promise<{
      prompt: TurnPrompt;
      snapshots: readonly FileSnapshot[];
    }>;
    readonly apply: (candidate: ReflectionCandidate) => Promise<
      | {
          source: "malformed" | "lint" | "test";
          diagnostic: string;
        }
      | undefined
    >;
  };
}

export interface CompletedTurn {
  readonly response: string;
  readonly reasoning: string;
  readonly edits: EditBatch;
  readonly events: readonly CompletionEvent[];
  readonly usage?: UsageReport;
}

export interface ReflectionCandidate {
  readonly response: string;
  readonly reasoning: string;
  readonly edits: EditBatch;
}

export type ReflectionCheck = (
  candidate: ReflectionCandidate,
) => string | undefined | Promise<string | undefined>;

export interface ReflectionChecks {
  readonly lint?: ReflectionCheck;
  readonly test?: ReflectionCheck;
}

export class TokenBudgetExceededError extends Error {
  override readonly name = "TokenBudgetExceededError";

  constructor(tokens: number, maximum: number) {
    super(
      `Prompt needs about ${tokens} tokens but the model limit is ${maximum}`,
    );
  }
}

export class ProviderStreamError extends Error {
  override readonly name: string = "ProviderStreamError";
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export class ContextWindowExceededError extends ProviderStreamError {
  override readonly name = "ContextWindowExceededError";

  constructor(message: string) {
    super("context-window", message);
  }
}

export class TruncatedResponseError extends Error {
  override readonly name = "TruncatedResponseError";
  readonly partialResponse: string;

  constructor(partialResponse: string) {
    super("The provider stopped because the output token limit was reached");
    this.partialResponse = partialResponse;
  }
}

export class TurnCancelledError extends Error {
  override readonly name = "TurnCancelledError";
}

export class ReflectionLimitError extends Error {
  override readonly name = "ReflectionLimitError";
  readonly diagnostic: string;

  constructor(maximum: number, diagnostic: string) {
    super(`Only ${maximum} reflections are allowed`);
    this.diagnostic = diagnostic;
  }
}

export class PathApprovalDeniedError extends Error {
  override readonly name = "PathApprovalDeniedError";
  readonly path: string;

  constructor(path: string) {
    super(`Editing unselected path requires approval: ${path}`);
    this.path = path;
  }
}

export class SessionSwitchError extends Error {
  override readonly name = "SessionSwitchError";
}

function diagnosticMessage(
  source: "malformed" | "lint" | "test",
  text: string,
) {
  const label = source === "malformed" ? "edit format" : source;
  return `The previous response failed ${label} validation. Fix the response using the required edit format.\n\n${text}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineUsage(
  total: UsageReport | undefined,
  current: UsageReport,
): UsageReport {
  if (total === undefined) return current;
  const cost =
    total.cost === null || current.cost === null
      ? null
      : total.cost + current.cost;
  return {
    inputTokens: total.inputTokens + current.inputTokens,
    outputTokens: total.outputTokens + current.outputTokens,
    ...(total.cachedInputTokens === undefined &&
    current.cachedInputTokens === undefined
      ? {}
      : {
          cachedInputTokens:
            (total.cachedInputTokens ?? 0) + (current.cachedInputTokens ?? 0),
        }),
    ...(total.cacheWriteTokens === undefined &&
    current.cacheWriteTokens === undefined
      ? {}
      : {
          cacheWriteTokens:
            (total.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0),
        }),
    cost,
    costSource:
      total.costSource === current.costSource ? total.costSource : "unknown",
  };
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new TurnCancelledError("The session turn was cancelled"),
    );
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      reject(new TurnCancelledError("The session turn was cancelled"));
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export function estimateMessageTokens(
  messages: readonly ChatMessage[],
): number {
  return conservativeMessageTokens(messages);
}

function supportedContent(
  content: MessageContent,
  capabilities: ModelCapabilities,
): MessageContent | null {
  if (typeof content === "string") return content;
  const parts = content.filter(
    (part) =>
      part.type === "text" ||
      (part.type === "image" && capabilities.images) ||
      (part.type === "document" && capabilities.documents),
  );
  return parts.length === 0 ? null : parts;
}

/**
 * Drops media a replacement model cannot accept. History outlives the model that
 * produced it, so an image or PDF part retained across a switch would otherwise be
 * sent to a text-only endpoint and rejected.
 */
function supportedHistory(
  messages: readonly ChatMessage[],
  capabilities: ModelCapabilities,
): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role === "tool" || message.content === null) return [message];
    const content = supportedContent(message.content, capabilities);
    if (content !== null) return [{ ...message, content }];
    return message.role === "assistant" && message.toolCalls !== undefined
      ? [{ ...message, content: null }]
      : [];
  });
}

export class CoderSession {
  #config: SessionConfig;
  #provider: ModelProvider;
  #strategy: EditStrategy;
  #fence: readonly [string, string];
  readonly #retry: RetryPolicy;
  readonly #availablePaths: readonly string[];
  readonly #approvePath: PathApproval | undefined;
  readonly #tokenCounter: MessageTokenCounter;
  readonly #summarizeHistory: CoderSessionOptions["summarizeHistory"];
  readonly #promptCachePings: number;
  readonly #promptCacheIntervalMs: number;
  #promptCacheTimer: ReturnType<typeof setTimeout> | undefined;
  #promptCacheAbort: AbortController | undefined;
  #state: SessionState;
  #nextTurnId = 1;
  #activeTurn: PreparedTurn | undefined;
  #turnMutated = false;

  constructor(options: CoderSessionOptions) {
    this.#config = SessionConfigSchema.parse(options.config);
    this.#provider = options.provider;
    this.#strategy = options.strategy;
    this.#fence = [...(options.fence ?? ["```", "```"])];
    const maxAttempts = options.retry?.maxAttempts ?? 3;
    const initialDelayMs = options.retry?.initialDelayMs ?? 125;
    const maxDelayMs = options.retry?.maxDelayMs ?? 60_000;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new RangeError(
        "Retry attempts must be an integer from 1 through 10",
      );
    }
    if (
      !Number.isInteger(initialDelayMs) ||
      initialDelayMs < 0 ||
      !Number.isInteger(maxDelayMs) ||
      maxDelayMs < 0 ||
      initialDelayMs > maxDelayMs
    ) {
      throw new RangeError("Retry delays must be bounded nonnegative integers");
    }
    this.#retry = {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      sleep: options.retry?.sleep ?? defaultSleep,
    };
    this.#availablePaths = [...(options.availablePaths ?? [])];
    this.#approvePath = options.approvePath;
    this.#tokenCounter =
      options.tokenCounter ??
      ((messages, model) => countMessageTokens(messages, model).tokens);
    this.#summarizeHistory = options.summarizeHistory;
    this.#promptCachePings = options.promptCacheKeepalive?.pings ?? 0;
    this.#promptCacheIntervalMs =
      options.promptCacheKeepalive?.intervalMs ?? 295_000;
    if (
      !Number.isInteger(this.#promptCachePings) ||
      this.#promptCachePings < 0 ||
      this.#promptCachePings > 10 ||
      !Number.isInteger(this.#promptCacheIntervalMs) ||
      this.#promptCacheIntervalMs < 1_000 ||
      this.#promptCacheIntervalMs > 3_600_000
    ) {
      throw new RangeError(
        "Prompt cache keepalive configuration is out of bounds",
      );
    }
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

  get config(): SessionConfig {
    return structuredClone(this.#config);
  }

  get provider(): ModelProvider {
    return this.#provider;
  }

  get strategy(): EditStrategy {
    return this.#strategy;
  }

  get fence(): readonly [string, string] {
    return this.#fence;
  }

  async switch(options: SessionSwitchOptions): Promise<void> {
    if (this.#activeTurn !== undefined) {
      throw new SessionSwitchError("Cannot switch during an active turn");
    }
    const model = ModelSettingsSchema.parse(options.model);
    if (options.strategy.format !== model.editFormat) {
      throw new SessionSwitchError(
        `Strategy format ${options.strategy.format} does not match model format ${model.editFormat}`,
      );
    }

    let messages: readonly ChatMessage[] = this.#state.messages;
    if (model.editFormat !== this.#strategy.format) {
      messages = options.summarizeHistory
        ? [...(await options.summarizeHistory(structuredClone(messages)))]
        : messages.filter((message) => message.role !== "assistant");
    }
    messages = supportedHistory(messages, model.capabilities).map((message) =>
      ChatMessageSchema.parse(message),
    );
    const config = SessionConfigSchema.parse({ ...this.#config, model });
    const state = SessionStateSchema.parse({
      ...this.#state,
      config,
      messages,
      phase: "waiting",
      pendingEdits: [],
      partialResponse: "",
      reflectionCount: 0,
    });
    const fence: readonly [string, string] =
      options.fence === undefined ? this.#fence : [...options.fence];
    this.#cancelPromptCache();
    this.#config = config;
    this.#provider = options.provider;
    this.#strategy = options.strategy;
    this.#fence = fence;
    this.#state = state;
  }

  snapshot(): SessionState {
    return structuredClone(this.#state);
  }

  recordCommit(commit: string): void {
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      lastPatchCommit: commit,
    });
  }

  /** Account for application-owned provider requests without replacing turn usage. */
  recordAuxiliaryCost(cost: number): void {
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      totalCost: this.#state.totalCost + cost,
    });
  }

  recordApplied(commit: string | null = null): void {
    if (this.#activeTurn !== undefined) {
      throw new Error("Cannot record applied edits during an active turn");
    }
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      phase: "waiting",
      pendingEdits: [],
      lastPatchCommit: commit,
    });
  }

  setSelectedPaths(
    editablePaths: readonly string[],
    readOnlyPaths: readonly string[],
  ): void {
    if (this.#activeTurn !== undefined) {
      throw new Error("Cannot change selected paths during an active turn");
    }
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      editablePaths: [...editablePaths],
      readOnlyPaths: [...readOnlyPaths],
      pendingEdits: [],
    });
  }

  /**
   * Appends messages the user supplied outside a turn, such as ingested URL
   * content. They join history exactly as written; nothing in them is parsed as
   * an edit, a command, or an instruction to this session.
   */
  appendMessages(messages: readonly ChatMessage[]): void {
    if (this.#activeTurn !== undefined) {
      throw new Error("Cannot append messages during an active turn");
    }
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      messages: [...this.#state.messages, ...messages],
    });
  }

  clearHistory(): void {
    if (this.#activeTurn !== undefined) {
      throw new Error("Cannot clear history during an active turn");
    }
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      messages: [],
      pendingEdits: [],
      partialResponse: "",
    });
  }

  parseResponse(response: string, files?: readonly FileSnapshot[]): EditBatch {
    return EditBatchSchema.parse(
      this.strategy.parse(response, {
        editablePaths: this.#state.editablePaths,
        fence: this.fence,
        ...(files === undefined ? {} : { files }),
      }),
    );
  }

  resolveResponse(response: string, snapshots: readonly FileSnapshot[]) {
    return resolveEditBatch(this.parseResponse(response, snapshots), snapshots);
  }

  async stageResponse(
    response: string,
    snapshots: readonly FileSnapshot[],
    files: FileSystemAdapter,
  ): Promise<EditTransaction> {
    const parsed = this.parseResponse(response, snapshots);
    await this.#approveEditPaths(parsed);
    return EditTransaction.stage(files, resolveEditBatch(parsed, snapshots));
  }

  async #approveEditPaths(batch: EditBatch): Promise<void> {
    const selected = new Set(this.#state.editablePaths);
    for (const edit of batch.edits) {
      const paths =
        edit.kind === "move" ? [edit.fromPath, edit.path] : [edit.path];
      for (const path of paths) {
        if (selected.has(path)) {
          continue;
        }
        if (
          this.#state.readOnlyPaths.includes(path) ||
          !(await this.#approvePath?.({ path, reason: "model-edit" }))
        ) {
          throw new PathApprovalDeniedError(path);
        }
        selected.add(path);
        this.#state = SessionStateSchema.parse({
          ...this.#state,
          editablePaths: [...this.#state.editablePaths, path],
        });
      }
    }
  }

  async #approveMentionedPaths(userInput: string): Promise<void> {
    const selected = [
      ...this.#state.editablePaths,
      ...this.#state.readOnlyPaths,
    ];
    for (const path of findFileMentions(
      userInput,
      this.#availablePaths.filter((candidate) => !selected.includes(candidate)),
      selected,
    )) {
      if (await this.#approvePath?.({ path, reason: "user-mention" })) {
        this.#state = SessionStateSchema.parse({
          ...this.#state,
          editablePaths: [...this.#state.editablePaths, path],
        });
      }
    }
  }

  /**
   * Marks the active turn as having changed the worktree. A turn that mutated
   * files or created a commit and then failed cannot simply be discarded: the
   * work outlives the turn, so its history has to record it.
   */
  recordTurnMutation(): void {
    this.#turnMutated = true;
  }

  prepareTurn(userInput: string, prompt: TurnPrompt = {}): PreparedTurn {
    if (this.#activeTurn !== undefined) {
      throw new Error("A session turn is already active");
    }
    this.#turnMutated = false;
    const userMessage = ChatMessageSchema.parse({
      role: "user",
      content: userInput,
    });
    const chunks = new ChatChunks({
      system: prompt.system,
      examples: prompt.examples,
      readonlyFiles: prompt.readOnlyFiles,
      repo: prompt.repository,
      done: this.#state.messages,
      chatFiles: prompt.editableFiles,
      current: [userMessage],
      reminder: prompt.reminder,
    });
    const messages = (
      this.#config.model.capabilities.promptCaching
        ? chunks.withCacheControl()
        : chunks
    ).allMessages();
    const inputTokens = this.#tokenCounter(messages, this.#config.model);
    const maximum = this.config.model.maxInputTokens;
    if (maximum !== undefined && inputTokens > maximum) {
      throw new TokenBudgetExceededError(inputTokens, maximum);
    }
    const request = CompletionRequestSchema.parse({
      model: this.config.model.name,
      messages,
      maxOutputTokens: this.config.model.maxOutputTokens,
      extraParameters: this.config.model.extraParameters,
      temperature: requestTemperature(this.config.model),
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

  finalizeTurn(
    turn: PreparedTurn,
    response: string,
    reasoning = "",
    reflectedMessages: readonly ChatMessage[] = [],
    snapshots?: readonly FileSnapshot[],
  ): EditBatch {
    if (this.#activeTurn?.id !== turn.id) {
      throw new Error("Cannot finalize an inactive session turn");
    }
    const parsed = this.parseResponse(response, snapshots);
    const assistantMessage = ChatMessageSchema.parse({
      role: "assistant",
      content: response,
      reasoning: reasoning === "" ? undefined : reasoning,
    });
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      phase: parsed.edits.length > 0 ? "reviewing" : "waiting",
      messages: [
        ...this.#state.messages,
        turn.userMessage,
        ...reflectedMessages,
        assistantMessage,
      ],
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

  /**
   * Replaces completed history with a summary once it outgrows the model's
   * budget. A summarizer that fails leaves history untouched: losing the summary
   * is recoverable, and failing the turn over it is not what the user asked for.
   * An oversized prompt still fails later on the explicit token-budget check.
   */
  async #summarizeLongHistory(signal?: AbortSignal): Promise<void> {
    const summarize = this.#summarizeHistory;
    if (summarize === undefined) return;
    const messages = this.#state.messages;
    if (messages.length === 0) return;
    if (
      this.#tokenCounter(messages, this.#config.model) <=
      this.#config.model.maxChatHistoryTokens
    )
      return;
    let summarized: readonly ChatMessage[];
    try {
      summarized = await summarize(structuredClone(messages), signal);
    } catch {
      return;
    }
    this.#state = SessionStateSchema.parse({
      ...this.#state,
      messages: summarized.map((message) => ChatMessageSchema.parse(message)),
    });
  }

  async runTurn(
    userInput: string,
    options: RunTurnOptions = {},
  ): Promise<CompletedTurn> {
    options.signal?.throwIfAborted();
    await this.#approveMentionedPaths(userInput);
    await this.#summarizeLongHistory(options.signal);
    let context = await options.lifecycle?.context();
    const turn = this.prepareTurn(userInput, context?.prompt ?? options.prompt);
    this.#schedulePromptCache(turn.request);
    const events: CompletionEvent[] = [];
    const reflectedMessages: ChatMessage[] = [];
    let request = turn.request;
    let usage: UsageReport | undefined;
    let responsePrefix = "";
    let reasoningPrefix = "";
    let continuationCount = 0;
    let lastResponse = "";
    let lastReasoning = "";

    try {
      while (true) {
        options.signal?.throwIfAborted();
        let delay = this.#retry.initialDelayMs;
        let retryAfterMs: number | undefined;
        let response = responsePrefix;
        let reasoning = "";
        let continueOutput = false;
        for (
          let attempt = 1;
          attempt <= this.#retry.maxAttempts;
          attempt += 1
        ) {
          let retry = false;
          let finished = false;
          let accountedAttemptCost = 0;
          let attemptUsage: UsageReport | undefined;
          response = responsePrefix;
          reasoning = reasoningPrefix;
          const reasoningTag = this.#config.model.reasoningTag;
          const splitter =
            reasoningTag === undefined
              ? undefined
              : new ReasoningTagSplitter(reasoningTag);

          for await (const rawEvent of this.provider.stream(
            request,
            options.signal,
          )) {
            let event = CompletionEventSchema.parse(rawEvent);
            // A model that reasons inside the content stream is split as it
            // arrives, so the terminal, history, and the edit parser all see the
            // answer alone rather than the tagged text.
            if (splitter !== undefined && event.type === "text-delta") {
              const split = splitter.write(event.text);
              if (split.reasoning !== "") {
                const thought = {
                  type: "reasoning-delta" as const,
                  text: split.reasoning,
                };
                events.push(thought);
                options.onEvent?.(structuredClone(thought));
                reasoning += split.reasoning;
              }
              if (split.content === "") continue;
              event = { type: "text-delta", text: split.content };
            }
            events.push(event);
            options.onEvent?.(structuredClone(event));
            // OpenAI-compatible endpoints deliver final usage in a chunk after
            // the one carrying the finish reason, so the stream is drained past
            // finish. Only usage is still accounted; nothing can extend or
            // invalidate a response that already finished.
            if (finished) {
              if (event.type !== "usage") continue;
            }
            switch (event.type) {
              case "text-delta":
                response += event.text;
                this.#state = SessionStateSchema.parse({
                  ...this.#state,
                  partialResponse: response,
                });
                break;
              case "reasoning-delta":
                reasoning += event.text;
                break;
              case "usage": {
                attemptUsage = reportUsage(this.#config.model, event);
                const reportedCost = attemptUsage.cost ?? 0;
                this.#state = SessionStateSchema.parse({
                  ...this.#state,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  totalCost:
                    this.#state.totalCost +
                    Math.max(0, reportedCost - accountedAttemptCost),
                  lastUsage: attemptUsage,
                });
                accountedAttemptCost = reportedCost;
                break;
              }
              case "error":
                if (event.kind === "context-window") {
                  throw new ContextWindowExceededError(event.message);
                }
                if (event.retryable && attempt < this.#retry.maxAttempts) {
                  retry = true;
                  retryAfterMs = event.retryAfterMs;
                  break;
                }
                throw new ProviderStreamError(event.kind, event.message);
              case "finish":
                finished = true;
                if (event.reason === "cancelled" || options.signal?.aborted) {
                  throw new TurnCancelledError(
                    "The session turn was cancelled",
                  );
                }
                if (event.reason === "length") {
                  if (
                    this.#config.model.capabilities.assistantPrefill &&
                    continuationCount < 3
                  ) {
                    continueOutput = true;
                    break;
                  }
                  throw new TruncatedResponseError(response);
                }
                break;
              case "tool-call-delta":
                break;
            }
            if (retry) {
              break;
            }
          }
          if (splitter !== undefined) {
            const rest = splitter.flush();
            reasoning += rest.reasoning;
            response += rest.content;
            // A closing tag with no opening tag means reasoning began before the
            // first delta. Streaming cannot know that in time to keep it off the
            // screen, so the finished text is checked once more for history and
            // edit parsing, as upstream does.
            response = removeReasoningContent(response, reasoningTag ?? "");
          }

          if (retry) {
            this.#state = SessionStateSchema.parse({
              ...this.#state,
              partialResponse: "",
              outputTokens: 0,
            });
            await this.#retry.sleep(
              Math.min(
                this.#retry.maxDelayMs,
                Math.max(delay, retryAfterMs ?? 0),
              ),
              options.signal,
            );
            delay = Math.min(this.#retry.maxDelayMs, delay * 2);
            retryAfterMs = undefined;
            continue;
          }
          if (!finished) {
            throw new ProviderStreamError(
              "provider",
              "The provider stream ended without a finish event",
            );
          }
          if (attemptUsage !== undefined) {
            usage = combineUsage(usage, attemptUsage);
            this.#state = SessionStateSchema.parse({
              ...this.#state,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              lastUsage: usage,
            });
          }
          break;
        }

        lastResponse = response;
        lastReasoning = reasoning;

        if (continueOutput) {
          continuationCount += 1;
          response = response.trimEnd();
          responsePrefix = response;
          reasoningPrefix = reasoning;
          const previousMessages =
            request.messages.at(-1)?.role === "assistant"
              ? request.messages.slice(0, -1)
              : request.messages;
          request = CompletionRequestSchema.parse({
            ...request,
            messages: [
              ...previousMessages,
              { role: "assistant", content: response },
            ],
          });
          continue;
        }

        let edits: EditBatch | undefined;
        let source: "malformed" | "lint" | "test" | undefined;
        let diagnostic: string | undefined;
        try {
          edits = this.parseResponse(
            response,
            context?.snapshots ?? options.snapshots,
          );
        } catch (error) {
          source = "malformed";
          diagnostic = errorText(error);
        }
        if (edits !== undefined) {
          options.signal?.throwIfAborted();
          const candidate = { response, reasoning, edits };
          if (options.lifecycle !== undefined) {
            const failure = await options.lifecycle.apply(candidate);
            diagnostic = failure?.diagnostic;
            source = failure?.source;
          } else {
            await this.#approveEditPaths(edits);
            if (this.config.autoLint) {
              diagnostic = await options.checks?.lint?.(candidate);
              source = diagnostic === undefined ? undefined : "lint";
            }
            if (diagnostic === undefined && this.config.autoTest) {
              diagnostic = await options.checks?.test?.(candidate);
              source = diagnostic === undefined ? undefined : "test";
            }
          }
        }
        if (diagnostic === undefined || source === undefined) {
          options.signal?.throwIfAborted();
          const finalized = this.finalizeTurn(
            turn,
            response,
            reasoning,
            reflectedMessages,
            context?.snapshots ?? options.snapshots,
          );
          if (options.lifecycle !== undefined)
            this.recordApplied(this.#state.lastPatchCommit);
          return {
            response,
            reasoning,
            edits: finalized,
            events,
            ...(usage === undefined ? {} : { usage }),
          };
        }
        if (this.#state.reflectionCount >= this.config.maxReflections) {
          throw new ReflectionLimitError(
            this.config.maxReflections,
            diagnostic,
          );
        }
        const assistant = ChatMessageSchema.parse({
          role: "assistant",
          content: response,
          reasoning: reasoning === "" ? undefined : reasoning,
        });
        const reflection = ChatMessageSchema.parse({
          role: "user",
          content: diagnosticMessage(source, diagnostic),
        });
        reflectedMessages.push(assistant, reflection);
        responsePrefix = "";
        reasoningPrefix = "";
        continuationCount = 0;
        context = await options.lifecycle?.context();
        const prompt = context?.prompt;
        let chunks =
          prompt === undefined
            ? undefined
            : new ChatChunks({
                system: prompt.system,
                examples: prompt.examples,
                readonlyFiles: prompt.readOnlyFiles,
                repo: prompt.repository,
                done: this.#state.messages,
                chatFiles: prompt.editableFiles,
                current: [turn.userMessage, ...reflectedMessages],
                reminder: prompt.reminder,
              });
        if (this.#config.model.capabilities.promptCaching)
          chunks = chunks?.withCacheControl();
        request = CompletionRequestSchema.parse({
          ...request,
          messages: chunks?.allMessages() ?? [
            ...request.messages,
            assistant,
            reflection,
          ],
        });
        const tokens = this.#tokenCounter(request.messages, this.#config.model);
        const maximum = this.#config.model.maxInputTokens;
        if (maximum !== undefined && tokens > maximum)
          throw new TokenBudgetExceededError(tokens, maximum);
        this.#schedulePromptCache(request);
        this.#state = SessionStateSchema.parse({
          ...this.#state,
          phase: "streaming",
          partialResponse: "",
          inputTokens: tokens,
          outputTokens: 0,
          reflectionCount: this.#state.reflectionCount + 1,
        });
      }
    } catch (error) {
      this.#activeTurn = undefined;
      // Edits that reached the worktree survive the failure, so the turn that
      // produced them stays in history. Discarding it would leave the next turn
      // describing files as unchanged when they are not.
      const reconciled =
        this.#turnMutated && lastResponse !== ""
          ? [
              ...this.#state.messages,
              turn.userMessage,
              ...reflectedMessages,
              ChatMessageSchema.parse({
                role: "assistant",
                content: lastResponse,
                ...(lastReasoning === "" ? {} : { reasoning: lastReasoning }),
              }),
            ]
          : this.#state.messages;
      this.#state = SessionStateSchema.parse({
        ...this.#state,
        phase: "interrupted",
        messages: reconciled,
        pendingEdits: [],
      });
      throw error;
    }
  }

  close(): void {
    this.#cancelPromptCache();
  }

  #cancelPromptCache(): void {
    if (this.#promptCacheTimer !== undefined)
      clearTimeout(this.#promptCacheTimer);
    this.#promptCacheTimer = undefined;
    this.#promptCacheAbort?.abort();
    this.#promptCacheAbort = undefined;
  }

  #schedulePromptCache(request: CompletionRequest): void {
    this.#cancelPromptCache();
    if (
      this.#promptCachePings === 0 ||
      !this.#config.model.capabilities.promptCaching
    )
      return;
    const provider = this.#provider;
    const model = this.#config.model;
    const prefix = cacheablePrefix(request);
    if (prefix === undefined) return;
    const controller = new AbortController();
    this.#promptCacheAbort = controller;
    let remaining = this.#promptCachePings;
    const ping = async () => {
      this.#promptCacheTimer = undefined;
      if (controller.signal.aborted) return;
      remaining -= 1;
      try {
        await keepPromptCacheAlive(
          provider,
          model,
          prefix,
          1,
          controller.signal,
        );
      } catch {
        // A keepalive is an optimization. Foreground turns and diagnostics must
        // not fail or retain provider details when a background refresh fails.
      }
      if (!controller.signal.aborted && remaining > 0) {
        this.#promptCacheTimer = setTimeout(
          () => void ping(),
          this.#promptCacheIntervalMs,
        );
        this.#unrefPromptCacheTimer();
      }
    };
    this.#promptCacheTimer = setTimeout(
      () => void ping(),
      this.#promptCacheIntervalMs,
    );
    this.#unrefPromptCacheTimer();
  }

  #unrefPromptCacheTimer(): void {
    const timer = this.#promptCacheTimer;
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }
}
