import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RepoMapLanguage =
  | "bash"
  | "c-sharp"
  | "cpp"
  | "go"
  | "java"
  | "javascript"
  | "python"
  | "ruby"
  | "rust"
  | "typescript"
  | "tsx";

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

export const REPO_MAP_LANGUAGES: readonly RepoMapLanguage[] = [
  "bash",
  "c-sharp",
  "cpp",
  "go",
  "java",
  "javascript",
  "python",
  "ruby",
  "rust",
  "typescript",
  "tsx",
];

/** Bump when extraction itself changes shape without a query or grammar edit. */
const EXTRACTOR_VERSION = "2";

let cachedFingerprint: Promise<string> | undefined;

/**
 * Identifies the extraction inputs, so cached tags are discarded when the tags
 * they would produce change.
 *
 * Query text is hashed because editing a `.scm` is the common case; grammars are
 * identified by size rather than content because the wasm files are megabytes
 * and would make every startup pay to hash them.
 */
export function repoMapResourceFingerprint(): Promise<string> {
  cachedFingerprint ??= (async () => {
    const hash = createHash("sha256").update(EXTRACTOR_VERSION);
    for (const language of REPO_MAP_LANGUAGES) {
      hash.update(language);
      try {
        hash.update(await readFile(repoMapQueryPath(language)));
        hash.update(String((await stat(repoMapGrammarPath(language))).size));
      } catch {
        // A language whose resources are missing contributes nothing; the
        // extractor already reports that separately.
        hash.update("absent");
      }
    }
    return hash.digest("hex").slice(0, 16);
  })();
  return cachedFingerprint;
}
