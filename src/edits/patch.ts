/**
 * Ported from aider/coders/patch_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to produce immutable generic edits and expose accumulated fuzz.
 * Licensed under the Apache License, Version 2.0.
 */

import type { FileSnapshot } from "./resolve.js";
import type { EditStrategy, EditStrategyContext } from "./strategy.js";
import type { Edit, EditBatch } from "./types.js";

export class PatchParseError extends Error {
  override readonly name = "PatchParseError";
}

interface PatchChunk {
  /** Absolute line index in the original file where the change starts. */
  readonly index: number;
  readonly deleted: readonly string[];
  readonly inserted: readonly string[];
}

interface UpdateAction {
  readonly kind: "update";
  readonly path: string;
  readonly source: readonly string[];
  readonly chunks: PatchChunk[];
  movePath?: string;
}

type PatchAction =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | UpdateAction;

interface ParsedSection {
  readonly context: readonly string[];
  readonly chunks: readonly PatchChunk[];
  readonly index: number;
  readonly eof: boolean;
}

function findContext(
  lines: readonly string[],
  context: readonly string[],
  start: number,
  eof = false,
): [number, number] {
  for (const [normalize, fuzz] of [
    [(line: string) => line, 0],
    [(line: string) => line.trimEnd(), 1],
    [(line: string) => line.trim(), 100],
  ] as const) {
    const first = eof ? Math.max(start, lines.length - context.length) : start;
    for (
      let index = first;
      index <= lines.length - context.length;
      index += 1
    ) {
      if (
        context.every(
          (line, offset) =>
            normalize(lines[index + offset] ?? "") === normalize(line),
        )
      ) {
        return [index, fuzz];
      }
    }
  }
  if (eof) {
    const [index, fuzz] = findContext(lines, context, start);
    return [index, index < 0 ? fuzz : fuzz + 10_000];
  }
  return [-1, 0];
}

/**
 * Locates a named `@@` scope and returns the line index just past it. Upstream
 * retries the same stripped comparison with one fuzz point; that second pass
 * can never match where the first failed, so Patch runs the comparison once.
 */
function findScope(
  source: readonly string[],
  scopes: readonly string[],
  start: number,
): number {
  for (let index = start; index <= source.length - scopes.length; index += 1) {
    if (
      scopes.every(
        (scope, offset) => (source[index + offset] ?? "").trim() === scope,
      )
    ) {
      return index + scopes.length;
    }
  }
  throw new PatchParseError(
    `Could not find scope context:\n${scopes.join("\n")}`,
  );
}

/** Parses one context/`-`/`+` section, returning chunks relative to it. */
function parseSection(lines: readonly string[], start: number): ParsedSection {
  const context: string[] = [];
  const chunks: PatchChunk[] = [];
  let deleted: string[] = [];
  let inserted: string[] = [];
  let mode: "keep" | "add" | "delete" = "keep";
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("@@") || line.startsWith("***")) break;
    index += 1;
    const previous = mode;
    let content: string;
    if (line.startsWith("+")) {
      mode = "add";
      content = line.slice(1);
    } else if (line.startsWith("-")) {
      mode = "delete";
      content = line.slice(1);
    } else if (line.startsWith(" ")) {
      mode = "keep";
      content = line.slice(1);
    } else if (line.trim() === "") {
      mode = "keep";
      content = "";
    } else {
      throw new PatchParseError(`Invalid update line: ${line}`);
    }

    if (mode === "keep" && previous !== "keep") {
      if (deleted.length > 0 || inserted.length > 0) {
        chunks.push({
          index: context.length - deleted.length,
          deleted,
          inserted,
        });
        deleted = [];
        inserted = [];
      }
    }

    if (mode === "delete") {
      deleted.push(content);
      // A deleted line is part of the original context block.
      context.push(content);
    } else if (mode === "add") {
      inserted.push(content);
    } else {
      context.push(content);
    }
  }

  if (deleted.length > 0 || inserted.length > 0) {
    chunks.push({ index: context.length - deleted.length, deleted, inserted });
  }

  let eof = false;
  if (lines[index] === "*** End of File") {
    index += 1;
    eof = true;
  }
  if (index === start && !eof) {
    throw new PatchParseError("Empty patch section found.");
  }
  return { context, chunks, index, eof };
}

/** Applies merged chunks to the original lines, rejecting overlapping ones. */
function applyChunks(
  path: string,
  source: readonly string[],
  chunks: readonly PatchChunk[],
): string {
  const output: string[] = [];
  let cursor = 0;
  for (const chunk of [...chunks].sort(
    (left, right) => left.index - right.index,
  )) {
    if (chunk.index < cursor) {
      throw new PatchParseError(
        `${path}: Overlapping or out-of-order chunk detected near line ${String(chunk.index + 1)}`,
      );
    }
    const removed = source.slice(
      chunk.index,
      chunk.index + chunk.deleted.length,
    );
    if (
      removed.length !== chunk.deleted.length ||
      removed.some(
        (line, offset) => line.trim() !== (chunk.deleted[offset] ?? "").trim(),
      )
    ) {
      throw new PatchParseError(
        `${path}: Mismatch applying patch near line ${String(chunk.index + 1)}`,
      );
    }
    output.push(...source.slice(cursor, chunk.index), ...chunk.inserted);
    cursor = chunk.index + chunk.deleted.length;
  }
  output.push(...source.slice(cursor));
  return `${output.join("\n")}\n`;
}

function snapshots(
  files: readonly FileSnapshot[] | undefined,
): Map<string, string | null> {
  return new Map((files ?? []).map((file) => [file.path, file.content]));
}

function sourceLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export class PatchEditStrategy implements EditStrategy {
  readonly format = "patch" as const;

  parse(response: string, context: EditStrategyContext): EditBatch {
    const lines = response.split(/\r?\n/u);
    const contents = snapshots(context.files);
    /** Insertion-ordered, so one action per path is emitted in patch order. */
    const actions = new Map<string, PatchAction>();
    let fuzz = 0;
    let index = lines[0]?.trim() === "*** Begin Patch" ? 1 : 0;

    while (index < lines.length) {
      const header = lines[index] ?? "";
      if (header === "*** End Patch") break;
      if (header.trim() === "") {
        index += 1;
        continue;
      }

      if (header.startsWith("*** Add File: ")) {
        const path = header.slice(14).trim();
        if (path === "") {
          throw new PatchParseError("Add File action missing path.");
        }
        if (actions.has(path)) {
          throw new PatchParseError(`Duplicate action for file: ${path}`);
        }
        const added: string[] = [];
        index += 1;
        while (
          index < lines.length &&
          !(lines[index] ?? "").startsWith("*** ")
        ) {
          const line = lines[index] ?? "";
          if (!line.startsWith("+"))
            throw new PatchParseError(`Invalid Add File line: ${line}`);
          added.push(line.slice(1));
          index += 1;
        }
        actions.set(path, {
          kind: "add",
          path,
          content: `${added.join("\n")}\n`,
        });
        continue;
      }

      if (header.startsWith("*** Delete File: ")) {
        const path = header.slice(17).trim();
        if (path === "") {
          throw new PatchParseError("Delete File action missing path.");
        }
        index += 1;
        const existing = actions.get(path);
        if (existing !== undefined) {
          // A repeated delete is redundant, not a contradiction.
          if (existing.kind === "delete") continue;
          throw new PatchParseError(`Conflicting actions for file: ${path}`);
        }
        actions.set(path, { kind: "delete", path });
        continue;
      }

      if (!header.startsWith("*** Update File: "))
        throw new PatchParseError(`Unknown patch line: ${header}`);
      const path = header.slice(17).trim();
      if (path === "") {
        throw new PatchParseError("Update File action missing path.");
      }
      index += 1;
      let movePath: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        movePath = (lines[index] ?? "").slice(13).trim();
        if (movePath === "") {
          throw new PatchParseError("Move to action missing path.");
        }
        index += 1;
      }
      const original = contents.get(path);
      if (original === undefined || original === null)
        throw new PatchParseError(`Missing file content for ${path}`);

      const existing = actions.get(path);
      if (existing !== undefined && existing.kind !== "update") {
        throw new PatchParseError(`Conflicting actions for file: ${path}`);
      }
      const action: UpdateAction = existing ?? {
        kind: "update",
        path,
        source: sourceLines(original),
        chunks: [],
      };
      if (movePath !== undefined) {
        if (action.movePath !== undefined && action.movePath !== movePath) {
          throw new PatchParseError(
            `Conflicting move targets for file: ${path}`,
          );
        }
        action.movePath = movePath;
      }
      actions.set(path, action);

      // Every block of an update starts its own search at the file's first
      // line; merged chunks are ordered and overlap-checked when applied.
      let cursor = 0;
      while (index < lines.length && !(lines[index] ?? "").startsWith("*** ")) {
        const scopes: string[] = [];
        while (index < lines.length && (lines[index] ?? "").startsWith("@@")) {
          const scope = (lines[index] ?? "").slice(2).trim();
          if (scope !== "") scopes.push(scope);
          index += 1;
        }
        if (scopes.length > 0) {
          cursor = findScope(action.source, scopes, cursor);
        }

        const section = parseSection(lines, index);
        index = section.index;
        const [found, sectionFuzz] = findContext(
          action.source,
          section.context,
          cursor,
          section.eof,
        );
        if (found < 0)
          throw new PatchParseError(
            `Could not find patch context in ${path}:\n${section.context.join("\n")}`,
          );
        fuzz += sectionFuzz;
        for (const chunk of section.chunks) {
          action.chunks.push({ ...chunk, index: chunk.index + found });
        }
        cursor = found + section.context.length;
      }
    }

    const edits: Edit[] = [];
    for (const action of actions.values()) {
      if (action.kind === "add") {
        edits.push({
          kind: "create",
          path: action.path,
          content: action.content,
        });
        continue;
      }
      if (action.kind === "delete") {
        edits.push({ kind: "delete", path: action.path });
        continue;
      }
      const content = applyChunks(action.path, action.source, action.chunks);
      edits.push(
        action.movePath === undefined
          ? { kind: "rewrite", path: action.path, content }
          : {
              kind: "move",
              fromPath: action.path,
              path: action.movePath,
              content,
            },
      );
    }
    return { edits, shellCommands: [], fuzz };
  }
}
