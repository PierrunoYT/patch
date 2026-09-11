/**
 * Ported from aider/history.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch: summarization sends through an injected completion function
 * and token counter rather than owning a model list, so the caller decides which
 * model summarizes and the algorithm stays testable without a provider.
 * Licensed under the Apache License, Version 2.0.
 */

import { SUMMARY_PROMPTS } from "../resources/prompts.js";
import { ChatMessageSchema, type ChatMessage } from "./messages.js";

/** Sends a one-shot completion and returns its whole text. */
export type SummarySend = (
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
) => Promise<string>;

export interface ChatSummaryOptions {
  readonly send: SummarySend;
  readonly countTokens: (messages: readonly ChatMessage[]) => number;
  /** History budget before summarization runs. */
  readonly maxTokens?: number;
}

/** Below this, splitting a conversation leaves too little to summarize. */
const MINIMUM_SPLIT = 4;
const MAXIMUM_DEPTH = 3;

function messageText(message: ChatMessage): string {
  if (message.role === "tool") return message.content;
  const content = message.content;
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export class ChatSummary {
  readonly #send: SummarySend;
  readonly #countTokens: (messages: readonly ChatMessage[]) => number;
  readonly #maxTokens: number;

  constructor(options: ChatSummaryOptions) {
    this.#send = options.send;
    this.#countTokens = options.countTokens;
    this.#maxTokens = options.maxTokens ?? 1024;
  }

  tooBig(messages: readonly ChatMessage[]): boolean {
    return this.#countTokens(messages) > this.#maxTokens;
  }

  async summarize(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const summarized = await this.#summarize(messages, 0, signal);
    // A conversation that ends on a user message would make the next turn's user
    // message the second in a row, which some endpoints reject.
    return summarized.length > 0 && summarized.at(-1)?.role !== "assistant"
      ? [...summarized, { role: "assistant", content: "Ok." }]
      : summarized;
  }

  async #summarize(
    messages: readonly ChatMessage[],
    depth: number,
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const sized = messages.map(
      (message) => [this.#countTokens([message]), message] as const,
    );
    const total = sized.reduce((sum, [tokens]) => sum + tokens, 0);
    if (total <= this.#maxTokens && depth === 0) return [...messages];
    if (messages.length <= MINIMUM_SPLIT || depth > MAXIMUM_DEPTH) {
      return this.#summarizeAll(messages, signal);
    }

    // Keep the most recent half-budget of messages verbatim and summarize the
    // rest, so recent detail survives.
    let tailTokens = 0;
    let splitIndex = messages.length;
    for (let index = sized.length - 1; index >= 0; index -= 1) {
      const tokens = sized[index]?.[0] ?? 0;
      if (tailTokens + tokens >= Math.floor(this.#maxTokens / 2)) break;
      tailTokens += tokens;
      splitIndex = index;
    }
    while (splitIndex > 1 && messages[splitIndex - 1]?.role !== "assistant") {
      splitIndex -= 1;
    }
    if (splitIndex <= MINIMUM_SPLIT) {
      return this.#summarizeAll(messages, signal);
    }

    const tail = messages.slice(splitIndex);
    const summary = await this.#summarizeAll(
      messages.slice(0, splitIndex),
      signal,
    );
    const combined = [...summary, ...tail];
    if (this.#countTokens(combined) <= this.#maxTokens) return combined;
    return this.#summarize(combined, depth + 1, signal);
  }

  async #summarizeAll(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const content = messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => {
        const text = messageText(message);
        return `# ${message.role.toUpperCase()}\n${text.endsWith("\n") ? text : `${text}\n`}`;
      })
      .join("");
    if (content === "") return [];
    const summary = await this.#send(
      [
        { role: "system", content: SUMMARY_PROMPTS.summarize },
        { role: "user", content },
      ],
      signal,
    );
    if (summary.trim() === "") return [...messages];
    return [
      ChatMessageSchema.parse({
        role: "user",
        content: `${SUMMARY_PROMPTS.summaryPrefix}${summary}`,
      }),
    ];
  }
}
