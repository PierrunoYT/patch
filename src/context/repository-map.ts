/**
 * Ported from aider/repomap.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with asynchronous Node.js cache files and explicit refresh contracts.
 * Licensed under the Apache License, Version 2.0.
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
  /**
   * The model's input limit. With it, a turn holding no files in the chat gets a
   * wider view of the repository, bounded so the map cannot crowd out the
   * conversation.
   */
  readonly maxContextWindow?: number;
  /** Budget multiplier applied when nothing is in the chat. */
  readonly mulNoFiles?: number;
}

/** Headroom kept for the rest of the prompt when the map is widened. */
const NO_FILES_PADDING = 4096;

/**
 * The map budget for a model, ported from `Model.get_repo_map_tokens`. A larger
 * context window earns a larger map, within fixed bounds so a huge window does
 * not spend most of the prompt on a map.
 */
export function repoMapTokens(maxInputTokens?: number): number {
  if (maxInputTokens === undefined) return 1024;
  return Math.max(1024, Math.min(4096, Math.floor(maxInputTokens / 8)));
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
  readonly #maxContextWindow: number | undefined;
  readonly #mulNoFiles: number;
  readonly #tagCache: RepoMapTagCache;
  readonly #maps = new Map<string, string>();
  readonly #skipped = new Set<string>();
  #lastMap: string | undefined;
  #lastProcessingMs = 0;

  /** Tracked paths the most recent construction could not read or parse. */
  get skippedPaths(): readonly string[] {
    return [...this.#skipped].sort();
  }

  /** The input limit this map was budgeted against, if one was given. */
  get maxContextWindow(): number | undefined {
    return this.#maxContextWindow;
  }

  /** Base token budget before the ordinary empty-chat multiplier. */
  get maxTokens(): number {
    return this.#maxTokens;
  }

  private constructor(
    options: RepositoryMapOptions,
    tagCache: RepoMapTagCache,
  ) {
    this.#root = options.root;
    this.#maxTokens = options.maxTokens;
    this.#countTokens = options.countTokens;
    this.#refresh = options.refresh ?? "auto";
    this.#autoCacheThresholdMs = options.autoCacheThresholdMs ?? 1000;
    this.#maxContextWindow = options.maxContextWindow;
    this.#mulNoFiles = options.mulNoFiles ?? 8;
    this.#tagCache = tagCache;
  }

  /**
   * The budget for one request. With nothing in the chat there is room for a
   * wider view of the repository, capped so the map still leaves the rest of the
   * prompt its space.
   */
  #budget(chatPaths: readonly string[]): number {
    if (chatPaths.length > 0 || this.#maxContextWindow === undefined) {
      return this.#maxTokens;
    }
    const widened = Math.min(
      this.#maxTokens * this.#mulNoFiles,
      this.#maxContextWindow - NO_FILES_PADDING,
    );
    return widened > this.#maxTokens ? widened : this.#maxTokens;
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
    for (const path of allPaths) {
      try {
        tags.push(...(await this.#tagCache.tags(path)));
        this.#skipped.delete(path);
      } catch {
        // The map is advisory context. A tracked path that is gone, unreadable,
        // or unparseable is dropped from the map rather than failing the turn
        // that asked for it.
        this.#skipped.add(path);
      }
    }
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
      maxTokens: this.#budget(request.chatPaths),
      countTokens: this.#countTokens,
      onUnreadable: (path) => this.#skipped.add(path),
    });
    this.#lastProcessingMs = performance.now() - started;
    this.#maps.set(key, map);
    this.#lastMap = map;
    return map;
  }
}
