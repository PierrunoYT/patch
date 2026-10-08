import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EMBEDDING_BASE_URL, EMBEDDING_MODEL, RERANK_MODEL } from '@shared/models';
import { appLog } from '../app_log';
import { readJson, writeJson } from '../storage/json_file';
import { fileSize, isBinaryFile } from '../tools/text_files';
import { defineTool, type AgentTool, type CodeSearch } from '../tools/types';
import type { Workspace } from '../tools/workspace';
import { chunkFile } from './chunker';

// Bump when chunking or storage changes so existing indexes are rebuilt.
const INDEX_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const EMBED_BATCH = 64;
// The whole index file is rewritten on each save, so a run saves every few batches (about 320 chunks) and once at the
// end, not after every batch.
const SAVE_EVERY_BATCHES = 5;
// Embedding matches handed to the reranker, which picks the final results from them.
const RERANK_CANDIDATES = 30;

// Retrieval models embed a search query and the text it should find differently.
export type EmbeddingInput = 'query' | 'document';

export interface Embedder {
  readonly model: string;
  embed(texts: string[], input: EmbeddingInput, signal?: AbortSignal): Promise<number[][]>;
}

// Scores documents against a query. Returns the positions of the best `topN` documents, most relevant first.
export interface Reranker {
  readonly model: string;
  rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<RerankResult[]>;
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  // Why the results are in plain embedding order although a reranker is set; null when they were reranked or no
  // reranker is set.
  rerankFailure: string | null;
}

interface IndexedChunk {
  startLine: number;
  endLine: number;
  // Float32 vector, base64 encoded to keep the index file small.
  vector: string;
}

interface IndexedFile {
  mtimeMs: number;
  size: number;
  chunks: IndexedChunk[];
}

interface PendingFile {
  path: string;
  mtimeMs: number;
  size: number;
  content: string;
}

interface StoredIndex {
  version: number;
  model: string;
  root: string;
  files: Record<string, IndexedFile>;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export interface UpdateProgress {
  embedded: number;
  total: number;
}

interface UpdateCaller {
  onProgress?: (progress: UpdateProgress) => void;
}

// One update shared by every caller waiting for it. `callers` holds the callers that have not stopped.
interface UpdateRun {
  controller: AbortController;
  callers: Set<UpdateCaller>;
  progress: UpdateProgress | null;
  promise: Promise<void>;
}

// Semantic index of one project. Stored in userData/indexes/<hash of project path>.json.
export class CodeIndex implements CodeSearch {
  private data: StoredIndex;
  private vectors = new Map<string, Float32Array[]>();
  private run: UpdateRun | null = null;

  constructor(
    private readonly workspace: Workspace,
    private readonly embedder: Embedder,
    indexDir: string,
    private readonly maxFiles: () => number,
    private readonly reranker: Reranker | null = null,
  ) {
    this.file = join(indexDir, `${createHash('sha1').update(workspace.root).digest('hex')}.json`);
    const stored = readJson<StoredIndex | null>(this.file, null);
    this.data =
      stored?.version === INDEX_VERSION && stored.model === embedder.model && stored.root === workspace.root
        ? stored
        : { version: INDEX_VERSION, model: embedder.model, root: workspace.root, files: {} };
  }

  private readonly file: string;

  // Re-embeds new and changed files and drops deleted ones. Concurrent callers share one update: the run stops only
  // when every caller waiting for it has stopped, and each caller's promise rejects as soon as its own signal aborts.
  update(signal?: AbortSignal, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    // A run that every caller stopped may still be winding down; a new caller starts a fresh run after it.
    if (!this.run || this.run.controller.signal.aborted) this.run = this.startRun(this.run?.promise);
    const run = this.run;
    const caller: UpdateCaller = { onProgress };
    run.callers.add(caller);
    // A caller joining mid-run sees where the run is instead of waiting for the next batch.
    if (run.progress) onProgress?.(run.progress);
    if (!signal) return run.promise;

    return new Promise<void>((resolve, reject) => {
      const stop = () => {
        run.callers.delete(caller);
        if (run.callers.size === 0) run.controller.abort(signal.reason);
        reject(signal.reason);
      };
      signal.addEventListener('abort', stop, { once: true });
      run.promise.then(
        () => {
          signal.removeEventListener('abort', stop);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', stop);
          reject(error);
        },
      );
    });
  }

  private startRun(previous: Promise<void> | undefined): UpdateRun {
    const run = {
      controller: new AbortController(),
      callers: new Set<UpdateCaller>(),
      progress: null as UpdateProgress | null,
    };
    const promise = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        this.runUpdate(run.controller.signal, (progress) => {
          run.progress = progress;
          for (const caller of run.callers) caller.onProgress?.(progress);
        }),
      )
      .finally(() => {
        if (this.run === run) this.run = null;
      });
    return Object.assign(run, { promise });
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
    return (await this.searchDetailed(query, limit, signal)).hits;
  }

  // Embedding search, then, with a reranker, a second pass over the best candidates. A failed rerank falls back to
  // the embedding order instead of failing the search; a stop is passed on.
  async searchDetailed(
    query: string,
    limit: number,
    signal: AbortSignal,
    onProgress?: (progress: UpdateProgress) => void,
  ): Promise<SearchResult> {
    await this.update(signal, onProgress);
    const [queryVector] = await this.embedder.embed([query], 'query', signal);
    if (!queryVector) throw new Error('The embedding service returned no vector for the query.');
    const q = normalize(Float32Array.from(queryVector));

    const scored: Array<{ path: string; chunk: IndexedChunk; score: number }> = [];
    for (const [path, file] of Object.entries(this.data.files)) {
      const vectors = this.vectorsFor(path, file);
      file.chunks.forEach((chunk, i) => {
        const vector = vectors[i];
        if (vector) scored.push({ path, chunk, score: dot(q, vector) });
      });
    }
    scored.sort((a, b) => b.score - a.score);

    // At most two hits per file so one large file cannot crowd out the rest.
    const wanted = this.reranker ? Math.max(limit, RERANK_CANDIDATES) : limit;
    const perFile = new Map<string, number>();
    const candidates: SearchHit[] = [];
    for (const candidate of scored) {
      if (candidates.length >= wanted) break;
      const count = perFile.get(candidate.path) ?? 0;
      if (count >= 2) continue;
      perFile.set(candidate.path, count + 1);
      candidates.push({
        path: candidate.path,
        startLine: candidate.chunk.startLine,
        endLine: candidate.chunk.endLine,
        score: candidate.score,
        text: await this.readLines(candidate.path, candidate.chunk.startLine, candidate.chunk.endLine),
      });
    }
    if (!this.reranker || candidates.length === 0) return { hits: candidates.slice(0, limit), rerankFailure: null };

    try {
      const ranked = await this.reranker.rerank(
        query,
        candidates.map((hit) => `${hit.path}\n${hit.text}`),
        Math.min(limit, candidates.length),
        signal,
      );
      const hits = ranked.flatMap(({ index, score }) => {
        const hit = candidates[index];
        return hit ? [{ ...hit, score }] : [];
      });
      if (hits.length === 0) throw new Error('The reranker returned no results.');
      return { hits, rerankFailure: null };
    } catch (error) {
      if (signal.aborted) throw error;
      appLog.warn('search', 'Reranking failed; search results are in embedding order.');
      return {
        hits: candidates.slice(0, limit),
        rerankFailure: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Throws away everything indexed so far and embeds the whole project again.
  async rebuild(signal?: AbortSignal, onProgress?: (progress: UpdateProgress) => void): Promise<void> {
    await this.run?.promise.catch(() => {});
    this.data.files = {};
    this.vectors.clear();
    writeJson(this.file, this.data);
    await this.update(signal, onProgress);
  }

  get fileCount(): number {
    return Object.keys(this.data.files).length;
  }

  get chunkCount(): number {
    return Object.values(this.data.files).reduce((sum, file) => sum + file.chunks.length, 0);
  }

  get isUpdating(): boolean {
    return this.run !== null;
  }

  // Chunks embedded so far in the running update; null while idle or still scanning files.
  get updateProgress(): UpdateProgress | null {
    return this.run?.progress ?? null;
  }

  private async runUpdate(signal: AbortSignal, onProgress: (progress: UpdateProgress) => void): Promise<void> {
    let dirty = false;
    try {
      const files = await this.workspace.listFiles(this.workspace.root, this.maxFiles());
      const current = new Set<string>();
      const pending: PendingFile[] = [];

      for (const absolute of files) {
        const path = this.workspace.relative(absolute);
        current.add(path);
        const info = await stat(absolute);
        const existing = this.data.files[path];
        if (existing && existing.mtimeMs === info.mtimeMs && existing.size === info.size) continue;
        if (info.size > MAX_FILE_BYTES || info.size === 0 || (await isBinaryFile(absolute))) {
          if (existing) dirty = this.forget(path) || dirty;
          continue;
        }
        pending.push({ path, mtimeMs: info.mtimeMs, size: info.size, content: await readFile(absolute, 'utf8') });
      }

      for (const path of Object.keys(this.data.files)) {
        if (!current.has(path)) dirty = this.forget(path) || dirty;
      }

      // A file is committed only once all its chunks are embedded, so an interrupted run leaves every file either
      // fully old or fully new, and its mtime and size always match its chunks.
      const results = new Map<string, IndexedChunk[]>();
      const remaining = new Map<string, number>();
      const work: Array<{ file: PendingFile; chunk: ReturnType<typeof chunkFile>[number] }> = [];
      for (const file of pending) {
        const chunks = chunkFile(file.path, file.content);
        if (chunks.length === 0) {
          this.commit(file, []);
          dirty = true;
          continue;
        }
        results.set(file.path, []);
        remaining.set(file.path, chunks.length);
        for (const chunk of chunks) work.push({ file, chunk });
      }

      let batches = 0;
      for (let i = 0; i < work.length; i += EMBED_BATCH) {
        signal.throwIfAborted();
        const batch = work.slice(i, i + EMBED_BATCH);
        const vectors = await this.embedder.embed(
          batch.map((item) => item.chunk.text),
          'document',
          signal,
        );
        // Check the whole batch first so a short response commits nothing from it.
        batch.forEach((item, j) => {
          // A short response would otherwise be saved as if the file were fully indexed, and it would stay
          // unsearchable until the file changed. Failing leaves it to be retried.
          if (!vectors[j]) throw new Error(`The embedding service returned no vector for ${item.file.path}.`);
        });
        batch.forEach((item, j) => {
          results.get(item.file.path)!.push({
            startLine: item.chunk.startLine,
            endLine: item.chunk.endLine,
            vector: encode(normalize(Float32Array.from(vectors[j]!))),
          });
          const left = remaining.get(item.file.path)! - 1;
          remaining.set(item.file.path, left);
          if (left === 0) {
            this.commit(item.file, results.get(item.file.path)!);
            results.delete(item.file.path);
            dirty = true;
          }
        });
        onProgress({ embedded: Math.min(i + EMBED_BATCH, work.length), total: work.length });
        if (++batches % SAVE_EVERY_BATCHES === 0 && dirty) {
          writeJson(this.file, this.data);
          dirty = false;
        }
      }
    } finally {
      // Also on failure or stop, so the embeddings already paid for are kept.
      if (dirty) writeJson(this.file, this.data);
    }
  }

  // Replaces the file's entry in one step, so a search running meanwhile sees either the old or the new chunks.
  private commit(file: PendingFile, chunks: IndexedChunk[]): void {
    this.data.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, chunks };
    this.vectors.delete(file.path);
  }

  private forget(path: string): boolean {
    if (!(path in this.data.files)) return false;
    delete this.data.files[path];
    this.vectors.delete(path);
    return true;
  }

  private vectorsFor(path: string, file: IndexedFile): Float32Array[] {
    let vectors = this.vectors.get(path);
    if (!vectors) {
      vectors = file.chunks.map((chunk) => decode(chunk.vector));
      this.vectors.set(path, vectors);
    }
    return vectors;
  }

  private async readLines(path: string, start: number, end: number): Promise<string> {
    try {
      const absolute = this.workspace.resolve(path);
      if ((await fileSize(absolute)) > MAX_FILE_BYTES) return '';
      return (await readFile(absolute, 'utf8'))
        .split(/\r?\n/)
        .slice(start - 1, end)
        .join('\n');
    } catch {
      return '';
    }
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function decode(base64: string): Float32Array {
  const buffer = Buffer.from(base64, 'base64');
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

// What the cached indexes depend on among the settings: the OpenRouter key builds their embedder and reranker. The
// file limit is read on every update, so changing it needs no new index. Hashed so the key is not kept around twice.
export function embeddingSettingsKey(settings: { getSecret(name: 'openrouterApiKey'): string }): string {
  return createHash('sha256').update(settings.getSecret('openrouterApiKey')).digest('hex');
}

export function searchCodeTool(index: CodeIndex): AgentTool {
  return defineTool({
    name: 'search_code',
    description:
      'Semantic search over the project code. Describe what you are looking for in natural language (e.g. "where user sessions are validated"). Returns the most relevant code snippets with file paths and line numbers. Use grep for exact names.',
    schema: z.object({
      query: z.string().min(3),
      limit: z.number().int().min(1).max(20).optional().describe('Number of snippets (default 8).'),
    }),
    requiresApproval: false,
    parallelSafe: true,
    async run({ query, limit = 8 }, context) {
      const { hits, rerankFailure } = await index.searchDetailed(query, limit, context.signal, ({ embedded, total }) =>
        context.onProgress(`Indexing project: ${embedded}/${total} chunks\n`),
      );
      const content = hits.map((hit) => `${hit.path}:${hit.startLine}-${hit.endLine}\n${hit.text}`).join('\n\n---\n\n');
      const note = rerankFailure ? `Reranking failed (${rerankFailure}); results are in embedding order.\n\n` : '';
      return {
        content: note + (content || 'No matches.'),
        summary: `Searched code for "${query}" (${hits.length} results)`,
      };
    },
  });
}

// OpenRouter's own messages ("User not found" for a deleted key) do not say what to do, so add the next step for a
// rejected key and for an account out of credits.
function openRouterError(request: 'embeddings' | 'rerank', status: number, message: string | undefined): Error {
  const detail = message ? `: ${message}` : '';
  const hint =
    status === 401 || status === 403
      ? ' Check the OpenRouter API key in Settings.'
      : status === 402
        ? ' Add credits to the OpenRouter account.'
        : '';
  return new Error(`OpenRouter ${request} request failed (${status})${detail}.${hint}`);
}

// Embeds through OpenRouter's OpenAI-style embeddings endpoint. input_type lets Voyage prefix queries and documents
// for retrieval. Errors name the status and OpenRouter's message, never the key.
export function openRouterEmbedder(
  apiKey: string,
  baseUrl = EMBEDDING_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts, input, signal) {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, input_type: input, encoding_format: 'float' }),
        signal,
      });
      const body = (await response.json().catch(() => null)) as {
        data?: Array<{ embedding: number[]; index: number }>;
        error?: { message?: string };
      } | null;
      if (!response.ok || !Array.isArray(body?.data)) {
        throw openRouterError('embeddings', response.status, body?.error?.message);
      }
      return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    },
  };
}

// Reranks through OpenRouter's rerank endpoint with Voyage's reranker. Errors name the status and OpenRouter's
// message, never the key.
export function openRouterReranker(
  apiKey: string,
  baseUrl = EMBEDDING_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Reranker {
  return {
    model: RERANK_MODEL,
    async rerank(query, documents, topN, signal) {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/rerank`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: RERANK_MODEL, query, documents, top_n: topN }),
        signal,
      });
      const body = (await response.json().catch(() => null)) as {
        results?: Array<{ index: number; relevance_score: number }>;
        error?: { message?: string };
      } | null;
      if (!response.ok || !Array.isArray(body?.results)) {
        throw openRouterError('rerank', response.status, body?.error?.message);
      }
      return [...body.results]
        .filter((result) => Number.isInteger(result.index) && typeof result.relevance_score === 'number')
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .map((result) => ({ index: result.index, score: result.relevance_score }));
    },
  };
}
