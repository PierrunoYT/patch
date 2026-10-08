import type { z } from 'zod';
import type { Provider } from '@shared/models';
import type { CompactionPlan, CompactionState } from './compaction';

export type { CompactionPlan, CompactionState } from './compaction';

export interface ToolSpec {
  name: string;
  description: string;
  // Built-in tools declare a Zod schema; MCP tools arrive with a JSON Schema instead. One of the two is required.
  schema?: z.ZodObject<z.ZodRawShape>;
  jsonSchema?: JsonObjectSchema;
  // Opt in to provider-enforced inputs where supported. Only for built-in Zod schemas.
  strictInput?: boolean;
}

// A JSON Schema for an object-shaped tool input, as the providers expect it.
export interface JsonObjectSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ImageData {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  base64: string;
}

export interface ToolCall {
  id: string;
  name: string;
  // Raw model output. Validate against the tool's schema before use.
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
  images?: ImageData[];
}

export interface UserInput {
  text: string;
  images?: ImageData[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  // A bucket allows a provider turn with continuations to mix short and long requests.
  longContext?:
    boolean | { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'context_exceeded' | 'other';

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TurnUsage;
  // Prompt tokens (including cache reads/writes) of the final request, not aggregate billable usage.
  contextTokens: number;
  // Set when a model's safety system declined; explains why when the API provides it.
  refusal?: string;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onThinking?(delta: string): void;
  // A turn is re-issued (e.g. unparseable tool input); discard what was streamed so far.
  onRestart?(): void;
}

export interface TurnRequest {
  system: string;
  tools: ToolSpec[];
  signal: AbortSignal;
  callbacks: TurnCallbacks;
}

export interface SerializedConversation {
  provider: Provider;
  // OpenAI only: which API the history belongs to. Missing means Chat Completions (chats saved before 'responses').
  api?: 'chat' | 'responses';
  model: string;
  // Always the complete history. A compaction only changes what is sent, never what is stored.
  messages: unknown[];
  compaction?: CompactionState;
}

// One chat's model-facing history, in the provider's native message format. Each provider keeps its own format
// so nothing is lost in translation (Claude thinking and compaction blocks must be sent back unchanged).
export interface Conversation {
  readonly provider: Provider;
  readonly model: string;
  addUserMessage(input: UserInput): void;
  addToolResults(results: ToolResult[]): void;
  runTurn(request: TurnRequest): Promise<TurnResult>;
  serialize(): SerializedConversation;
  // Older turns as text for a summarizer, or null when there is not enough history to be worth compacting.
  planCompaction(): CompactionPlan | null;
  // From now on the summary is sent in place of the messages before `keepFrom`. Nothing stored is changed.
  applyCompaction(summary: string, keepFrom: number): void;
  // Re-sends the last request without generating anything, so the provider's prompt cache stays alive while the chat
  // is idle. Returns the usage, or null when there is nothing to keep warm. Providers without cache control omit it.
  keepCacheWarm?(signal: AbortSignal): Promise<TurnResult['usage'] | null>;
  // When the last request to the model started (Date.now()), for timing the keep-alive. Unset before the first.
  readonly lastRequestStartedAt?: number;
  // True when the history ends with tool calls that never got their results — a task the app interrupted.
  // addUserMessage() repairs such a history with synthetic results, so the next request is valid again.
  hasPendingToolCalls(): boolean;
}

// Returned to the model for tool calls whose result was never recorded, because the app stopped first. The action
// may already have run (an edit applied, a command finished) and only the result was lost, so the model must check
// before retrying it.
export const INTERRUPTED_TOOL_RESULT =
  "The app stopped before this action's result was recorded; it may or may not have run. Check the current state before retrying it.";

// Structured one-shot calls to the small model (titles, re-ranking).
export interface CompletionClient {
  complete<T extends z.ZodObject<z.ZodRawShape>>(prompt: string, schema: T, signal?: AbortSignal): Promise<z.infer<T>>;
}

export class MissingApiKeyError extends Error {
  constructor(provider: Provider) {
    super(
      provider === 'anthropic'
        ? 'Add your Anthropic API key in Settings to use Claude models.'
        : 'Add your OpenAI API key or sign in with ChatGPT in Settings to use this model.',
    );
    this.name = 'MissingApiKeyError';
  }
}

// The stored ChatGPT refresh token was rejected. The turn must stop and the user must sign in again.
export class ChatGptSignInRequiredError extends Error {
  constructor() {
    super('Sign in with ChatGPT again in Settings to use this model.');
    this.name = 'ChatGptSignInRequiredError';
  }
}
