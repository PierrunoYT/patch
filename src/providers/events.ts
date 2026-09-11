import { z } from "zod";

import { ChatMessageSchema } from "../core/messages.js";

export const CompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).min(1),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    extraParameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const TextDeltaEventSchema = z
  .object({
    type: z.literal("text-delta"),
    text: z.string(),
  })
  .strict();

const ReasoningDeltaEventSchema = z
  .object({
    type: z.literal("reasoning-delta"),
    text: z.string(),
  })
  .strict();

const ToolCallDeltaEventSchema = z
  .object({
    type: z.literal("tool-call-delta"),
    index: z.number().int().nonnegative(),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    argumentsDelta: z.string(),
  })
  .strict();

const UsageEventSchema = z
  .object({
    type: z.literal("usage"),
    /** Every billed input token, cached reads and cache writes included. */
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  })
  .strict();

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "cancelled",
  "unknown",
]);

const FinishEventSchema = z
  .object({
    type: z.literal("finish"),
    reason: FinishReasonSchema,
  })
  .strict();

const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    kind: z.enum([
      "authentication",
      "rate-limit",
      "timeout",
      "context-window",
      "network",
      "provider",
      "unknown",
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
    raw: z.unknown().optional(),
  })
  .strict();

export const CompletionEventSchema = z.discriminatedUnion("type", [
  TextDeltaEventSchema,
  ReasoningDeltaEventSchema,
  ToolCallDeltaEventSchema,
  UsageEventSchema,
  FinishEventSchema,
  ErrorEventSchema,
]);

export interface ModelProvider {
  stream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionEvent>;
  close?(): void | Promise<void>;
}

export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;
export type FinishReason = z.infer<typeof FinishReasonSchema>;
export type CompletionEvent = z.infer<typeof CompletionEventSchema>;
