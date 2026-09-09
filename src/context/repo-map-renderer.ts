/**
 * Ported from aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for asynchronous TypeScript rendering and a strict token ceiling.
 */

import type { RankedRepoMapTag } from "./repo-graph.js";
import { TreeContextRenderer } from "./tree-context.js";

export type TextTokenCounter = (text: string) => number;

export interface RepoMapRenderOptions {
  readonly root: string;
  readonly rankedTags: readonly RankedRepoMapTag[];
  readonly otherPaths: readonly string[];
  readonly chatPaths?: ReadonlySet<string>;
  readonly maxTokens: number;
  readonly countTokens: TextTokenCounter;
}

type MapEntry =
  | { readonly path: string; readonly line: number }
  | { readonly path: string; readonly line?: undefined };

async function renderEntries(
  renderer: TreeContextRenderer,
  entries: readonly MapEntry[],
  chatPaths: ReadonlySet<string>,
): Promise<string> {
  if (entries.length === 0) return "";
  const grouped = new Map<string, Set<number> | undefined>();
  for (const entry of [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    if (chatPaths.has(entry.path)) continue;
    const current = grouped.get(entry.path);
    if (entry.line === undefined) {
      if (!grouped.has(entry.path)) grouped.set(entry.path, undefined);
    } else {
      const lines = current ?? new Set<number>();
      lines.add(entry.line);
      grouped.set(entry.path, lines);
    }
  }

  let output = "";
  for (const [path, lines] of grouped) {
    if (lines === undefined) {
      output += `\n${path}\n`;
    } else {
      output += `\n${path}:\n${await renderer.render(path, lines)}`;
    }
  }
  if (output.length === 0) return "";
  return `${output
    .split("\n")
    .map((line) => line.slice(0, 100))
    .join("\n")}\n`;
}

export async function renderRepoMap(
  options: RepoMapRenderOptions,
): Promise<string> {
  if (options.maxTokens <= 0 || options.otherPaths.length === 0) return "";
  const renderer = await TreeContextRenderer.create(options.root);
  const rankedEntries: MapEntry[] = options.rankedTags.map(({ tag }) => ({
    path: tag.path,
    line: tag.line,
  }));
  const taggedPaths = new Set(rankedEntries.map((entry) => entry.path));
  const bareEntries: MapEntry[] = [...new Set(options.otherPaths)]
    .filter((path) => !taggedPaths.has(path))
    .sort()
    .map((path) => ({ path }));
  const entries = [...rankedEntries, ...bareEntries];
  const chatPaths = options.chatPaths ?? new Set<string>();

  let lower = 0;
  let upper = entries.length;
  let best = "";
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = await renderEntries(
      renderer,
      entries.slice(0, middle),
      chatPaths,
    );
    if (options.countTokens(candidate) <= options.maxTokens) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best;
}
