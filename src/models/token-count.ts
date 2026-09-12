import { get_encoding, type TiktokenEncoding } from "tiktoken";

import type { ChatMessage, MessageContent } from "../core/messages.js";
import type { ModelSettings } from "./settings.js";

export interface TokenCount {
  readonly tokens: number;
  readonly method: "model-tokenizer" | "conservative";
  readonly tokenizer?: string;
}

export type MessageTokenCounter = (
  messages: readonly ChatMessage[],
  model: ModelSettings,
) => number;

function contentText(content: MessageContent | null): string | undefined {
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (content.some((part) => part.type !== "text")) {
    return undefined;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function messageText(message: ChatMessage): string | undefined {
  const content = contentText(message.content);
  if (content === undefined) {
    return undefined;
  }
  if (message.role === "assistant") {
    return [
      message.role,
      content,
      message.reasoning ?? "",
      ...(message.toolCalls ?? []).flatMap((call) => [
        call.id,
        call.name,
        call.arguments,
      ]),
    ].join("\n");
  }
  if (message.role === "tool") {
    return [message.role, message.toolCallId, content].join("\n");
  }
  return [message.role, content].join("\n");
}

function encodingName(model: ModelSettings): TiktokenEncoding | undefined {
  if (model.provider !== "openai") {
    return undefined;
  }
  if (/^(?:gpt-4o|gpt-4\.1|o[134](?:-|$))/u.test(model.name)) {
    return "o200k_base";
  }
  if (/^(?:gpt-4|gpt-3\.5)/u.test(model.name)) {
    return "cl100k_base";
  }
  return undefined;
}

export function conservativeMessageTokens(
  messages: readonly ChatMessage[],
): number {
  return messages.reduce((total, message) => {
    const text = messageText(message);
    const length =
      text?.length ??
      (typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content).length);
    return total + 4 + Math.ceil(length / 4);
  }, 0);
}

export function countTextTokens(
  text: string,
  model: ModelSettings,
): TokenCount {
  const name = encodingName(model);
  if (name === undefined) {
    return { tokens: Math.ceil(text.length / 4), method: "conservative" };
  }
  const encoding = get_encoding(name);
  try {
    return {
      tokens: encoding.encode(text).length,
      method: "model-tokenizer",
      tokenizer: name,
    };
  } finally {
    encoding.free();
  }
}

export function countMessageTokens(
  messages: readonly ChatMessage[],
  model: ModelSettings,
): TokenCount {
  const name = encodingName(model);
  const texts = messages.map(messageText);
  if (name === undefined || texts.some((text) => text === undefined)) {
    return {
      tokens: conservativeMessageTokens(messages),
      method: "conservative",
    };
  }
  const encoding = get_encoding(name);
  try {
    const tokens = texts.reduce(
      (total, text) => total + 3 + encoding.encode(text ?? "").length,
      3,
    );
    return { tokens, method: "model-tokenizer", tokenizer: name };
  } finally {
    encoding.free();
  }
}
