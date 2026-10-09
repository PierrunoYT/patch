import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { claudeCapabilities, type Effort } from '@shared/models';
import { appLog } from '../app_log';
import { ANTHROPIC_API_URL } from './endpoints';
import {
  clip,
  MAX_TEXT_CHARS,
  MAX_TOOL_INPUT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  nextState,
  planCompaction,
  summaryNote,
  type CompactionAdapter,
  type CompactionPlan,
  type CompactionState,
} from './compaction';
import { toolInputSchema } from './tool_schema';
import type {
  CompletionClient,
  Conversation,
  SerializedConversation,
  StopReason,
  ToolCall,
  ToolResult,
  TurnRequest,
  TurnResult,
  TurnUsage,
  UserInput,
} from './types';
import { INTERRUPTED_TOOL_RESULT } from './types';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

const MAX_OUTPUT_TOKENS = 64_000;
// A tool input that is not parseable JSON makes finalMessage() reject; the turn is re-issued this many times.
const MAX_JSON_RETRIES = 2;
// Compaction and pause_turn return control mid-turn; the turn is continued this many times at most.
const MAX_CONTINUATIONS = 5;

// The SDK runs in the Electron main process (Node), never in the renderer. baseURL is only overridden in tests.
// Conversations pass 0: the agent loop retries their requests itself and shows each retry in the chat. Background
// calls (chat titles) keep the SDK's silent retries.
// The base URL and credentials are always explicit, so ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or an `ant auth
// login` profile cannot redirect the key or add another credential (#64).
export function createAnthropicClient(apiKey: string, baseURL?: string, maxRetries = 0): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: baseURL || ANTHROPIC_API_URL, maxRetries });
}

export interface AnthropicConversationOptions {
  model: string;
  effort: Effort;
  messages?: MessageParam[];
  compaction?: CompactionState | null;
}

const isToolResult = (block: ContentBlockParam) => block.type === 'tool_result';

// The SDK's message stream rejects with this AnthropicError (no cause) when a tool_use block's streamed input JSON
// does not parse. Other stream failures, such as a dropped socket, are also plain AnthropicErrors but carry a cause.
const isToolInputParseError = (error: unknown) =>
  error instanceof Anthropic.AnthropicError &&
  !(error instanceof Anthropic.APIError) &&
  error.message.startsWith('Unable to parse tool parameter JSON');

// A cut is safe before an assistant message (the user message before it holds the results of the calls it follows)
// and before a user message that answers no tool call. It is never safe before a message of tool results.
const compactionAdapter: CompactionAdapter<MessageParam> = {
  safeCut: (message) =>
    message.role === 'assistant' || typeof message.content === 'string' || !message.content.some(isToolResult),
  describe(message) {
    const blocks: ContentBlockParam[] =
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    return blocks.flatMap((block): string[] => {
      switch (block.type) {
        case 'text':
          return [`${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(block.text, MAX_TEXT_CHARS)}`];
        case 'tool_use':
          return [`Assistant called ${block.name}: ${clip(JSON.stringify(block.input), MAX_TOOL_INPUT_CHARS)}`];
        case 'tool_result': {
          const content =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
          return [`Tool result${block.is_error ? ' (error)' : ''}: ${clip(content, MAX_TOOL_RESULT_CHARS)}`];
        }
        case 'image':
          return ['[image]'];
        default:
          // Thinking and the API's own compaction blocks are not part of what happened.
          return [];
      }
    });
  },
};

// History is append-only: assistant turns are stored exactly as returned (thinking, compaction and fallback
// blocks included) because Claude rejects or ignores edited history. Long chats are shortened by the API's
// server-side compaction instead of by rewriting old messages.
export class AnthropicConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly effort: Effort;
  private readonly messages: MessageParam[];
  private compaction: CompactionState | null;
  private toolNamesHash: number | null = null;
  private lastRequest: Pick<TurnRequest, 'system' | 'tools'> | null = null;
  lastRequestStartedAt?: number;
  private systemHash: number | null = null;

  constructor(
    private readonly client: Anthropic,
    options: AnthropicConversationOptions,
  ) {
    this.model = options.model;
    this.effort = options.effort;
    this.messages = options.messages ?? [];
    this.compaction = options.compaction ?? null;
  }

  planCompaction(): CompactionPlan | null {
    return planCompaction(this.messages, this.compaction, compactionAdapter);
  }

  applyCompaction(summary: string, keepFrom: number): void {
    this.compaction = nextState(this.compaction, this.messages.length, summary, keepFrom);
  }

  // What is sent: the whole history, or the summary followed by the messages from the cut on. The stored messages
  // are never changed; the first kept message is copied when the summary is added to it.
  private requestMessages(): MessageParam[] {
    if (!this.compaction) return this.messages;
    const note: ContentBlockParam = { type: 'text', text: summaryNote(this.compaction.summary) };
    const [first, ...rest] = this.messages.slice(this.compaction.keepFrom);
    if (first?.role !== 'user') return [{ role: 'user', content: [note] }, ...(first ? [first] : []), ...rest];
    const content: ContentBlockParam[] =
      typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
    return [{ role: 'user', content: [note, ...content] }, ...rest];
  }

  addUserMessage(input: UserInput): void {
    // A history saved mid-task can end with tool calls that never got results (an app crash); the API rejects
    // requests until they are closed, so answer them synthetically before appending the new message.
    this.closePendingToolCalls();
    const content: ContentBlockParam[] = [
      ...(input.images ?? []).map((image): ContentBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      })),
      { type: 'text', text: input.text },
    ];
    this.messages.push({ role: 'user', content });
  }

  discardLastUserMessage(): void {
    if (this.messages.at(-1)?.role === 'user') this.messages.pop();
  }

  // All results of one assistant turn go back in a single user message, as the API expects for parallel calls.
  addToolResults(results: ToolResult[]): void {
    const content: ContentBlockParam[] = results.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.id,
      is_error: result.isError || undefined,
      content: [
        ...(result.images ?? []).map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 },
        })),
        { type: 'text' as const, text: result.content || '(no output)' },
      ],
    }));
    this.messages.push({ role: 'user', content });
  }

  hasPendingToolCalls(): boolean {
    const last = this.messages[this.messages.length - 1];
    return (
      last?.role === 'assistant' &&
      Array.isArray(last.content) &&
      last.content.some((block) => block.type === 'tool_use')
    );
  }

  private closePendingToolCalls(): void {
    if (!this.hasPendingToolCalls()) return;
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
    const ids = last.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    this.addToolResults(ids.map((id) => ({ id, content: INTERRUPTED_TOOL_RESULT, isError: true })));
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const text: string[] = [];
    // Continuations belong to this attempt until the entire turn succeeds. They must be sent back to
    // Claude, but must not leak into saved history if a later request fails or is aborted.
    const pending: MessageParam[] = [];
    const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let jsonRetries = 0;
    let continuations = 0;

    this.lastRequest = { system: request.system, tools: request.tools };
    while (true) {
      this.lastRequestStartedAt = Date.now();
      const params = this.buildParams(request);
      params.messages = [...params.messages, ...pending];
      const stream = this.client.beta.messages.stream(params, { signal: request.signal });
      stream.on('text', (delta) => request.callbacks.onText(delta));
      stream.on('thinking', (delta) => request.callbacks.onThinking?.(delta));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (error) {
        // Only an unparseable streamed tool input is re-asked here. Everything else propagates, including a connection
        // dropped mid-stream (the SDK wraps it as a plain AnthropicError), so the agent loop retries it with backoff.
        if (!isToolInputParseError(error) || request.signal.aborted || jsonRetries++ >= MAX_JSON_RETRIES) {
          throw error;
        }
        request.callbacks.onRestart?.();
        continue;
      }

      const requestUsage = this.messageUsage(message.usage);
      usage.inputTokens += requestUsage.inputTokens;
      usage.outputTokens += requestUsage.outputTokens;
      usage.cacheReadTokens += requestUsage.cacheReadTokens;
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (requestUsage.cacheWriteTokens ?? 0);
      if (typeof requestUsage.longContext === 'object') {
        const long =
          typeof usage.longContext === 'object'
            ? usage.longContext
            : {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              };
        long.inputTokens += requestUsage.longContext.inputTokens;
        long.outputTokens += requestUsage.longContext.outputTokens;
        long.cacheReadTokens += requestUsage.longContext.cacheReadTokens;
        long.cacheWriteTokens += requestUsage.longContext.cacheWriteTokens;
        usage.longContext = long;
      }
      pending.push({ role: 'assistant', content: message.content as ContentBlockParam[] });

      for (const block of message.content) {
        if (block.type === 'text') text.push(block.text);
      }

      if (
        (message.stop_reason === 'compaction' || message.stop_reason === 'pause_turn') &&
        continuations < MAX_CONTINUATIONS
      ) {
        continuations++;
        continue;
      }

      const toolCalls: ToolCall[] = message.content
        .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      this.messages.push(...pending);
      this.logCache(request, usage);
      return {
        text: text.join('\n\n'),
        toolCalls,
        stopReason: mapStopReason(message.stop_reason),
        usage,
        contextTokens:
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        refusal:
          message.stop_reason === 'refusal'
            ? (message.stop_details?.explanation ?? 'The model declined to continue this request.')
            : undefined,
      };
    }
  }

  serialize(): SerializedConversation {
    return {
      provider: this.provider,
      model: this.model,
      messages: this.messages,
      ...(this.compaction ? { compaction: this.compaction } : {}),
    };
  }

  // A cache read with no output: the last request again, with max_tokens 0 and without streaming. The API rejects a
  // request that ends with the assistant's reply, so a placeholder user message ends it; it is read but never
  // answered. The breakpoint sits on the reply's last block, the last part the next real request shares, instead of
  // the top-level automatic one, which would key the cache to the placeholder.
  async keepCacheWarm(signal: AbortSignal): Promise<TurnResult['usage'] | null> {
    if (!this.lastRequest || this.hasPendingToolCalls()) return null;
    const params = this.buildParams(this.lastRequest);
    const messages = structuredClone(params.messages);
    const last = messages.at(-1);
    if (last?.role !== 'assistant' || !Array.isArray(last.content)) return null;
    const index = last.content.findLastIndex(
      (block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    );
    if (index < 0) return null;
    last.content[index] = { ...last.content[index], cache_control: { type: 'ephemeral' } } as never;
    messages.push({ role: 'user', content: 'keep-alive' });
    const { cache_control: _automatic, stream: _stream, ...rest } = params;
    this.lastRequestStartedAt = Date.now();
    const message = await this.client.beta.messages.create(
      { ...rest, messages, max_tokens: 0, stream: false },
      { signal },
    );
    const usage = this.messageUsage(message.usage);
    appLog.info('llm', 'anthropic keep-alive', {
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      input: usage.inputTokens,
    });
    return usage;
  }

  private messageUsage(raw: Anthropic.Beta.BetaUsage): TurnUsage {
    const usage = {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      cacheReadTokens: raw.cache_read_input_tokens ?? 0,
      cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
    };
    const long =
      this.model === 'claude-haiku-5-5' && usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 100_000;
    return { ...usage, ...(long ? { longContext: { ...usage } } : {}) };
  }

  private logCache(request: Pick<TurnRequest, 'system' | 'tools'>, usage: TurnUsage): void {
    const toolNamesHash = hashText(request.tools.map((tool) => tool.name).join('\n'));
    const systemHash = hashText(request.system);
    const toolsChanged = this.toolNamesHash === toolNamesHash ? 0 : 1;
    const systemChanged = this.systemHash === systemHash ? 0 : 1;
    this.toolNamesHash = toolNamesHash;
    this.systemHash = systemHash;
    appLog.info('llm', 'anthropic request', {
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      input: usage.inputTokens,
      output: usage.outputTokens,
      tools: request.tools.length,
      systemChars: request.system.length,
      toolsChanged,
      systemChanged,
    });
  }

  // Exposed for tests.
  buildParams(request: Pick<TurnRequest, 'system' | 'tools'>): Anthropic.Beta.MessageCreateParamsStreaming {
    const capabilities = claudeCapabilities(this.model);
    const betas: Anthropic.Beta.AnthropicBeta[] = [];
    const tools: Array<Anthropic.Beta.BetaTool> = request.tools.map((tool) => {
      const strict = capabilities.strictTools && tool.strictInput && tool.schema && !tool.jsonSchema;
      return {
        name: tool.name,
        description: tool.description,
        // The SDK moves unsupported constraints (e.g. minLength) into descriptions. The agent still
        // validates the original Zod schema, including those constraints, before previewing or running.
        input_schema: strict ? { ...zodOutputFormat(tool.schema!).schema, type: 'object' } : toolInputSchema(tool),
        // Buffer strict inputs for API validation; other tools keep streaming large inputs as generated.
        ...(strict ? { strict: true } : { eager_input_streaming: true }),
      };
    });
    const lastTool = tools.at(-1);
    if (lastTool) lastTool.cache_control = { type: 'ephemeral' };

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: this.requestMessages(),
      tools,
      // Tools and system are the stable prefix; this still caches the growing conversation.
      cache_control: { type: 'ephemeral' },
    };

    if (capabilities.adaptiveThinking) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
      params.output_config = { effort: this.effort };
    }
    if (capabilities.compaction) {
      betas.push('compact-2026-01-12');
      params.context_management = { edits: [{ type: 'compact_20260112' }] };
    }
    if (capabilities.refusalFallback) {
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }
    if (betas.length > 0) {
      params.betas = betas;
    }
    return params;
  }
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mapStopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'model_context_window_exceeded':
      return 'context_exceeded';
    // Only reached once MAX_CONTINUATIONS is used up: the turn is unfinished, not an answer.
    case 'pause_turn':
      return 'paused';
    default:
      return 'other';
  }
}

export class AnthropicCompletionClient implements CompletionClient {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async complete<T extends z.ZodObject<z.ZodRawShape>>(
    prompt: string,
    schema: T,
    signal?: AbortSignal,
  ): Promise<z.infer<T>> {
    const response = await this.client.messages.parse(
      {
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        ...(claudeCapabilities(this.model).adaptiveThinking ? { thinking: { type: 'adaptive' as const } } : {}),
        output_config: {
          format: zodOutputFormat(schema),
          ...(claudeCapabilities(this.model).adaptiveThinking ? { effort: 'low' as const } : {}),
        },
      },
      { signal },
    );
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error('The model did not return a structured answer.');
    }
    return response.parsed_output as z.infer<T>;
  }
}
