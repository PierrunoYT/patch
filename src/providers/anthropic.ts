import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { ChatMessage, MessageContent } from "../core/messages.js";
import type {
  CompletionEvent,
  CompletionRequest,
  ModelProvider,
} from "./events.js";
import { responseValidationEvent, transientByStatus } from "./errors.js";

const StreamEventSchema = z
  .object({
    type: z.string(),
    index: z.number().int().nonnegative().optional(),
    message: z
      .object({
        usage: z
          .object({
            input_tokens: z.number().int().nonnegative(),
            cache_read_input_tokens: z.number().int().nonnegative().optional(),
            cache_creation_input_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    content_block: z
      .object({
        type: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    delta: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        thinking: z.string().optional(),
        partial_json: z.string().optional(),
        stop_reason: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    usage: z
      .object({ output_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly timeout?: number;
  readonly defaultHeaders?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

function source(data: string, mediaType: string) {
  return /^(?:https?:)/u.test(data)
    ? { type: "url" as const, url: data }
    : { type: "base64" as const, media_type: mediaType, data };
}

function contentBlocks(content: MessageContent): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part): Anthropic.ContentBlockParam => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
        ...(part.cacheControl === undefined
          ? {}
          : { cache_control: { type: "ephemeral" } }),
      };
    }
    if (part.type === "image") {
      return {
        type: "image",
        source: source(
          part.data,
          part.mediaType,
        ) as Anthropic.ImageBlockParam["source"],
      };
    }
    return {
      type: "document",
      source: source(
        part.data,
        part.mediaType,
      ) as Anthropic.DocumentBlockParam["source"],
    };
  });
}

function anthropicMessage(
  message: ChatMessage,
): Anthropic.MessageParam | undefined {
  if (message.role === "system") {
    return undefined;
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }
  const blocks = message.content === null ? [] : contentBlocks(message.content);
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    blocks.push(
      ...message.toolCalls.map((call): Anthropic.ToolUseBlockParam => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: JSON.parse(call.arguments) as unknown,
      })),
    );
  }
  return { role: message.role, content: blocks };
}

function systemBlocks(
  messages: readonly ChatMessage[],
): Anthropic.TextBlockParam[] {
  return messages
    .filter((message) => message.role === "system")
    .flatMap((message) => contentBlocks(message.content))
    .map((block) => {
      if (block.type !== "text") {
        throw new Error("Anthropic system messages only support text blocks");
      }
      return block;
    });
}

function finishReason(reason: string): CompletionEvent {
  return {
    type: "finish",
    reason:
      reason === "end_turn" || reason === "stop_sequence"
        ? "stop"
        : reason === "max_tokens"
          ? "length"
          : reason === "tool_use"
            ? "tool-calls"
            : reason === "refusal"
              ? "content-filter"
              : "unknown",
  };
}

function errorEvent(error: unknown): CompletionEvent {
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      type: "error",
      kind: "authentication",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return {
      type: "error",
      kind: "rate-limit",
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      type: "error",
      kind: "timeout",
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return {
      type: "error",
      kind: "network",
      message: error.message,
      retryable: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/prompt is too long|context window/iu.test(message)) {
    return { type: "error", kind: "context-window", message, retryable: false };
  }
  const transient = transientByStatus(
    error instanceof Anthropic.APIError ? error.status : undefined,
  );
  if (transient !== undefined) return { type: "error", message, ...transient };
  const invalid = responseValidationEvent(error);
  if (invalid !== undefined) return invalid;
  return { type: "error", kind: "provider", message, retryable: false };
}

export class AnthropicProvider implements ModelProvider {
  readonly #client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.defaultHeaders === undefined
        ? {}
        : { defaultHeaders: options.defaultHeaders }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      maxRetries: 0,
    });
  }

  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    let inputTokens = 0;
    let cachedInputTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    try {
      const system = systemBlocks(request.messages);
      const stream = await this.#client.messages.create(
        {
          ...request.extraParameters,
          model: request.model,
          messages: request.messages.flatMap((message) => {
            const mapped = anthropicMessage(message);
            return mapped === undefined ? [] : [mapped];
          }),
          max_tokens: request.maxOutputTokens ?? 4096,
          stream: true,
          ...(system.length === 0 ? {} : { system }),
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
        },
        { signal },
      );
      for await (const rawEvent of stream) {
        const event = StreamEventSchema.parse(rawEvent);
        if (event.type === "message_start" && event.message) {
          // Anthropic reports cache reads and cache writes beside a prompt
          // count that excludes both. Patch's usage contract is every billed
          // input token, so they are folded in here rather than left for each
          // consumer to reconcile against OpenAI's opposite convention.
          cachedInputTokens = event.message.usage.cache_read_input_tokens;
          cacheWriteTokens = event.message.usage.cache_creation_input_tokens;
          inputTokens =
            event.message.usage.input_tokens +
            (cachedInputTokens ?? 0) +
            (cacheWriteTokens ?? 0);
        } else if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          yield {
            type: "tool-call-delta",
            index: event.index ?? 0,
            ...(event.content_block.id === undefined
              ? {}
              : { id: event.content_block.id }),
            ...(event.content_block.name === undefined
              ? {}
              : { name: event.content_block.name }),
            argumentsDelta: "",
          };
        } else if (event.type === "content_block_delta" && event.delta) {
          if (
            event.delta.type === "text_delta" &&
            event.delta.text !== undefined
          ) {
            yield { type: "text-delta", text: event.delta.text };
          } else if (
            event.delta.type === "thinking_delta" &&
            event.delta.thinking !== undefined
          ) {
            yield { type: "reasoning-delta", text: event.delta.thinking };
          } else if (
            event.delta.type === "input_json_delta" &&
            event.delta.partial_json !== undefined
          ) {
            yield {
              type: "tool-call-delta",
              index: event.index ?? 0,
              argumentsDelta: event.delta.partial_json,
            };
          }
        } else if (event.type === "message_delta") {
          if (event.usage?.output_tokens !== undefined) {
            yield {
              type: "usage",
              inputTokens,
              outputTokens: event.usage.output_tokens,
              ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
              ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
            };
          }
          if (event.delta?.stop_reason) {
            yield finishReason(event.delta.stop_reason);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        yield { type: "finish", reason: "cancelled" };
      } else {
        yield errorEvent(error);
      }
    }
  }
}
