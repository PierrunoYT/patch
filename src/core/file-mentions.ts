/**
 * Ported from aider/coders/base_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to operate on explicit repository-relative candidate lists.
 */

import { basename } from "node:path";

const TRAILING_PUNCTUATION = /[,.!;:?]+$/;
const SURROUNDING_MARKUP = /^["'`*_]+|["'`*_]+$/g;

function words(content: string): Set<string> {
  return new Set(
    content
      .split(/\s+/)
      .map((word) =>
        word
          .replace(TRAILING_PUNCTUATION, "")
          .replace(SURROUNDING_MARKUP, "")
          .replaceAll("\\", "/"),
      ),
  );
}

export function findFileMentions(
  content: string,
  candidates: readonly string[],
  selectedPaths: readonly string[] = [],
): string[] {
  const contentWords = words(content);
  const selectedBasenames = new Set(
    selectedPaths.map((path) => basename(path)),
  );
  const basenameCandidates = new Map<string, string[]>();
  const mentioned = new Set<string>();

  for (const path of candidates) {
    const normalized = path.replaceAll("\\", "/");
    if (contentWords.has(normalized)) {
      mentioned.add(path);
    }
    const name = basename(path);
    if (/[._-]/.test(name)) {
      basenameCandidates.set(name, [
        ...(basenameCandidates.get(name) ?? []),
        path,
      ]);
    }
  }

  for (const [name, paths] of basenameCandidates) {
    if (
      paths.length === 1 &&
      !selectedBasenames.has(name) &&
      contentWords.has(name)
    ) {
      mentioned.add(paths[0] ?? "");
    }
  }
  return [...mentioned].filter(Boolean).sort();
}
