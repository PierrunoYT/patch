import { z } from "zod";

const CacheControlSchema = z
  .object({
    type: z.literal("ephemeral"),
  })
  .strict();

export const TextContentPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    cacheControl: CacheControlSchema.optional(),
  })
  .strict();

export const ImageContentPartSchema = z
  .object({
    type: z.literal("image"),
    mediaType: z.string().regex(/^image\//u),
    data: z.string().min(1),
  })
  .strict();

export const DocumentContentPartSchema = z
  .object({
    type: z.literal("document"),
    mediaType: z.literal("application/pdf"),
    data: z.string().min(1),
  })
  .strict();

export const MessageContentPartSchema = z.discriminatedUnion("type", [
  TextContentPartSchema,
  ImageContentPartSchema,
  DocumentContentPartSchema,
]);

export const MessageContentSchema = z.union([
  z.string(),
  z.array(MessageContentPartSchema).min(1),
]);

export const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  })
  .strict();

const SystemMessageSchema = z
  .object({
    role: z.literal("system"),
    content: MessageContentSchema,
  })
  .strict();

const UserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: MessageContentSchema,
  })
  .strict();

const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: MessageContentSchema.nullable(),
    reasoning: z.string().optional(),
    toolCalls: z.array(ToolCallSchema).min(1).optional(),
  })
  .strict()
  .refine(
    (message) => message.content !== null || message.toolCalls !== undefined,
    "An assistant message needs content or a tool call",
  );

const ToolMessageSchema = z
  .object({
    role: z.literal("tool"),
    toolCallId: z.string().min(1),
    content: z.string(),
  })
  .strict();

export const ChatMessageSchema = z.union([
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);

export type MessageContentPart = z.infer<typeof MessageContentPartSchema>;
export type MessageContent = z.infer<typeof MessageContentSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
