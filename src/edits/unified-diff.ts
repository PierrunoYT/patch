/**
 * Ported from aider/coders/udiff_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to parse into Patch's provider-neutral edits and apply purely
 * against caller-owned snapshots.
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

function beforeAfter(lines: readonly string[]): [string, string] {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    const operation = line[0];
    const content = line.slice(1);
    if (operation === " " || operation === "-") before.push(content);
    if (operation === " " || operation === "+") after.push(content);
  }
  return [
    before.length === 0 ? "" : `${before.join("\n")}\n`,
    after.length === 0 ? "" : `${after.join("\n")}\n`,
  ];
}

export function applyUnifiedDiff(
  content: string,
  before: string,
  after: string,
  path: string,
): string {
  if (before === "") return content + after;
  const matches: number[] = [];
  for (
    let index = content.indexOf(before);
    index >= 0;
    index = content.indexOf(before, index + 1)
  ) {
    matches.push(index);
  }
  if (matches.length === 0) {
    throw new UnifiedDiffNoMatchError(
      `UnifiedDiffNoMatch: ${path} does not contain the ${before.split(/\r?\n/u).filter(Boolean).length} exact lines in the hunk`,
    );
  }
  if (matches.length > 1) {
    throw new UnifiedDiffNotUniqueError(
      `UnifiedDiffNotUnique: ${path} contains multiple copies of the hunk; add context lines`,
    );
  }
  const index = matches[0] ?? 0;
  return content.slice(0, index) + after + content.slice(index + before.length);
}

export class UnifiedDiffEditStrategy implements EditStrategy {
  readonly format = "udiff" as const;

  parse(response: string, _context: EditStrategyContext): EditBatch {
    void _context;
    const edits: Edit[] = [];
    const blocks = response.matchAll(/```diff\s*\n([\s\S]*?)(?:```|$)/gu);
    let lastPath: string | undefined;
    for (const match of blocks) {
      const lines = (match[1] ?? "").split(/\r?\n/u);
      let path = lastPath;
      let index = 0;
      if (lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ")) {
        const destination = lines[1].slice(4).trim();
        path = destination.startsWith("b/")
          ? destination.slice(2)
          : destination;
        lastPath = path;
        index = 2;
      }
      while (index < lines.length) {
        if (!lines[index]?.startsWith("@@")) {
          index += 1;
          continue;
        }
        index += 1;
        const hunk: string[] = [];
        while (index < lines.length && !lines[index]?.startsWith("@@")) {
          const line = lines[index] ?? "";
          if (line !== "" && ![" ", "+", "-"].includes(line[0] ?? "")) {
            throw new UnifiedDiffParseError(
              `Invalid unified diff line: ${line}`,
            );
          }
          if (line !== "") hunk.push(line);
          index += 1;
        }
        if (path === undefined) {
          throw new UnifiedDiffParseError(
            "Unified diff is missing a file path",
          );
        }
        if (hunk.some((line) => line.startsWith("+") || line.startsWith("-"))) {
          const [search, replacement] = beforeAfter(hunk);
          edits.push({
            kind: "replace",
            path,
            search,
            replacement,
            protocol: "udiff",
          });
        }
      }
    }
    return { edits, shellCommands: [] };
  }
}
