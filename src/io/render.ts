/**
 * Terminal rendering adapted from aider/io.py and aider/mdstream.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch into a dependency-free renderer with explicit no-color behavior.
 * Licensed under the Apache License, Version 2.0.
 */

import type { Writable } from "node:stream";

import type { EditPreview } from "../edits/write-boundary.js";
import type { UsageReport } from "../models/usage.js";
import { ControlSequenceSanitizer, sanitizeTerminalText } from "./sanitize.js";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
} as const;

export interface RenderOptions {
  readonly color?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}

function useColor(options: RenderOptions): boolean {
  if (options.color !== undefined) return options.color;
  const environment = options.environment ?? process.env;
  return (
    environment.NO_COLOR === undefined &&
    (options.isTTY ?? process.stdout.isTTY)
  );
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * Remove every control sequence from one self-contained piece of untrusted
 * text. Chunked untrusted streams must use `MarkdownStream` or another holder
 * of a single `ControlSequenceSanitizer` instead, so a sequence split across
 * chunks cannot survive.
 */
export function stripAnsi(text: string): string {
  return sanitizeTerminalText(text);
}

export function highlightSyntax(
  source: string,
  language: string,
  options: RenderOptions = {},
): string {
  const color = useColor(options);
  if (!color) return stripAnsi(source);
  if (
    !/^(?:js|jsx|ts|tsx|javascript|typescript|json|sh|bash)$/iu.test(language)
  ) {
    return stripAnsi(source);
  }
  return stripAnsi(source)
    .replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu,
      `${ANSI.green}$1${ANSI.reset}`,
    )
    .replace(
      /\b(const|let|var|function|class|return|if|else|import|export|async|await)\b/gu,
      `${ANSI.cyan}$1${ANSI.reset}`,
    )
    .replace(/(\/\/.*)$/gmu, `${ANSI.dim}$1${ANSI.reset}`);
}

function renderMarkdownLine(line: string, color: boolean): string {
  const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
  if (heading !== null) return paint(heading[2] ?? "", ANSI.bold, color);
  return stripAnsi(line)
    .replace(/`([^`]+)`/gu, (_, code: string) => paint(code, ANSI.cyan, color))
    .replace(/\*\*([^*]+)\*\*/gu, (_, text: string) =>
      paint(text, ANSI.bold, color),
    );
}

export class MarkdownStream {
  readonly #write: (text: string) => void;
  readonly #color: boolean;
  // One sanitizer for the whole stream: provider deltas can split a control
  // sequence across chunks, and a per-chunk strip would let the halves rejoin.
  readonly #sanitizer = new ControlSequenceSanitizer();
  #buffer = "";
  #language: string | undefined;

  constructor(
    output: Pick<Writable, "write"> | ((text: string) => void),
    options: RenderOptions = {},
  ) {
    this.#write =
      typeof output === "function" ? output : (text) => void output.write(text);
    this.#color = useColor(options);
  }

  write(chunk: string): void {
    this.#buffer += this.#sanitizer.write(chunk);
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      this.#line(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.#buffer !== "") this.#line(this.#buffer, false);
    this.#buffer = "";
  }

  #line(line: string, newline = true): void {
    const fence = /^```\s*([^\s`]*)/u.exec(line);
    if (fence !== null) {
      this.#language =
        this.#language === undefined ? (fence[1] ?? "") : undefined;
      return;
    }
    const rendered =
      this.#language === undefined
        ? renderMarkdownLine(line, this.#color)
        : highlightSyntax(line, this.#language, { color: this.#color });
    this.#write(`${rendered}${newline ? "\n" : ""}`);
  }
}

export function renderDiff(diff: string, options: RenderOptions = {}): string {
  const color = useColor(options);
  return stripAnsi(diff)
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---"))
        return paint(line, ANSI.bold, color);
      if (line.startsWith("+")) return paint(line, ANSI.green, color);
      if (line.startsWith("-")) return paint(line, ANSI.red, color);
      if (line.startsWith("@@")) return paint(line, ANSI.cyan, color);
      return line;
    })
    .join("\n");
}

function tokenCount(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

function money(amount: number): string {
  // Per-turn costs are frequently well under a cent, so a fixed two decimals
  // would render most turns as $0.00.
  return `$${amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

/**
 * One line of token and cost accounting for a finished turn. An unpriced model
 * reports tokens only, rather than implying a cost of zero.
 */
export function renderUsage(
  usage: UsageReport,
  sessionCost?: number,
  options: RenderOptions = {},
): string {
  const parts = [
    `${tokenCount(usage.inputTokens)} sent`,
    ...(usage.cachedInputTokens === undefined || usage.cachedInputTokens === 0
      ? []
      : [`${tokenCount(usage.cachedInputTokens)} cached`]),
    `${tokenCount(usage.outputTokens)} received`,
  ];
  const cost =
    usage.cost === null
      ? ""
      : ` · ${money(usage.cost)} turn${
          sessionCost === undefined ? "" : `, ${money(sessionCost)} session`
        }`;
  return paint(
    `tokens: ${parts.join(", ")}${cost}`,
    ANSI.dim,
    useColor(options),
  );
}

export function renderEditPreview(preview: EditPreview): string {
  return preview.operations
    .map((operation) => {
      const before = operation.kind === "create" ? "" : operation.before;
      const after = operation.kind === "delete" ? "" : operation.content;
      return [
        `--- ${operation.kind === "create" ? "/dev/null" : `a/${operation.path}`}`,
        `+++ ${operation.kind === "delete" ? "/dev/null" : `b/${operation.path}`}`,
        "@@ proposed edit @@",
        ...before.split("\n").map((line) => `-${line}`),
        ...after.split("\n").map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}
