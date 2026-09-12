/**
 * Ported from aider/coders/udiff_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to parse provider-neutral edits and apply purely
 * against caller-owned snapshots.
 * Licensed under the Apache License, Version 2.0.
 */

import type { EditStrategy, EditStrategyContext } from "./strategy.js";
import type { Edit, EditBatch } from "./types.js";

export class UnifiedDiffParseError extends Error {
  override readonly name = "UnifiedDiffParseError";
}

export class UnifiedDiffNoMatchError extends Error {
  override readonly name = "UnifiedDiffNoMatchError";
}

export class UnifiedDiffNotUniqueError extends Error {
  override readonly name = "UnifiedDiffNotUniqueError";
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function beforeAfter(lines: readonly string[]): [string, string] {
  const before: string[] = [];
  const after: string[] = [];
  let previousOperation: string | undefined;
  for (const line of lines) {
    if (line === NO_NEWLINE_MARKER) {
      if (!previousOperation || ![" ", "+", "-"].includes(previousOperation)) {
        throw new UnifiedDiffParseError(
          "A no-newline marker must immediately follow a hunk content line",
        );
      }
      if (previousOperation === " " || previousOperation === "-") {
        before[before.length - 1] = (before.at(-1) ?? "").slice(0, -1);
      }
      if (previousOperation === " " || previousOperation === "+") {
        after[after.length - 1] = (after.at(-1) ?? "").slice(0, -1);
      }
      previousOperation = undefined;
      continue;
    }
    const operation = line[0];
    const rawContent = line.slice(1);
    const content = rawContent.trim() === "" ? "" : rawContent;
    if (operation === " " || operation === "-") before.push(`${content}\n`);
    if (operation === " " || operation === "+") after.push(`${content}\n`);
    previousOperation = operation;
  }
  return [before.join(""), after.join("")];
}

/**
 * A hunk describes whole lines, so a match has to begin at a line boundary: a
 * plain substring search would let `old` land inside `folder`. When the before
 * side carries a no-newline marker it also asserts that those are the file's
 * final bytes, so such a match must additionally end at the end of the content.
 */
function isAnchored(content: string, before: string, index: number): boolean {
  if (index > 0 && content[index - 1] !== "\n") return false;
  if (before.endsWith("\n")) return true;
  return index + before.length === content.length;
}

function replaceExact(
  content: string,
  before: string,
  after: string,
  path: string,
): string | undefined {
  const matches: number[] = [];
  for (
    let index = content.indexOf(before);
    index >= 0;
    index = content.indexOf(before, index + 1)
  ) {
    if (isAnchored(content, before, index)) matches.push(index);
  }
  if (matches.length > 1) {
    throw new UnifiedDiffNotUniqueError(
      `UnifiedDiffNotUnique: ${path} contains multiple copies of the hunk; add context lines`,
    );
  }
  const index = matches[0];
  return index === undefined
    ? undefined
    : content.slice(0, index) + after + content.slice(index + before.length);
}

function splitLines(content: string): string[] {
  return content.match(/.*(?:\r\n|\n|\r)|.+$/gu) ?? [];
}

function indentLength(line: string): number {
  return /^[ \t]*/u.exec(line)?.[0].length ?? 0;
}

function adjustIndent(line: string, change: number): string {
  if (line.trim() === "") return line;
  if (change >= 0) return `${" ".repeat(change)}${line}`;
  return line.slice(Math.min(indentLength(line), -change));
}

function replaceRelativeIndent(
  content: string,
  before: string,
  after: string,
  path: string,
): string | undefined {
  const wholeLines = splitLines(content);
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const matches: number[] = [];
  for (
    let index = 0;
    index <= wholeLines.length - beforeLines.length;
    index += 1
  ) {
    if (
      !before.endsWith("\n") &&
      index + beforeLines.length !== wholeLines.length
    )
      continue;
    if (
      beforeLines.every(
        (line, offset) =>
          wholeLines[index + offset]?.trimStart() === line.trimStart(),
      )
    )
      matches.push(index);
  }
  if (matches.length > 1) {
    throw new UnifiedDiffNotUniqueError(
      `UnifiedDiffNotUnique: ${path} contains multiple indentation-normalized matches; add context lines`,
    );
  }
  const index = matches[0];
  if (index === undefined) return undefined;
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  )
    suffix += 1;
  const anchor = Math.min(prefix, beforeLines.length - 1);
  const change =
    indentLength(wholeLines[index + anchor] ?? "") -
    indentLength(beforeLines[anchor] ?? "");
  return [
    ...wholeLines.slice(0, index),
    ...wholeLines.slice(index, index + prefix),
    ...afterLines
      .slice(prefix, afterLines.length - suffix)
      .map((line) => adjustIndent(line, change)),
    ...wholeLines.slice(
      index + beforeLines.length - suffix,
      index + beforeLines.length,
    ),
    ...wholeLines.slice(index + beforeLines.length),
  ].join("");
}

const MAX_OMITTED_LINES = 20;
const MAX_OMITTED_HUNK_LINES = 100;
const MAX_OMITTED_COMPARISONS = 10_000;

function omittedMappings(
  content: readonly string[],
  before: readonly string[],
): { matches: number[][]; exhausted: boolean } {
  if (before.length < 2 || before.length > MAX_OMITTED_HUNK_LINES)
    return { matches: [], exhausted: false };
  const matches: number[][] = [];
  let comparisons = 0;
  let exhausted = false;
  const visit = (search: number, next: number, mapping: number[]): void => {
    if (matches.length > 1) return;
    if (comparisons >= MAX_OMITTED_COMPARISONS) {
      exhausted = true;
      return;
    }
    if (search === before.length) {
      const first = mapping[0];
      const last = mapping.at(-1);
      if (
        first !== undefined &&
        last !== undefined &&
        last - first + 1 > before.length
      )
        matches.push([...mapping]);
      return;
    }
    const first = mapping[0] ?? next;
    const maximum = Math.min(
      content.length - (before.length - search),
      first + before.length + MAX_OMITTED_LINES - 1,
    );
    for (let index = next; index <= maximum; index += 1) {
      if (comparisons >= MAX_OMITTED_COMPARISONS) {
        exhausted = true;
        return;
      }
      comparisons += 1;
      if (content[index] !== before[search]) continue;
      mapping.push(index);
      visit(search + 1, index + 1, mapping);
      mapping.pop();
      if (matches.length > 1 || comparisons >= MAX_OMITTED_COMPARISONS) return;
    }
  };
  visit(0, 0, []);
  return { matches, exhausted };
}

function replaceOmittedLines(
  content: string,
  before: string,
  after: string,
  path: string,
): string | undefined {
  const wholeLines = splitLines(content);
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const { matches, exhausted } = omittedMappings(wholeLines, beforeLines);
  if (matches.length > 1) {
    throw new UnifiedDiffNotUniqueError(
      `UnifiedDiffNotUnique: ${path} contains multiple omitted-line matches; add context lines`,
    );
  }
  if (exhausted) return undefined;
  const mapping = matches[0];
  if (mapping === undefined) return undefined;
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  )
    suffix += 1;
  const removed = mapping.slice(prefix, beforeLines.length - suffix);
  const replacement = afterLines.slice(prefix, afterLines.length - suffix);
  const insertion = removed[0] ?? (mapping[prefix - 1] ?? -1) + 1;
  const removedSet = new Set(removed);
  const output: string[] = [];
  for (let index = 0; index <= wholeLines.length; index += 1) {
    if (index === insertion) output.push(...replacement);
    if (index < wholeLines.length && !removedSet.has(index))
      output.push(wholeLines[index] ?? "");
  }
  return output.join("");
}

export function applyUnifiedDiff(
  content: string,
  before: string,
  after: string,
  path: string,
): string {
  if (before === "") return content + after;
  const exact = replaceExact(content, before, after, path);
  if (exact !== undefined) return exact;
  const indented = replaceRelativeIndent(content, before, after, path);
  if (indented !== undefined) return indented;
  const omitted = replaceOmittedLines(content, before, after, path);
  if (omitted !== undefined) return omitted;
  throw new UnifiedDiffNoMatchError(
    `UnifiedDiffNoMatch: ${path} does not contain the ${before.split(/\r?\n/u).filter(Boolean).length} exact lines in the hunk${before.endsWith("\n") ? "" : " as its final line without a trailing newline"}`,
  );
}

/**
 * Resolves the path of a `--- `/`+++ ` header pair. Upstream strips the `a/`
 * and `b/` prefixes only for a fence's leading header pair; Patch applies the
 * same rule to every header transition so a second file in one fence resolves
 * to a real repository path.
 */
function headerPath(source: string, destination: string): string {
  const from = source.slice(4).trim();
  const to = destination.slice(4).trim();
  return (from.startsWith("a/") || from === "/dev/null") && to.startsWith("b/")
    ? to.slice(2)
    : to;
}

export class UnifiedDiffEditStrategy implements EditStrategy {
  readonly format = "udiff" as const;

  parse(response: string, _context: EditStrategyContext): EditBatch {
    void _context;
    const edits: Edit[] = [];
    const seen = new Set<string>();
    const blocks = response.matchAll(/```diff\s*\n([\s\S]*?)(?:```|$)/gu);
    let lastPath: string | undefined;
    for (const match of blocks) {
      const lines = (match[1] ?? "").split(/\r?\n/u);
      let path = lastPath;
      let start = 0;
      if (lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ")) {
        path = headerPath(lines[0], lines[1]);
        lastPath = path;
        start = 2;
      }

      let hunk: string[] = [];
      const flush = () => {
        const changed = hunk.some(
          (line) => line.startsWith("+") || line.startsWith("-"),
        );
        const pending = hunk;
        hunk = [];
        // Validated even when the hunk changes nothing: a detached marker is
        // malformed wherever it appears, and returning early here would let a
        // context-only hunk carry one silently.
        const [search, replacement] = beforeAfter(pending);
        if (!changed) return;
        if (path === undefined) {
          throw new UnifiedDiffParseError(
            "Unified diff is missing a file path",
          );
        }
        if (search === replacement) return;
        const key = JSON.stringify([path, search, replacement]);
        if (seen.has(key)) return;
        seen.add(key);
        edits.push({
          kind: "replace",
          path,
          search,
          replacement,
          protocol: "udiff",
        });
      };

      // The trailing sentinel flushes the fence's final hunk.
      for (let index = start; index <= lines.length; index += 1) {
        const line = index < lines.length ? (lines[index] ?? "") : "@@";
        if (
          line.startsWith("+++ ") &&
          (lines[index - 1] ?? "").startsWith("--- ")
        ) {
          // The header's `--- ` line was collected as a deletion; drop it and
          // close the preceding file before switching paths.
          hunk.pop();
          flush();
          path = headerPath(lines[index - 1] ?? "", line);
          lastPath = path;
          continue;
        }
        if (line.startsWith("@@")) {
          flush();
          continue;
        }
        if (line === NO_NEWLINE_MARKER) {
          hunk.push(line);
          continue;
        }
        if (line !== "" && ![" ", "+", "-"].includes(line[0] ?? "")) {
          throw new UnifiedDiffParseError(`Invalid unified diff line: ${line}`);
        }
        if (line !== "") hunk.push(line);
      }
    }
    return { edits, shellCommands: [] };
  }
}
