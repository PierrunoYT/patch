/**
 * Token-context reporting adapted from aider/commands.py:cmd_tokens at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to report the actual provider-neutral prompt chunks with
 * explicit estimate provenance and without provider calls or prompt contents.
 * Licensed under the Apache License, Version 2.0.
 */

import type { TokenCount } from "../models/token-count.js";

export type TokenContextSection =
  | "system and examples"
  | "chat history"
  | "read-only files"
  | "repository map"
  | "editable files"
  | "attached media"
  | "system reminder";

export interface TokenContextRow {
  readonly section: TokenContextSection;
  readonly tokens: number;
}

export interface TokenContextView {
  readonly model: string;
  readonly rows: readonly TokenContextRow[];
  readonly total: TokenCount;
  readonly maxInputTokens?: number;
  readonly inputCostPerMillion?: number;
}

function safeModelName(value: string): string {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "�");
  return cleaned.length <= 256 ? cleaned : `${cleaned.slice(0, 255)}…`;
}

function integer(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

/** Render bounded numeric metadata, never the prompt text used to derive it. */
export function renderTokenContext(view: TokenContextView): string {
  const lines = [
    `Approximate current context usage for ${safeModelName(view.model)}:`,
    "",
    ...view.rows.map(
      ({ section, tokens }) => `${integer(tokens).padStart(10)}  ${section}`,
    ),
    "--------------------------",
    `${integer(view.total.tokens).padStart(10)}  baseline tokens total`,
  ];
  if (view.inputCostPerMillion !== undefined) {
    lines.push(
      `$${((view.total.tokens * view.inputCostPerMillion) / 1_000_000).toFixed(6)}  estimated input cost`,
    );
  }
  if (view.maxInputTokens !== undefined) {
    lines.push(
      `${(view.maxInputTokens - view.total.tokens).toLocaleString("en-US")}  tokens remaining`,
      `${integer(view.maxInputTokens)}  maximum input tokens`,
    );
  }
  lines.push(
    view.total.method === "model-tokenizer"
      ? `Counting: model tokenizer (${view.total.tokenizer ?? "model default"}).`
      : "Counting: conservative estimate.",
    "The baseline excludes the next user message. Category estimates are counted independently.",
  );
  return lines.join("\n");
}
