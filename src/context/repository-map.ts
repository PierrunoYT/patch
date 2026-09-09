/**
 * Ported from aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for asynchronous Node.js cache files and explicit refresh contracts.
 */

import { performance } from "node:perf_hooks";

import { rankRepoMapTags } from "./repo-graph.js";
import { renderRepoMap, type TextTokenCounter } from "./repo-map-renderer.js";
import { RepoMapTagCache, type TagSource } from "./tag-cache.js";
import { TagExtractor, type RepoMapTag } from "./tag-extractor.js";

export type RepoMapRefresh = "manual" | "always" | "files" | "auto";

export interface RepositoryMapOptions {
  readonly root: string;
  readonly maxTokens: number;
  readonly countTokens: TextTokenCounter;
  readonly refresh?: RepoMapRefresh;
  readonly cacheFile?: string;
  readonly autoCacheThresholdMs?: number;
  readonly tagSource?: TagSource;
}

export interface RepositoryMapRequest {
  readonly chatPaths: readonly string[];
  readonly otherPaths: readonly string[];
  readonly mentionedPaths?: readonly string[];
  readonly mentionedIdentifiers?: readonly string[];
  readonly forceRefresh?: boolean;
}

function stableKey(values: readonly (readonly string[])[]): string {
  return JSON.stringify(values.map((value) => [...value].sort()));
}

export class RepositoryMap {
  readonly #root: string;
  readonly #maxTokens: number;
  readonly #countTokens: TextTokenCounter;
  readonly #refresh: RepoMapRefresh;
  readonly #autoCacheThresholdMs: number;
  readonly #tagCache: RepoMapTagCache;
  readonly #maps = new Map<string, string>();
  #lastMap: string | undefined;
  #lastProcessingMs = 0;

  private constructor(
    options: RepositoryMapOptions,
    tagCache: RepoMapTagCache,
  ) {
    this.#root = options.root;
    this.#maxTokens = options.maxTokens;
    this.#countTokens = options.countTokens;
    this.#refresh = options.refresh ?? "auto";
    this.#autoCacheThresholdMs = options.autoCacheThresholdMs ?? 1000;
    this.#tagCache = tagCache;
  }

  static async create(options: RepositoryMapOptions): Promise<RepositoryMap> {
    const source =
      options.tagSource ?? (await TagExtractor.create(options.root));
    const cache = await RepoMapTagCache.create(
      options.root,
      source,
      options.cacheFile ?? ".patch.tags.cache.v1.json",
    );
    return new RepositoryMap(options, cache);
  }

  async getMap(request: RepositoryMapRequest): Promise<string> {
    if (this.#maxTokens <= 0 || request.otherPaths.length === 0) return "";
    const fileKey = stableKey([request.chatPaths, request.otherPaths]);
    const autoKey = stableKey([
      request.chatPaths,
      request.otherPaths,
      request.mentionedPaths ?? [],
      request.mentionedIdentifiers ?? [],
    ]);
    const key = this.#refresh === "auto" ? autoKey : fileKey;

    if (!request.forceRefresh) {
      if (this.#refresh === "manual" && this.#lastMap !== undefined) {
        return this.#lastMap;
      }
      const shouldCache =
        this.#refresh === "files" ||
        (this.#refresh === "auto" &&
          this.#lastProcessingMs > this.#autoCacheThresholdMs);
      const cached = shouldCache ? this.#maps.get(key) : undefined;
      if (cached !== undefined) return cached;
    }

    const started = performance.now();
    const allPaths = [
      ...new Set([...request.chatPaths, ...request.otherPaths]),
    ].sort();
    const tags: RepoMapTag[] = [];
    for (const path of allPaths)
      tags.push(...(await this.#tagCache.tags(path)));
    const chatPaths = new Set(request.chatPaths);
    const rankedTags = rankRepoMapTags(tags, {
      chatPaths,
      mentionedPaths: new Set(request.mentionedPaths ?? []),
      mentionedIdentifiers: new Set(request.mentionedIdentifiers ?? []),
    });
    const map = await renderRepoMap({
      root: this.#root,
      rankedTags,
      otherPaths: request.otherPaths,
      chatPaths,
      maxTokens: this.#maxTokens,
      countTokens: this.#countTokens,
    });
    this.#lastProcessingMs = performance.now() - started;
    this.#maps.set(key, map);
    this.#lastMap = map;
    return map;
  }
}
