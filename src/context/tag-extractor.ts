/**
 * Ported from aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to use web-tree-sitter and root-contained asynchronous file reads.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";
import { extname, relative } from "node:path";

import { Language, Parser, Query } from "web-tree-sitter";

import { SafePathResolver } from "../io/safe-path.js";
import {
  repoMapGrammarPath,
  repoMapQueryPath,
  repoMapResourceFingerprint,
  type RepoMapLanguage,
} from "./repomap-resources.js";

export interface RepoMapTag {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly kind: "definition" | "reference";
}

const EXTENSIONS: Readonly<Record<string, RepoMapLanguage>> = {
  ".bash": "bash",
  ".c": "cpp",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "c-sharp",
  ".cxx": "cpp",
  ".go": "go",
  ".h": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "bash",
  ".ts": "typescript",
  ".tsx": "tsx",
} as const;

let parserInitialization: Promise<void> | undefined;

function initializeParser(): Promise<void> {
  parserInitialization ??= Parser.init();
  return parserInitialization;
}

export function languageForPath(path: string): RepoMapLanguage | undefined {
  return EXTENSIONS[extname(path).toLowerCase()];
}

const LEXICAL_IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]{2,}/gu;
/** Bounds what one unparsed file can contribute to the ranking graph. */
const MAX_LEXICAL_REFERENCES = 200;

/**
 * Identifiers from a file no bundled grammar covers, recorded as references.
 *
 * A file Patch cannot parse is not therefore irrelevant: a config file, a
 * Markdown document, or a language without a query still mentions the symbols a
 * request is about, and those mentions are what rank the files that define them.
 * They are references only — nothing here can tell a definition from a mention.
 */
export function lexicalReferences(
  path: string,
  source: string,
): readonly RepoMapTag[] {
  // A NUL byte means this is not text, and its "identifiers" would be noise.
  if (source.includes("\0")) return [];
  const seen = new Set<string>();
  const tags: RepoMapTag[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    for (const match of line.matchAll(LEXICAL_IDENTIFIER)) {
      const name = match[0];
      if (seen.has(name)) continue;
      seen.add(name);
      tags.push({ path, line: index, name, kind: "reference" });
      if (tags.length >= MAX_LEXICAL_REFERENCES) return tags;
    }
  }
  return tags;
}

export class TagExtractor {
  readonly #resolver: SafePathResolver;
  readonly #languages = new Map<RepoMapLanguage, Promise<Language>>();
  readonly #queries = new Map<RepoMapLanguage, Promise<string>>();

  /** Identifies the queries and grammars these tags were extracted with. */
  readonly fingerprint: string;

  private constructor(resolver: SafePathResolver, fingerprint: string) {
    this.#resolver = resolver;
    this.fingerprint = fingerprint;
  }

  static async create(root: string): Promise<TagExtractor> {
    await initializeParser();
    return new TagExtractor(
      await SafePathResolver.create(root),
      await repoMapResourceFingerprint(),
    );
  }

  async extract(path: string): Promise<readonly RepoMapTag[]> {
    const languageName = languageForPath(path);
    const absolutePath = await this.#resolver.resolve(path);
    const source = await readFile(absolutePath, "utf8");
    if (source.length === 0) {
      return [];
    }
    if (languageName === undefined) {
      return lexicalReferences(path, source);
    }

    const [language, querySource] = await Promise.all([
      this.#loadLanguage(languageName),
      this.#loadQuery(languageName),
    ]);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (tree === null) {
      parser.delete();
      throw new Error(`Tree-sitter did not produce a tree for ${path}`);
    }

    const query = new Query(language, querySource);
    try {
      const relativePath = relative(this.#resolver.root, absolutePath);
      return query.captures(tree.rootNode).flatMap((capture): RepoMapTag[] => {
        const kind = capture.name.startsWith("name.definition.")
          ? "definition"
          : capture.name.startsWith("name.reference.")
            ? "reference"
            : undefined;
        return kind === undefined
          ? []
          : [
              {
                path: relativePath,
                line: capture.node.startPosition.row,
                name: capture.node.text,
                kind,
              },
            ];
      });
    } finally {
      query.delete();
      tree.delete();
      parser.delete();
    }
  }

  #loadLanguage(language: RepoMapLanguage): Promise<Language> {
    let loaded = this.#languages.get(language);
    if (loaded === undefined) {
      loaded = Language.load(repoMapGrammarPath(language));
      this.#languages.set(language, loaded);
    }
    return loaded;
  }

  #loadQuery(language: RepoMapLanguage): Promise<string> {
    let loaded = this.#queries.get(language);
    if (loaded === undefined) {
      loaded = readFile(repoMapQueryPath(language), "utf8");
      this.#queries.set(language, loaded);
    }
    return loaded;
  }
}
