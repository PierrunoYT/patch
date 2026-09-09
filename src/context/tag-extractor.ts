/**
 * Ported from aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to use web-tree-sitter and root-contained asynchronous file reads.
 */

import { readFile } from "node:fs/promises";
import { extname, relative } from "node:path";

import { Language, Parser, Query } from "web-tree-sitter";

import { SafePathResolver } from "../io/safe-path.js";
import {
  repoMapGrammarPath,
  repoMapQueryPath,
  type RepoMapLanguage,
} from "./repomap-resources.js";

export interface RepoMapTag {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly kind: "definition" | "reference";
}

const EXTENSIONS: Readonly<Record<string, RepoMapLanguage>> = {
  ".cjs": "javascript",
  ".go": "go",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
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

export class TagExtractor {
  readonly #resolver: SafePathResolver;
  readonly #languages = new Map<RepoMapLanguage, Promise<Language>>();
  readonly #queries = new Map<RepoMapLanguage, Promise<string>>();

  private constructor(resolver: SafePathResolver) {
    this.#resolver = resolver;
  }

  static async create(root: string): Promise<TagExtractor> {
    await initializeParser();
    return new TagExtractor(await SafePathResolver.create(root));
  }

  async extract(path: string): Promise<readonly RepoMapTag[]> {
    const languageName = languageForPath(path);
    if (languageName === undefined) {
      return [];
    }

    const absolutePath = await this.#resolver.resolve(path);
    const source = await readFile(absolutePath, "utf8");
    if (source.length === 0) {
      return [];
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
