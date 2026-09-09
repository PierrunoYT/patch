/**
 * Ported from aider/coders/editblock_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to separate parsing and pure replacement from authorized writes.
 */

import { basename } from "node:path";

import type { EditStrategy, EditStrategyContext } from "./strategy.js";
import type { Edit, EditBatch } from "./types.js";

const HEAD = /^<{5,9} SEARCH>?\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const UPDATED = /^>{5,9} REPLACE\s*$/;
const SHELL_FENCES = [
  "```bash",
  "```sh",
  "```shell",
  "```cmd",
  "```batch",
  "```powershell",
  "```ps1",
  "```zsh",
  "```fish",
  "```ksh",
  "```csh",
  "```tcsh",
];

export class SearchReplaceParseError extends Error {
  override readonly name = "SearchReplaceParseError";
}

export class SearchReplaceNoMatchError extends Error {
  override readonly name = "SearchReplaceNoMatchError";
}

export class SearchReplaceAmbiguousError extends Error {
  override readonly name = "SearchReplaceAmbiguousError";
}

function splitLinesKeepingEndings(content: string): string[] {
  return content.match(/.*(?:\r\n|\n|\r)|.+$/g) ?? [];
}

function stripFilename(line: string, fence: readonly [string, string]): string {
  const filename = line.trim();
  if (
    filename === "..." ||
    HEAD.test(filename) ||
    DIVIDER.test(filename) ||
    UPDATED.test(filename)
  ) {
    return "";
  }
  for (const opening of [fence[0], "```"]) {
    if (filename.startsWith(opening)) {
      const candidate = filename.slice(opening.length);
      return candidate !== "" && /[./]/.test(candidate) ? candidate : "";
    }
  }
  return filename
    .replace(/:$/, "")
    .replace(/^#+/, "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^\*+|\*+$/g, "");
}

function findFilename(
  precedingLines: readonly string[],
  fence: readonly [string, string],
  editablePaths: readonly string[],
): string | undefined {
  const candidates: string[] = [];
  for (const line of [...precedingLines].reverse().slice(0, 3)) {
    const candidate = stripFilename(line, fence);
    if (candidate !== "") {
      candidates.push(candidate);
    }
    if (!line.startsWith(fence[0]) && !line.startsWith("```")) {
      break;
    }
  }
  for (const candidate of candidates) {
    if (editablePaths.includes(candidate)) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    const path = editablePaths.find(
      (editablePath) => basename(editablePath) === candidate,
    );
    if (path !== undefined) {
      return path;
    }
  }
  return (
    candidates.find((candidate) => candidate.includes(".")) ?? candidates[0]
  );
}

function parsingFailure(
  lines: readonly string[],
  index: number,
  message: string,
) {
  const processed = lines.slice(0, index + 1).join("");
  return new SearchReplaceParseError(`${processed}\n^^^ ${message}`);
}

export class SearchReplaceEditStrategy implements EditStrategy {
  readonly format: "diff" | "diff-fenced" = "diff";

  parse(response: string, context: EditStrategyContext): EditBatch {
    const lines = splitLinesKeepingEndings(response);
    const edits: Edit[] = [];
    const shellCommands: string[] = [];
    let currentFilename: string | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const nextIsEdit =
        HEAD.test((lines[index + 1] ?? "").trim()) ||
        HEAD.test((lines[index + 2] ?? "").trim());
      if (
        SHELL_FENCES.some((opening) => line.trim().startsWith(opening)) &&
        !nextIsEdit
      ) {
        const command: string[] = [];
        index += 1;
        while (
          index < lines.length &&
          !(lines[index] ?? "").trim().startsWith("```")
        ) {
          command.push(lines[index] ?? "");
          index += 1;
        }
        if (command.length > 0) {
          shellCommands.push(command.join(""));
        }
        continue;
      }

      if (!HEAD.test(line.trim())) {
        continue;
      }

      const isCreate = DIVIDER.test((lines[index + 1] ?? "").trim());
      const filename =
        findFilename(
          lines.slice(Math.max(0, index - 3), index),
          context.fence,
          isCreate ? [] : context.editablePaths,
        ) ?? currentFilename;
      if (filename === undefined) {
        throw parsingFailure(
          lines,
          index,
          `Bad/missing filename. The filename must be alone on the line before the opening fence ${context.fence[0]}`,
        );
      }
      currentFilename = filename;

      const search: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !DIVIDER.test((lines[index] ?? "").trim())
      ) {
        search.push(lines[index] ?? "");
        index += 1;
      }
      if (index >= lines.length) {
        throw parsingFailure(lines, index - 1, "Expected `=======`");
      }

      const replacement: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !UPDATED.test((lines[index] ?? "").trim()) &&
        !DIVIDER.test((lines[index] ?? "").trim())
      ) {
        replacement.push(lines[index] ?? "");
        index += 1;
      }
      if (index >= lines.length) {
        throw parsingFailure(
          lines,
          index - 1,
          "Expected `>>>>>>> REPLACE` or `=======`",
        );
      }

      edits.push({
        kind: "replace",
        path: filename,
        search: search.join(""),
        replacement: replacement.join(""),
      });
    }

    return { edits, shellCommands };
  }
}

/**
 * Ported from aider/coders/editblock_fenced_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * The wire grammar is deliberately shared with SEARCH/REPLACE; only the
 * prompt protocol and format identity differ.
 */
export class FencedSearchReplaceEditStrategy extends SearchReplaceEditStrategy {
  override readonly format = "diff-fenced" as const;
}

function prepare(content: string): { content: string; lines: string[] } {
  const prepared =
    content !== "" && !content.endsWith("\n") ? `${content}\n` : content;
  return { content: prepared, lines: splitLinesKeepingEndings(prepared) };
}

function replaceUniqueLines(
  wholeLines: readonly string[],
  searchLines: readonly string[],
  replacementLines: readonly string[],
): string | undefined {
  const matches: number[] = [];
  for (
    let index = 0;
    index <= wholeLines.length - searchLines.length;
    index += 1
  ) {
    if (
      searchLines.every((line, offset) => wholeLines[index + offset] === line)
    ) {
      matches.push(index);
    }
  }
  if (matches.length > 1) {
    throw new SearchReplaceAmbiguousError(
      "SEARCH text matches more than one location",
    );
  }
  const index = matches[0];
  if (index === undefined) {
    return undefined;
  }
  return [
    ...wholeLines.slice(0, index),
    ...replacementLines,
    ...wholeLines.slice(index + searchLines.length),
  ].join("");
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

function replaceWithLeadingWhitespace(
  wholeLines: readonly string[],
  originalSearchLines: readonly string[],
  originalReplacementLines: readonly string[],
): string | undefined {
  const nonblank = [...originalSearchLines, ...originalReplacementLines].filter(
    (line) => line.trim() !== "",
  );
  const remove = Math.min(
    ...nonblank.map((line) => leadingWhitespace(line).length),
  );
  const searchLines = originalSearchLines.map((line) =>
    line.trim() === "" ? line : line.slice(remove),
  );
  const replacementLines = originalReplacementLines.map((line) =>
    line.trim() === "" ? line : line.slice(remove),
  );
  const matches: { index: number; prefix: string }[] = [];

  for (
    let index = 0;
    index <= wholeLines.length - searchLines.length;
    index += 1
  ) {
    const prefixes = new Set<string>();
    let matchesContent = true;
    for (const [offset, searchLine] of searchLines.entries()) {
      const wholeLine = wholeLines[index + offset] ?? "";
      if (wholeLine.trimStart() !== searchLine.trimStart()) {
        matchesContent = false;
        break;
      }
      if (wholeLine.trim() !== "") {
        prefixes.add(wholeLine.slice(0, wholeLine.length - searchLine.length));
      }
    }
    if (matchesContent && prefixes.size === 1) {
      matches.push({ index, prefix: prefixes.values().next().value ?? "" });
    }
  }
  if (matches.length > 1) {
    throw new SearchReplaceAmbiguousError(
      "SEARCH text matches more than one location after indentation normalization",
    );
  }
  const match = matches[0];
  if (match === undefined) {
    return undefined;
  }
  const replacement = replacementLines.map((line) =>
    line.trim() === "" ? line : match.prefix + line,
  );
  return [
    ...wholeLines.slice(0, match.index),
    ...replacement,
    ...wholeLines.slice(match.index + searchLines.length),
  ].join("");
}

function splitEllipses(content: string): string[] {
  return content.split(/(^\s*\.\.\.\n)/m);
}

function replaceEllipses(
  whole: string,
  search: string,
  replacement: string,
): string | undefined {
  const searchPieces = splitEllipses(search);
  const replacementPieces = splitEllipses(replacement);
  if (searchPieces.length === 1) {
    return undefined;
  }
  if (
    searchPieces.length !== replacementPieces.length ||
    searchPieces.some(
      (piece, index) => index % 2 === 1 && piece !== replacementPieces[index],
    )
  ) {
    throw new SearchReplaceParseError(
      "SEARCH and REPLACE must contain matching `...` lines",
    );
  }

  let result = whole;
  for (let index = 0; index < searchPieces.length; index += 2) {
    const searchPiece = searchPieces[index] ?? "";
    const replacementPiece = replacementPieces[index] ?? "";
    if (searchPiece === "") {
      if (replacementPiece !== "") {
        result = result.endsWith("\n")
          ? result + replacementPiece
          : `${result}\n${replacementPiece}`;
      }
      continue;
    }
    const first = result.indexOf(searchPiece);
    if (first < 0) {
      return undefined;
    }
    if (result.indexOf(searchPiece, first + searchPiece.length) >= 0) {
      throw new SearchReplaceAmbiguousError(
        "An elided SEARCH section matches more than one location",
      );
    }
    result =
      result.slice(0, first) +
      replacementPiece +
      result.slice(first + searchPiece.length);
  }
  return result;
}

export function applySearchReplace(
  content: string,
  search: string,
  replacement: string,
  path = "file",
): string {
  const whole = prepare(content);
  const part = prepare(search);
  const updated = prepare(replacement);
  if (part.content.trim() === "") {
    return whole.content + updated.content;
  }

  const exact = replaceUniqueLines(whole.lines, part.lines, updated.lines);
  if (exact !== undefined) {
    return exact;
  }
  const whitespace = replaceWithLeadingWhitespace(
    whole.lines,
    part.lines,
    updated.lines,
  );
  if (whitespace !== undefined) {
    return whitespace;
  }
  if (part.lines.length > 2 && part.lines[0]?.trim() === "") {
    const withoutBlank = replaceWithLeadingWhitespace(
      whole.lines,
      part.lines.slice(1),
      updated.lines,
    );
    if (withoutBlank !== undefined) {
      return withoutBlank;
    }
  }
  const elided = replaceEllipses(whole.content, part.content, updated.content);
  if (elided !== undefined) {
    return elided;
  }
  throw new SearchReplaceNoMatchError(
    `SEARCH block failed to match ${path}:\n<<<<<<< SEARCH\n${search}=======\n${replacement}>>>>>>> REPLACE`,
  );
}
