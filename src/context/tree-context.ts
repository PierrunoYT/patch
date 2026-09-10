/**
 * Ported from grep_ast.TreeContext as used by aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to use web-tree-sitter and emit deterministic plain-text context.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";

import { Language, Parser } from "web-tree-sitter";

import { SafePathResolver } from "../io/safe-path.js";
import { repoMapGrammarPath } from "./repomap-resources.js";
import { languageForPath } from "./tag-extractor.js";

let parserInitialization: Promise<void> | undefined;

function initializeParser(): Promise<void> {
  parserInitialization ??= Parser.init();
  return parserInitialization;
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
    const lines = source.replace(/\r\n?/gu, "\n").split("\n");
    const selected = new Set(
      [...linesOfInterest].filter((line) => line >= 0 && line < lines.length),
    );
    const languageName = languageForPath(path);

    if (languageName !== undefined && source.length > 0) {
      let loaded = this.#languages.get(languageName);
      if (loaded === undefined) {
        loaded = Language.load(repoMapGrammarPath(languageName));
        this.#languages.set(languageName, loaded);
      }
      const parser = new Parser();
      parser.setLanguage(await loaded);
      const tree = parser.parse(source);
      if (tree !== null) {
        for (const line of [...selected]) {
          let node = tree.rootNode.namedDescendantForPosition({
            row: line,
            column: lines[line]?.search(/\S/u) ?? 0,
          });
          while (node !== null && node.parent !== null) {
            if (
              node.startPosition.row < line &&
              /(?:class|function|method|interface|trait|impl|module|mod)[_.]/u.test(
                node.type,
              )
            )
              selected.add(node.startPosition.row);
            node = node.parent;
          }
        }
        tree.delete();
      }
      parser.delete();
    }

    const output: string[] = [];
    let previous = -1;
    for (const line of [...selected].sort((left, right) => left - right)) {
      if (line > previous + 1) output.push("⋮");
      output.push(`│${lines[line] ?? ""}`);
      previous = line;
    }
    if (previous < lines.length - 2) output.push("⋮");
    return `${output.join("\n")}\n`;
  }
}
