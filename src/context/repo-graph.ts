/**
 * Ported from aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to use a deterministic local weighted PageRank implementation.
 */

import { basename, extname } from "node:path";

import type { RepoMapTag } from "./tag-extractor.js";

export interface RankOptions {
  readonly chatPaths?: ReadonlySet<string>;
  readonly mentionedPaths?: ReadonlySet<string>;
  readonly mentionedIdentifiers?: ReadonlySet<string>;
}

export interface RankedRepoMapTag {
  readonly rank: number;
  readonly tag: RepoMapTag;
}

interface Edge {
  readonly source: string;
  readonly target: string;
  readonly identifier: string;
  weight: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathComponents(path: string): Set<string> {
  const name = basename(path);
  return new Set([
    ...path.split(/[\\/]/u),
    name,
    name.slice(0, name.length - extname(name).length),
  ]);
}

function identifierMultiplier(
  identifier: string,
  definitionCount: number,
  mentioned: ReadonlySet<string>,
): number {
  let multiplier = 1;
  const hasLetters = /[A-Za-z]/u.test(identifier);
  const descriptive =
    hasLetters &&
    identifier.length >= 8 &&
    (identifier.includes("_") ||
      identifier.includes("-") ||
      (/[A-Z]/u.test(identifier) && /[a-z]/u.test(identifier)));
  if (mentioned.has(identifier)) multiplier *= 10;
  if (descriptive) multiplier *= 10;
  if (identifier.startsWith("_")) multiplier *= 0.1;
  if (definitionCount > 5) multiplier *= 0.1;
  return multiplier;
}

function pageRank(
  nodes: readonly string[],
  edges: readonly Edge[],
  personalization: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  if (nodes.length === 0) return new Map();
  const alpha = 0.85;
  const uniform = 1 / nodes.length;
  const personalizationTotal = [...personalization.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const distribution = new Map(
    nodes.map((node) => [
      node,
      personalizationTotal === 0
        ? uniform
        : (personalization.get(node) ?? 0) / personalizationTotal,
    ]),
  );
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    const nodeEdges = outgoing.get(edge.source) ?? [];
    nodeEdges.push(edge);
    outgoing.set(edge.source, nodeEdges);
  }
  for (const nodeEdges of outgoing.values()) {
    nodeEdges.sort((left, right) =>
      compareText(
        `${left.target}\0${left.identifier}`,
        `${right.target}\0${right.identifier}`,
      ),
    );
  }

  let ranks = new Map(nodes.map((node) => [node, uniform]));
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const dangling = nodes.reduce(
      (sum, node) => sum + (outgoing.has(node) ? 0 : (ranks.get(node) ?? 0)),
      0,
    );
    const next = new Map(
      nodes.map((node) => {
        const personalized = distribution.get(node) ?? 0;
        return [
          node,
          (1 - alpha) * personalized + alpha * dangling * personalized,
        ];
      }),
    );
    for (const source of nodes) {
      const nodeEdges = outgoing.get(source);
      if (nodeEdges === undefined) continue;
      const totalWeight = nodeEdges.reduce((sum, edge) => sum + edge.weight, 0);
      for (const edge of nodeEdges) {
        next.set(
          edge.target,
          (next.get(edge.target) ?? 0) +
            alpha * (ranks.get(source) ?? 0) * (edge.weight / totalWeight),
        );
      }
    }
    const error = nodes.reduce(
      (sum, node) =>
        sum + Math.abs((next.get(node) ?? 0) - (ranks.get(node) ?? 0)),
      0,
    );
    ranks = next;
    if (error < nodes.length * 1e-6) break;
  }
  return ranks;
}

export function rankRepoMapTags(
  tags: readonly RepoMapTag[],
  options: RankOptions = {},
): readonly RankedRepoMapTag[] {
  const chatPaths = options.chatPaths ?? new Set<string>();
  const mentionedPaths = options.mentionedPaths ?? new Set<string>();
  const mentionedIdentifiers =
    options.mentionedIdentifiers ?? new Set<string>();
  const allPaths = [...new Set(tags.map((tag) => tag.path))].sort();
  if (allPaths.length === 0) return [];

  const definitions = new Map<string, RepoMapTag[]>();
  const references = new Map<string, string[]>();
  for (const tag of tags) {
    if (tag.kind === "definition") {
      const entries = definitions.get(tag.name) ?? [];
      entries.push(tag);
      definitions.set(tag.name, entries);
    } else {
      const entries = references.get(tag.name) ?? [];
      entries.push(tag.path);
      references.set(tag.name, entries);
    }
  }
  if (references.size === 0) {
    for (const [identifier, entries] of definitions) {
      references.set(
        identifier,
        entries.map((entry) => entry.path),
      );
    }
  }

  const personalization = new Map<string, number>();
  const base = 100 / allPaths.length;
  for (const path of allPaths) {
    let value = chatPaths.has(path) || mentionedPaths.has(path) ? base : 0;
    if (
      [...pathComponents(path)].some((part) => mentionedIdentifiers.has(part))
    ) {
      value += base;
    }
    if (value > 0) personalization.set(path, value);
  }

  const edges = new Map<string, Edge>();
  const addEdge = (edge: Edge): void => {
    const key = `${edge.source}\0${edge.target}\0${edge.identifier}`;
    const existing = edges.get(key);
    if (existing === undefined) edges.set(key, edge);
    else existing.weight += edge.weight;
  };

  for (const identifier of [...definitions.keys()].sort()) {
    const definers = [
      ...new Set(definitions.get(identifier)?.map((tag) => tag.path)),
    ].sort();
    const identifierReferences = references.get(identifier);
    if (identifierReferences === undefined) {
      for (const definer of definers) {
        addEdge({
          source: definer,
          target: definer,
          identifier,
          weight: 0.1,
        });
      }
      continue;
    }
    const counts = new Map<string, number>();
    for (const referencer of identifierReferences) {
      counts.set(referencer, (counts.get(referencer) ?? 0) + 1);
    }
    const multiplier = identifierMultiplier(
      identifier,
      definers.length,
      mentionedIdentifiers,
    );
    for (const referencer of [...counts.keys()].sort()) {
      for (const definer of definers) {
        addEdge({
          source: referencer,
          target: definer,
          identifier,
          weight:
            multiplier *
            Math.sqrt(counts.get(referencer) ?? 0) *
            (chatPaths.has(referencer) ? 50 : 1),
        });
      }
    }
  }

  const edgeList = [...edges.values()].sort((left, right) =>
    compareText(
      `${left.source}\0${left.target}\0${left.identifier}`,
      `${right.source}\0${right.target}\0${right.identifier}`,
    ),
  );
  const nodes = [
    ...new Set(edgeList.flatMap((edge) => [edge.source, edge.target])),
  ].sort();
  const ranks = pageRank(nodes, edgeList, personalization);
  const definitionRanks = new Map<string, number>();
  for (const edge of edgeList) {
    const sourceEdges = edgeList.filter(
      (candidate) => candidate.source === edge.source,
    );
    const totalWeight = sourceEdges.reduce(
      (sum, candidate) => sum + candidate.weight,
      0,
    );
    const key = `${edge.target}\0${edge.identifier}`;
    definitionRanks.set(
      key,
      (definitionRanks.get(key) ?? 0) +
        (ranks.get(edge.source) ?? 0) * (edge.weight / totalWeight),
    );
  }

  return [...definitionRanks.entries()]
    .flatMap(([key, rank]): RankedRepoMapTag[] => {
      const separator = key.indexOf("\0");
      const path = key.slice(0, separator);
      const identifier = key.slice(separator + 1);
      if (chatPaths.has(path)) return [];
      return (definitions.get(identifier) ?? [])
        .filter((tag) => tag.path === path)
        .map((tag) => ({ tag, rank }));
    })
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        compareText(right.tag.path, left.tag.path) ||
        compareText(right.tag.name, left.tag.name) ||
        left.tag.line - right.tag.line,
    );
}
