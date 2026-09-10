/*
 * Ported from aider/coders/chat_chunks.py at
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch: validates typed messages and returns a new value when
 * adding provider-neutral cache markers instead of mutating session state.
 * Licensed under the Apache License, Version 2.0.
 */

import { z } from "zod";

import {
  ChatMessageSchema,
  type ChatMessage,
  type MessageContentPart,
} from "./messages.js";

const MessageListSchema = z.array(ChatMessageSchema).default([]);

export const ChatChunksSchema = z
  .object({
    system: MessageListSchema,
    examples: MessageListSchema,
    done: MessageListSchema,
    repo: MessageListSchema,
    readonlyFiles: MessageListSchema,
    chatFiles: MessageListSchema,
    current: MessageListSchema,
    reminder: MessageListSchema,
  })
  .strict();

export type ChatChunksInput = z.input<typeof ChatChunksSchema>;

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ChatMessageSchema.parse(message));
}

function hasCacheControl(message: ChatMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (part) => part.type === "text" && part.cacheControl !== undefined,
    )
  );
}

function markLastMessage(messages: readonly ChatMessage[]): ChatMessage[] {
  const marked = cloneMessages(messages);
  const last = marked.at(-1);
  if (last === undefined || last.role === "tool" || last.content === null) {
    return marked;
  }

  if (typeof last.content === "string") {
    last.content = [
      {
        type: "text",
        text: last.content,
        cacheControl: { type: "ephemeral" },
      },
    ];
    return marked;
  }

  const textIndex = last.content.findLastIndex((part) => part.type === "text");
  if (textIndex === -1) {
    return marked;
  }

  const text = last.content[textIndex] as Extract<
    MessageContentPart,
    { type: "text" }
  >;
  last.content[textIndex] = {
    ...text,
    cacheControl: { type: "ephemeral" },
  };
  return marked;
}

export class ChatChunks {
  readonly system: readonly ChatMessage[];
  readonly examples: readonly ChatMessage[];
  readonly done: readonly ChatMessage[];
  readonly repo: readonly ChatMessage[];
  readonly readonlyFiles: readonly ChatMessage[];
  readonly chatFiles: readonly ChatMessage[];
  readonly current: readonly ChatMessage[];
  readonly reminder: readonly ChatMessage[];

  constructor(input: unknown = {}) {
    const chunks = ChatChunksSchema.parse(input);
    this.system = chunks.system;
    this.examples = chunks.examples;
    this.done = chunks.done;
    this.repo = chunks.repo;
    this.readonlyFiles = chunks.readonlyFiles;
    this.chatFiles = chunks.chatFiles;
    this.current = chunks.current;
    this.reminder = chunks.reminder;
  }

  allMessages(): ChatMessage[] {
    return cloneMessages([
      ...this.system,
      ...this.examples,
      ...this.readonlyFiles,
      ...this.repo,
      ...this.done,
      ...this.chatFiles,
      ...this.current,
      ...this.reminder,
    ]);
  }

  withCacheControl(): ChatChunks {
    return new ChatChunks({
      system:
        this.examples.length === 0 ? markLastMessage(this.system) : this.system,
      examples:
        this.examples.length > 0
          ? markLastMessage(this.examples)
          : this.examples,
      done: this.done,
      repo: this.repo.length > 0 ? markLastMessage(this.repo) : this.repo,
      readonlyFiles:
        this.repo.length === 0
          ? markLastMessage(this.readonlyFiles)
          : this.readonlyFiles,
      chatFiles: markLastMessage(this.chatFiles),
      current: this.current,
      reminder: this.reminder,
    });
  }

  cacheableMessages(): ChatMessage[] {
    const messages = this.allMessages();
    const lastCacheBoundary = messages.findLastIndex(hasCacheControl);
    return lastCacheBoundary === -1
      ? messages
      : messages.slice(0, lastCacheBoundary + 1);
  }
}
