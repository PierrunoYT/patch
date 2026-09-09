import OpenAI from "openai";
import { z } from "zod";

import type { ChatMessage, MessageContent } from "../core/messages.js";
import type {
  CompletionEvent,
  CompletionRequest,
  ModelProvider,
} from "./events.js";

const OpenAIChunkSchema = z
  .object({
    choices: z.array(
      z
        .object({
          delta: z
            .object({
              content: z.string().nullable().optional(),
              reasoning_content: z.string().nullable().optional(),
              tool_calls: z
                .array(
                  z
                    .object({
                      index: z.number().int().nonnegative(),
                      id: z.string().optional(),
                      function: z
                        .object({
                          name: z.string().optional(),
                          arguments: z.string().optional(),
                        })
                        .passthrough()
                        .optional(),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough(),
          finish_reason: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        prompt_tokens_details: z
          .object({ cached_tokens: z.number().int().nonnegative().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly timeout?: number;
  readonly organization?: string;
  readonly project?: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

function textContent(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (content.some((part) => part.type !== "text")) {
    throw new Error("This OpenAI message role only supports text content");
  }
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function userContent(
  content: MessageContent,
): OpenAI.Chat.ChatCompletionUserMessageParam["content"] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "document") {
      throw new Error(
        "OpenAI Chat Completions does not support PDF message parts",
      );
    }
    const url = /^(?:data:|https?:)/u.test(part.data)
      ? part.data
      : `data:${part.mediaType};base64,${part.data}`;
    return { type: "image_url" as const, image_url: { url } };
  });
}

function openAIMessage(
  message: ChatMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: textContent(message.content) };
    case "user":
      return { role: "user", content: userContent(message.content) };
    case "assistant":
      return {
        role: "assistant",
        content: message.content === null ? null : textContent(message.content),
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

function finishReason(reason: string): CompletionEvent {
  return {
    type: "finish",
    reason:
      reason === "stop" || reason === "length" || reason === "content_filter"
        ? (reason.replace("_", "-") as "stop" | "length" | "content-filter")
        : reason === "tool_calls"
          ? "tool-calls"
          : "unknown",
  };
}

function errorEvent(error: unknown): CompletionEvent {
  if (error instanceof OpenAI.AuthenticationError) {
    return {
      type: "error",
      kind: "authentication",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof OpenAI.RateLimitError) {
    return {
      type: "error",
      kind: "rate-limit",
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      type: "error",
      kind: "timeout",
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return {
      type: "error",
      kind: "network",
      message: error.message,
      retryable: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/context (?:length|window)|maximum context/iu.test(message)) {
    return { type: "error", kind: "context-window", message, retryable: false };
  }
  return { type: "error", kind: "provider", message, retryable: false };
}

export class OpenAIProvider implements ModelProvider {
  readonly #client: OpenAI;

  constructor(options: OpenAIProviderOptions) {
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.organization === undefined
        ? {}
        : { organization: options.organization }),
      ...(options.project === undefined ? {} : { project: options.project }),
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
    try {
      const stream = await this.#client.chat.completions.create(
        {
          ...request.extraParameters,
          model: request.model,
          messages: request.messages.map(openAIMessage),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.maxOutputTokens === undefined
            ? {}
            : { max_completion_tokens: request.maxOutputTokens }),
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
        },
        { signal },
      );
      for await (const rawChunk of stream) {
        const chunk = OpenAIChunkSchema.parse(rawChunk);
        for (const choice of chunk.choices) {
          if (choice.delta.reasoning_content) {
            yield {
              type: "reasoning-delta",
              text: choice.delta.reasoning_content,
            };
          }
          if (choice.delta.content) {
            yield { type: "text-delta", text: choice.delta.content };
          }
          for (const toolCall of choice.delta.tool_calls ?? []) {
            yield {
              type: "tool-call-delta",
              index: toolCall.index,
              ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
              ...(toolCall.function?.name === undefined
                ? {}
                : { name: toolCall.function.name }),
              argumentsDelta: toolCall.function?.arguments ?? "",
            };
          }
          if (
            choice.finish_reason !== null &&
            choice.finish_reason !== undefined
          ) {
            yield finishReason(choice.finish_reason);
          }
        }
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined
              ? {}
              : {
                  cachedInputTokens:
                    chunk.usage.prompt_tokens_details.cached_tokens,
                }),
          };
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
