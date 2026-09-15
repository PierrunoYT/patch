/**
 * Ported from grep_ast.TreeContext as used by aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to use web-tree-sitter and emit deterministic plain-text context.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";

import { Language, Parser, type Node } from "web-tree-sitter";

import { SafePathResolver } from "../io/safe-path.js";
import { repoMapGrammarPath } from "./repomap-resources.js";
import { languageForPath } from "./tag-extractor.js";

let parserInitialization: Promise<void> | undefined;

function initializeParser(): Promise<void> {
  parserInitialization ??= Parser.init();
  return parserInitialization;
}

type Header = readonly [size: number, start: number, end: number];

function walkTree(
  node: Node,
  scopes: readonly Set<number>[],
  headers: readonly Header[][],
): void {
  const start = node.startPosition.row;
  const end = Math.min(node.endPosition.row, scopes.length - 1);
  if (start < 0 || start >= scopes.length || end < start) return;
  if (end > start) headers[start]?.push([end - start, start, end]);
  for (let line = start; line <= end; line += 1) scopes[line]?.add(start);
  for (const child of node.children) walkTree(child, scopes, headers);
}

function addParentHeaders(
  line: number,
  selected: Set<number>,
  scopes: readonly Set<number>[],
  headers: readonly Header[][],
): void {
  for (const scope of scopes[line] ?? []) {
    const candidates = [...(headers[scope] ?? [])].sort(
      (left, right) =>
        left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
    );
    let start = scope;
    let end = scope + 1;
    if (candidates.length > 1) {
      const candidate = candidates[0];
      if (candidate !== undefined) {
        start = candidate[1];
        end = candidate[0] > 10 ? candidate[1] + 10 : candidate[2];
      }
    }
    if (start === 0) continue;
    for (let header = start; header < end; header += 1) selected.add(header);
  }
}

export class TreeContextRenderer {
  readonly #resolver: SafePathResolver;
  readonly #languages = new Map<string, Promise<Language>>();

  private constructor(resolver: SafePathResolver) {
    this.#resolver = resolver;
  }

  static async create(root: string): Promise<TreeContextRenderer> {
    await initializeParser();
    return new TreeContextRenderer(await SafePathResolver.create(root));
  }

  async render(
    path: string,
    linesOfInterest: ReadonlySet<number>,
  ): Promise<string> {
    if (linesOfInterest.size === 0) return "";
    const absolutePath = await this.#resolver.resolve(path);
    const source = await readFile(absolutePath, "utf8");
    const normalized = source.replace(/\r\n?/gu, "\n");
    const code = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    const lines = code.split("\n");
    lines.pop();
    const selected = new Set(
      [...linesOfInterest].filter((line) => line >= 0 && line < lines.length),
    );
    const languageName = languageForPath(path);

    if (languageName !== undefined && source.length > 0 && lines.length > 0) {
      let loaded = this.#languages.get(languageName);
      if (loaded === undefined) {
        loaded = Language.load(repoMapGrammarPath(languageName));
        this.#languages.set(languageName, loaded);
      }
      const parser = new Parser();
      try {
        parser.setLanguage(await loaded);
        const tree = parser.parse(code);
        if (tree !== null) {
          const scopes = Array.from(
            { length: lines.length },
            () => new Set<number>(),
          );
          const headers = Array.from(
            { length: lines.length },
            () => [] as Header[],
          );
          walkTree(tree.rootNode, scopes, headers);
          for (const line of linesOfInterest) {
            if (line >= 0 && line < lines.length)
              addParentHeaders(line, selected, scopes, headers);
          }
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    }

    const output: string[] = [];
    let dots = !selected.has(0);
    for (let line = 0; line < lines.length; line += 1) {
      if (!selected.has(line)) {
        if (dots) {
          output.push("⋮");
          dots = false;
        }
        continue;
      }
      output.push(`│${lines[line] ?? ""}`);
      dots = true;
    }
    return output.length === 0 ? "" : `${output.join("\n")}\n`;
  }
}
