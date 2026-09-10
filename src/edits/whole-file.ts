/**
 * Ported from aider/coders/wholefile_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to return provider-neutral rewrite edits without touching disk.
 * Licensed under the Apache License, Version 2.0.
 */

import { basename } from "node:path";

import type { EditStrategy, EditStrategyContext } from "./strategy.js";
import type { Edit, EditBatch } from "./types.js";

type FilenameSource = "block" | "saw" | "chat";

interface PendingRewrite {
  path: string;
  source: FilenameSource;
  lines: string[];
}

export class WholeFileParseError extends Error {
  override readonly name = "WholeFileParseError";
}

function splitLinesKeepingEndings(content: string): string[] {
  return content.match(/.*(?:\r\n|\n|\r)|.+$/g) ?? [];
}

function cleanFilename(line: string): string {
  const cleaned = line
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .replace(/:$/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^#+/, "")
    .trim();
  return cleaned.length <= 250 ? cleaned : "";
}

function inferFilename(
  previousLine: string | undefined,
  sawFilename: string | undefined,
  editablePaths: readonly string[],
): { path: string; source: FilenameSource } {
  let path = previousLine === undefined ? "" : cleanFilename(previousLine);
  if (
    path !== "" &&
    !editablePaths.includes(path) &&
    editablePaths.includes(basename(path))
  ) {
    path = basename(path);
  }
  if (path !== "") {
    return { path, source: "block" };
  }
  if (sawFilename !== undefined) {
    return { path: sawFilename, source: "saw" };
  }
  if (editablePaths.length === 1) {
    return { path: editablePaths[0] ?? "", source: "chat" };
  }
  throw new WholeFileParseError(
    "No filename was provided before a whole-file fenced block",
  );
}

function mentionedFilename(
  line: string,
  editablePaths: readonly string[],
): string | undefined {
  const words = line.trim().split(/\s+/);
  for (const rawWord of words) {
    const word = rawWord.replace(/[.:,;!]+$/, "");
    const match = editablePaths.find((path) => word === `\`${path}\``);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

export class WholeFileEditStrategy implements EditStrategy {
  readonly format = "whole" as const;

  parse(response: string, context: EditStrategyContext): EditBatch {
    const lines = splitLinesKeepingEndings(response);
    const pending: PendingRewrite[] = [];
    let active: PendingRewrite | undefined;
    let sawFilename: string | undefined;

    for (const [index, line] of lines.entries()) {
      if (
        line.startsWith(context.fence[0]) ||
        line.startsWith(context.fence[1])
      ) {
        if (active !== undefined) {
          pending.push(active);
          active = undefined;
          sawFilename = undefined;
        } else {
          const inferred = inferFilename(
            lines[index - 1],
            sawFilename,
            context.editablePaths,
          );
          active = { ...inferred, lines: [] };
        }
      } else if (active !== undefined) {
        active.lines.push(line);
      } else {
        sawFilename =
          mentionedFilename(line, context.editablePaths) ?? sawFilename;
      }
    }

    if (active !== undefined) {
      pending.push(active);
    }

    const edits: Edit[] = [];
    const seen = new Set<string>();
    for (const source of ["block", "saw", "chat"] as const) {
      for (const rewrite of pending) {
        if (rewrite.source === source && !seen.has(rewrite.path)) {
          seen.add(rewrite.path);
          edits.push({
            kind: "rewrite",
            path: rewrite.path,
            content: rewrite.lines.join(""),
          });
        }
      }
    }

    return { edits, shellCommands: [] };
  }
}
