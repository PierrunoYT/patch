import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RepoMapLanguage =
  "go" | "javascript" | "python" | "rust" | "typescript";

const RESOURCE_ROOT = fileURLToPath(
  new URL("../resources/repomap", import.meta.url),
);
const GRAMMAR_ROOT = dirname(
  fileURLToPath(import.meta.resolve("@vscode/tree-sitter-wasm")),
);

export function repoMapQueryPath(language: RepoMapLanguage): string {
  return join(RESOURCE_ROOT, "queries", `${language}-tags.scm`);
}

export function repoMapGrammarPath(language: RepoMapLanguage): string {
  return join(GRAMMAR_ROOT, `tree-sitter-${language}.wasm`);
}

export async function assertRepoMapResources(
  language: RepoMapLanguage,
): Promise<void> {
  await Promise.all([
    access(repoMapQueryPath(language)),
    access(repoMapGrammarPath(language)),
  ]);
}
