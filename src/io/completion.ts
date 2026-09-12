/**
 * Terminal completion adapted from aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch into a deterministic terminal-library-neutral completion engine.
 * Licensed under the Apache License, Version 2.0.
 */

export type CompletionKind = "command" | "file" | "identifier";

export interface CompletionCandidate {
  readonly value: string;
  readonly display: string;
  readonly kind: CompletionKind;
  readonly replaceFrom: number;
}

export interface CompletionSources {
  readonly commands: readonly string[];
  readonly files: readonly string[];
  readonly identifiers?: readonly string[];
}

const FILE_COMMANDS = new Set(["/add", "/attach", "/drop", "/read-only"]);
const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function lastWord(text: string): { word: string; start: number } {
  const match = /(?:^|\s)(\S*)$/u.exec(text);
  const word = match?.[1] ?? "";
  return { word, start: text.length - word.length };
}

function candidates(
  values: readonly string[],
  partial: string,
  kind: CompletionKind,
  replaceFrom: number,
): CompletionCandidate[] {
  const normalized = partial.toLocaleLowerCase();
  return [...new Set(values)]
    .filter((value) => value.toLocaleLowerCase().startsWith(normalized))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, display: value, kind, replaceFrom }));
}

export function extractIdentifiers(contents: readonly string[]): string[] {
  const found = new Set<string>();
  for (const content of contents) {
    for (const match of content.matchAll(
      /[\p{ID_Start}_$][\p{ID_Continue}_$]*/gu,
    )) {
      const value = match[0];
      if (value.length >= 3 && !RESERVED_WORDS.has(value)) found.add(value);
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

export function completeInput(
  input: string,
  cursor: number,
  sources: CompletionSources,
): CompletionCandidate[] {
  const beforeCursor = input.slice(0, cursor);
  const { word, start } = lastWord(beforeCursor);
  const words = beforeCursor.trimStart().split(/\s+/u);

  if (beforeCursor.startsWith("/") && words.length === 1) {
    return candidates(
      sources.commands.map((command) =>
        command.startsWith("/") ? command : `/${command}`,
      ),
      word,
      "command",
      start,
    );
  }

  if (FILE_COMMANDS.has(words[0] ?? "")) {
    return candidates(sources.files, word, "file", start);
  }

  if (word.length < 3) return [];
  return candidates(
    [...sources.files, ...(sources.identifiers ?? [])],
    word,
    "identifier",
    start,
  );
}
