import OpenAI from "openai";
import { z } from "zod";

import type { ChatMessage, MessageContent } from "../core/messages.js";
import type {
  CompletionEvent,
  CompletionRequest,
  ModelProvider,
} from "./events.js";
import { responseValidationEvent, transientByStatus } from "./errors.js";

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

/**
 * Which OpenAI-compatible endpoint this client talks to. DeepSeek accepts the
 * Chat Completions shape but names the output limit `max_tokens`, rejects the
 * `deepseek/` routing prefix LiteLLM uses in model names, and serves assistant
 * prefill only from its beta path.
 */
export type OpenAIDialect = "openai" | "deepseek";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly dialect?: OpenAIDialect;
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
      message: "OpenAI rejected the configured credential",
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
  const transient = transientByStatus(
    error instanceof OpenAI.APIError ? error.status : undefined,
  );
  if (transient !== undefined) return { type: "error", message, ...transient };
  const invalid = responseValidationEvent(error);
  if (invalid !== undefined) return invalid;
  return { type: "error", kind: "provider", message, retryable: false };
}

export class OpenAIProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #prefillClient: OpenAI | undefined;
  readonly #dialect: OpenAIDialect;

  constructor(options: OpenAIProviderOptions) {
    this.#dialect = options.dialect ?? "openai";
    const client = (baseURL: string | undefined) =>
      new OpenAI({
        apiKey: options.apiKey,
        ...(baseURL === undefined ? {} : { baseURL }),
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
    this.#client = client(options.baseURL);
    this.#prefillClient =
      this.#dialect === "deepseek"
        ? client(
            `${(options.baseURL ?? DEEPSEEK_BASE_URL).replace(/\/+$/u, "")}/beta`,
          )
        : undefined;
  }

  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    const deepseek = this.#dialect === "deepseek";
    const messages = request.messages.map(openAIMessage);
    const last = messages.at(-1);
    // DeepSeek continues a trailing assistant message only when it is marked as
    // a prefix, and only on the beta path. Elsewhere the message stays ordinary
    // context.
    const prefill =
      deepseek && last?.role === "assistant" && last.content !== null;
    if (prefill && last !== undefined) {
      messages[messages.length - 1] = {
        ...last,
        prefix: true,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }
    const client =
      prefill && this.#prefillClient !== undefined
        ? this.#prefillClient
        : this.#client;
    try {
      const stream = await client.chat.completions.create(
        {
          ...request.extraParameters,
          // LiteLLM routes with a `deepseek/` prefix; the endpoint itself only
          // knows the bare model name.
          model: deepseek
            ? request.model.replace(/^deepseek\//u, "")
            : request.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(request.maxOutputTokens === undefined
            ? {}
            : deepseek
              ? { max_tokens: request.maxOutputTokens }
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
