import { createHash } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SafePathResolver } from "../io/safe-path.js";
import type { RepoMapTag } from "./tag-extractor.js";

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly hash: string;
  readonly tags: readonly RepoMapTag[];
}

interface CacheFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, CacheEntry>>;
}

export interface TagSource {
  extract(path: string): Promise<readonly RepoMapTag[]>;
}

function validTag(value: unknown, path: string): value is RepoMapTag {
  if (typeof value !== "object" || value === null) return false;
  const tag = value as Partial<RepoMapTag>;
  return (
    tag.path === path &&
    typeof tag.line === "number" &&
    Number.isInteger(tag.line) &&
    tag.line >= 0 &&
    typeof tag.name === "string" &&
    (tag.kind === "definition" || tag.kind === "reference")
  );
}

function parseCache(value: unknown): Map<string, CacheEntry> {
  if (typeof value !== "object" || value === null) return new Map();
  const file = value as Partial<CacheFile>;
  if (
    file.version !== 1 ||
    typeof file.entries !== "object" ||
    file.entries === null
  ) {
    return new Map();
  }
  const entries = new Map<string, CacheEntry>();
  for (const [path, unknownEntry] of Object.entries(file.entries)) {
    if (typeof unknownEntry !== "object" || unknownEntry === null) continue;
    const entry = unknownEntry as Partial<CacheEntry>;
    if (
      typeof entry.mtimeMs === "number" &&
      typeof entry.size === "number" &&
      typeof entry.hash === "string" &&
      Array.isArray(entry.tags) &&
      entry.tags.every((tag) => validTag(tag, path))
    ) {
      entries.set(path, entry as CacheEntry);
    }
  }
  return entries;
}

export class RepoMapTagCache {
  readonly #resolver: SafePathResolver;
  readonly #source: TagSource;
  readonly #cachePath: string;
  readonly #entries: Map<string, CacheEntry>;

  private constructor(
    resolver: SafePathResolver,
    source: TagSource,
    cachePath: string,
    entries: Map<string, CacheEntry>,
  ) {
    this.#resolver = resolver;
    this.#source = source;
    this.#cachePath = cachePath;
    this.#entries = entries;
  }

  static async create(
    root: string,
    source: TagSource,
    cacheFile = ".patch.tags.cache.v1.json",
  ): Promise<RepoMapTagCache> {
    const resolver = await SafePathResolver.create(root);
    const cachePath = await resolver.resolve(cacheFile);
    let entries = new Map<string, CacheEntry>();
    try {
      entries = parseCache(JSON.parse(await readFile(cachePath, "utf8")));
    } catch {
      // Missing and malformed cache files both recover as an empty cache.
    }
    return new RepoMapTagCache(resolver, source, cachePath, entries);
  }

  async tags(path: string): Promise<readonly RepoMapTag[]> {
    const absolutePath = await this.#resolver.resolve(path);
    const [metadata, content] = await Promise.all([
      stat(absolutePath),
      readFile(absolutePath),
    ]);
    if (!metadata.isFile()) return [];
    const hash = createHash("sha256").update(content).digest("hex");
    const cached = this.#entries.get(path);
    if (
      cached !== undefined &&
      cached.mtimeMs === metadata.mtimeMs &&
      cached.size === metadata.size &&
      cached.hash === hash
    ) {
      return cached.tags;
    }

    const tags = await this.#source.extract(path);
    this.#entries.set(path, {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      hash,
      tags,
    });
    await this.#save();
    return tags;
  }

  async #save(): Promise<void> {
    const temporaryPath = join(
      dirname(this.#cachePath),
      `.${createHash("sha256").update(this.#cachePath).digest("hex").slice(0, 12)}.tmp`,
    );
    const data: CacheFile = {
      version: 1,
      entries: Object.fromEntries([...this.#entries.entries()].sort()),
    };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#cachePath);
    } catch {
      // A read-only repository still gets a correct in-memory map.
    }
  }
}
