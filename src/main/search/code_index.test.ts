import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore, type SecretCipher } from '../settings';
import { ShellRunner } from '../tools/shell';
import { Workspace } from '../tools/workspace';
import { chunkFile } from './chunker';
import {
  CodeIndex,
  embeddingSettingsKey,
  searchCodeTool,
  openRouterEmbedder,
  openRouterReranker,
  type Embedder,
  type EmbeddingInput,
  type Reranker,
} from './code_index';

// Deterministic stand-in for an embedding model: a bag of hashed words.
class FakeEmbedder implements Embedder {
  readonly model = 'fake';
  calls: string[][] = [];
  inputs: EmbeddingInput[] = [];

  async embed(texts: string[], input: EmbeddingInput): Promise<number[][]> {
    this.calls.push(texts);
    this.inputs.push(input);
    return texts.map((text) => {
      const vector = new Array(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 64;
        vector[hash] += 1;
      }
      return vector;
    });
  }

  get embeddedTexts(): number {
    return this.calls.flat().length;
  }
}

let root: string;
let indexDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-index-'));
  indexDir = mkdtempSync(join(tmpdir(), 'cc-index-store-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    'export function validateSession(token) {\n  return checkToken(token);\n}\n',
  );
  writeFileSync(join(root, 'src', 'cart.ts'), 'export function addToCart(item) {\n  cart.push(item);\n}\n');
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x00]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

describe('chunkFile', () => {
  it('splits long files into overlapping windows with the path included', () => {
    const content = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkFile('src/big.ts', content);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 60],
      [51, 110],
      [101, 130],
    ]);
    expect(chunks[0]!.text.startsWith('src/big.ts\nline 1')).toBe(true);
  });

  it('returns nothing for empty files', () => {
    expect(chunkFile('a', '')).toEqual([]);
    expect(chunkFile('a', '\n')).toEqual([]);
  });
});

describe('CodeIndex', () => {
  it('finds the most relevant file and skips binaries', async () => {
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const hits = await index.search('validate session token', 5, signal);
    expect(hits[0]).toMatchObject({ path: 'src/auth.ts', startLine: 1 });
    expect(hits[0]!.text).toContain('validateSession');
    expect(index.fileCount).toBe(2);
    // Chunks are embedded as documents, the search text as a query.
    expect(embedder.inputs.at(-1)).toBe('query');
    expect(new Set(embedder.inputs.slice(0, -1))).toEqual(new Set(['document']));
  });

  it('never sends credential files or secrets in ordinary files to the embedding service (#234)', async () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----';
    writeFileSync(join(root, 'deploy.pem'), `${key}\n`);
    writeFileSync(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_SECRETTOKEN1234567890\n');
    writeFileSync(join(root, '.env'), 'DB_PASSWORD=hunter2hunter2\n');
    writeFileSync(
      join(root, 'src', 'config.ts'),
      'export const client = connect({ apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" });\n',
    );
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    await index.search('connect client', 5, signal);

    const sent = embedder.calls.flat().join('\n');
    expect(sent).toContain('src/config.ts');
    for (const secret of ['PRIVATE KEY', 'secretbody', 'npm_SECRETTOKEN', 'hunter2', 'sk-ant-api03-abcdef']) {
      expect(sent).not.toContain(secret);
    }
    expect(index.fileCount).toBe(3);
  });

  it('walks the project once per search tool call and still reports indexing progress', async () => {
    const workspace = new Workspace(root);
    const walk = vi.spyOn(workspace, 'listFiles');
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(workspace, embedder, indexDir, () => 1000);
    const progress: string[] = [];
    const result = await searchCodeTool(index).run(
      { query: 'validate session token', limit: 2 },
      {
        workspace,
        signal,
        readFiles: new Map(),
        shell: new ShellRunner(() => workspace.root),
        browser: null,
        codeSearch: null,
        webSearch: null,
        onProgress: (message) => progress.push(message),
      },
    );
    expect(result.content).toContain('validateSession');
    expect(walk).toHaveBeenCalledTimes(1);
    expect(progress).toContain(`Indexing project: ${index.chunkCount}/${index.chunkCount} chunks\n`);
    expect(embedder.inputs.at(-1)).toBe('query');
  });

  it('reports status and re-embeds everything on rebuild', async () => {
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    expect(index.fileCount).toBe(0);
    await index.update();
    expect(index.chunkCount).toBeGreaterThan(0);
    expect(index.isUpdating).toBe(false);
    const afterFirst = embedder.embeddedTexts;

    await index.rebuild();
    expect(embedder.embeddedTexts).toBe(afterFirst * 2);
    expect(index.fileCount).toBe(2);
  });

  it('exposes progress while updating and clears it afterwards', async () => {
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 1000);
    const seen: Array<{
      reported: { embedded: number; total: number };
      exposed: { embedded: number; total: number } | null;
    }> = [];

    const running = index.update(undefined, (reported) => seen.push({ reported, exposed: index.updateProgress }));
    expect(index.isUpdating).toBe(true);
    expect(index.updateProgress).toBeNull();
    await running;

    // The getter shows what was just reported, and the last report covers all chunks.
    expect(seen.length).toBeGreaterThan(0);
    for (const { reported, exposed } of seen) expect(exposed).toEqual(reported);
    const last = seen.at(-1)!.reported;
    expect(last.embedded).toBe(last.total);
    expect(last.total).toBe(index.chunkCount);
    expect(index.updateProgress).toBeNull();
    expect(index.isUpdating).toBe(false);
  });

  it('only re-embeds changed files and drops deleted ones', async () => {
    const embedder = new FakeEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    await index.update();
    const afterFirst = embedder.embeddedTexts;

    await index.update();
    expect(embedder.embeddedTexts).toBe(afterFirst);

    writeFileSync(join(root, 'src', 'cart.ts'), 'export function removeFromCart(item) {}\n');
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, 'src', 'cart.ts'), future, future);
    rmSync(join(root, 'src', 'auth.ts'));
    await index.update();

    expect(embedder.embeddedTexts).toBe(afterFirst + 1);
    expect(index.fileCount).toBe(1);
  });

  it('persists the index and reloads it without re-embedding', async () => {
    const first = new FakeEmbedder();
    await new CodeIndex(new Workspace(root), first, indexDir, () => 1000).update();

    const second = new FakeEmbedder();
    const reloaded = new CodeIndex(new Workspace(root), second, indexDir, () => 1000);
    const hits = await reloaded.search('add item to cart', 1, signal);
    expect(second.embeddedTexts).toBe(1); // just the query
    expect(hits[0]!.path).toBe('src/cart.ts');
  });

  it('looks at no more files than the limit (skipped binaries count toward it)', async () => {
    // Breadth-first order: logo.png (binary, skipped), then src/auth.ts.
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 2);
    await index.update();
    expect(index.fileCount).toBe(1);
  });
});

describe('CodeIndex updates that fail, stop or are shared', () => {
  // 70 more one-chunk files, so a full update takes two embedding batches (64 + 8 chunks).
  const addFiles = () => {
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 70; i++) writeFileSync(join(root, 'many', `f${i}.ts`), `export const value${i} = ${i};\n`);
  };

  // Each embed call waits until the test releases it, and fails with the stop reason when its signal aborts.
  class GatedEmbedder extends FakeEmbedder {
    waiting: Array<{ release: () => void; signal?: AbortSignal }> = [];
    failCall: number | null = null;
    private count = 0;

    override async embed(texts: string[], input: EmbeddingInput, signal?: AbortSignal): Promise<number[][]> {
      const call = ++this.count;
      await new Promise<void>((resolve, reject) => {
        const entry = { release: resolve, signal };
        signal?.addEventListener(
          'abort',
          () => {
            this.waiting = this.waiting.filter((item) => item !== entry);
            reject(signal.reason);
          },
          { once: true },
        );
        this.waiting.push(entry);
      });
      if (call === this.failCall) throw new Error('OpenRouter embeddings request failed (429)');
      return super.embed(texts, input);
    }

    // Waits for the next embed call and lets it finish.
    async releaseNext(): Promise<AbortSignal | undefined> {
      await vi.waitFor(() => expect(this.waiting.length).toBeGreaterThan(0));
      const next = this.waiting.shift()!;
      next.release();
      return next.signal;
    }
  }

  it('keeps the files of finished batches when a later batch fails, and a retry embeds only the rest', async () => {
    addFiles();
    const embedder = new GatedEmbedder();
    embedder.failCall = 2;
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const running = index.update();
    await embedder.releaseNext();
    await embedder.releaseNext();
    await expect(running).rejects.toThrow('429');
    expect(index.fileCount).toBe(64);

    // Saved on disk too: a new instance starts from the 64 files and embeds only the other 8.
    const retry = new FakeEmbedder();
    const reloaded = new CodeIndex(new Workspace(root), retry, indexDir, () => 1000);
    expect(reloaded.fileCount).toBe(64);
    await reloaded.update();
    expect(retry.embeddedTexts).toBe(8);
    expect(reloaded.fileCount).toBe(72);
  });

  it('keeps a file split across batches out of the index until all its chunks are embedded', async () => {
    addFiles();
    // Listed after 60 small files and the two in src, so its three chunks are 62-64: the first two land in the first
    // batch and the last one in the second.
    for (let i = 60; i < 70; i++) rmSync(join(root, 'many', `f${i}.ts`));
    mkdirSync(join(root, 'zz'));
    writeFileSync(join(root, 'zz', 'big.ts'), Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n'));
    const embedder = new GatedEmbedder();
    embedder.failCall = 2;
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const running = index.update();
    await embedder.releaseNext();
    await embedder.releaseNext();
    await expect(running).rejects.toThrow('429');
    const stored = JSON.parse(readFileSync(readdirSync(indexDir).map((name) => join(indexDir, name))[0]!, 'utf8'));
    expect(Object.keys(stored.files)).toHaveLength(62);
    expect(Object.keys(stored.files)).not.toContain('zz/big.ts');
    expect(index.fileCount).toBe(62);
    expect(index.chunkCount).toBe(62);
  });

  it('keeps running for a second caller when the first one stops', async () => {
    const embedder = new GatedEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const first = new AbortController();
    const second = new AbortController();
    const firstRun = index.update(first.signal);
    const secondRun = index.update(second.signal);
    await vi.waitFor(() => expect(embedder.waiting).toHaveLength(1));

    first.abort(new Error('first stopped'));
    await expect(firstRun).rejects.toThrow('first stopped');
    expect(index.isUpdating).toBe(true);

    const runSignal = await embedder.releaseNext();
    await secondRun;
    expect(runSignal?.aborted).toBe(false);
    expect(index.fileCount).toBe(2);
  });

  it('stops the run when every caller has stopped, and keeps no partial work', async () => {
    const embedder = new GatedEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const first = new AbortController();
    const second = new AbortController();
    const firstRun = index.update(first.signal);
    const secondRun = index.update(second.signal);
    await vi.waitFor(() => expect(embedder.waiting).toHaveLength(1));
    const runSignal = embedder.waiting[0]!.signal!;

    second.abort();
    await expect(secondRun).rejects.toThrow();
    expect(runSignal.aborted).toBe(false);
    first.abort();
    await expect(firstRun).rejects.toThrow();
    expect(runSignal.aborted).toBe(true);
    await vi.waitFor(() => expect(index.isUpdating).toBe(false));
    expect(index.fileCount).toBe(0);

    // The next caller starts a fresh run.
    const again = index.update();
    await embedder.releaseNext();
    await again;
    expect(index.fileCount).toBe(2);
  });

  it('sends progress to every caller, and a caller joining mid-run gets the latest progress at once', async () => {
    addFiles();
    const embedder = new GatedEmbedder();
    const index = new CodeIndex(new Workspace(root), embedder, indexDir, () => 1000);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const late: unknown[] = [];
    const runs = [index.update(undefined, (p) => first.push(p)), index.update(signal, (p) => second.push(p))];
    await embedder.releaseNext();
    await vi.waitFor(() => expect(index.updateProgress).toEqual({ embedded: 64, total: 72 }));

    runs.push(index.update(undefined, (p) => late.push(p)));
    expect(late).toEqual([{ embedded: 64, total: 72 }]);
    await embedder.releaseNext();
    await Promise.all(runs);

    const expected = [
      { embedded: 64, total: 72 },
      { embedded: 72, total: 72 },
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(late).toEqual(expected);
  });
});

describe('embeddingSettingsKey', () => {
  const cipher: SecretCipher = { isAvailable: () => false, encrypt: (plain) => plain, decrypt: (encoded) => encoded };

  it('changes with the OpenRouter key and not with other settings', () => {
    const store = new SettingsStore(join(indexDir, 'settings.json'), cipher);
    const initial = embeddingSettingsKey(store);
    store.update({ theme: 'light', maxIndexedFiles: 10 });
    store.setSecret('anthropicApiKey', 'sk-ant-1');
    expect(embeddingSettingsKey(store)).toBe(initial);

    store.setSecret('openrouterApiKey', 'sk-or-1');
    const withKey = embeddingSettingsKey(store);
    expect(withKey).not.toBe(initial);
    expect(withKey).not.toContain('sk-or-1');
    store.setSecret('openrouterApiKey', 'sk-or-2');
    expect(embeddingSettingsKey(store)).not.toBe(withKey);
  });
});

describe('CodeIndex with a reranker', () => {
  // Puts the documents that mention `favourite` first, in reverse order of how they arrived.
  class FakeReranker implements Reranker {
    readonly model = 'fake-rerank';
    seen: { query: string; documents: string[]; topN: number } | null = null;
    fail: Error | null = null;

    async rerank(query: string, documents: string[], topN: number) {
      this.seen = { query, documents, topN };
      if (this.fail) throw this.fail;
      return documents
        .map((text, index) => ({ index, score: text.includes(this.favourite) ? 0.9 : 0.1 }))
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .slice(0, topN);
    }

    constructor(private readonly favourite: string) {}
  }

  it('reranks the best embedding matches and keeps the requested number', async () => {
    const reranker = new FakeReranker('addToCart');
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 1000, reranker);

    const result = await index.searchDetailed('validate session token', 1, signal);

    // The embedding order puts auth.ts first; the reranker prefers cart.ts.
    expect(result).toMatchObject({ rerankFailure: null, hits: [{ path: 'src/cart.ts', score: 0.9 }] });
    expect(result.hits).toHaveLength(1);
    expect(reranker.seen).toMatchObject({ query: 'validate session token', topN: 1 });
    // Every candidate went to the reranker with its path, not only the requested one.
    expect(reranker.seen!.documents).toHaveLength(2);
    expect(reranker.seen!.documents.some((text) => text.startsWith('src/auth.ts\n'))).toBe(true);
  });

  it('masks secrets in the documents it sends to the reranker (#234)', async () => {
    writeFileSync(
      join(root, 'src', 'cart.ts'),
      'export function addToCart(item) {\n  password = "hunter2hunter2";\n}\n',
    );
    const reranker = new FakeReranker('addToCart');
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 1000, reranker);
    await index.searchDetailed('add to cart', 2, signal);
    const documents = reranker.seen!.documents.join('\n');
    expect(documents).toContain('addToCart');
    expect(documents).not.toContain('hunter2hunter2');
  });

  it('falls back to the embedding order when reranking fails, and says so', async () => {
    const reranker = new FakeReranker('addToCart');
    reranker.fail = new Error('OpenRouter rerank request failed (503)');
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 1000, reranker);

    const result = await index.searchDetailed('validate session token', 1, signal);

    expect(result.rerankFailure).toBe('OpenRouter rerank request failed (503)');
    expect(result.hits.map((hit) => hit.path)).toEqual(['src/auth.ts']);
  });

  it('passes a stop on instead of falling back', async () => {
    const controller = new AbortController();
    const reranker = new FakeReranker('addToCart');
    const index = new CodeIndex(new Workspace(root), new FakeEmbedder(), indexDir, () => 1000, reranker);
    await index.update();
    reranker.fail = new DOMException('aborted', 'AbortError');
    const pending = index.searchDetailed('validate session token', 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('openRouterReranker', () => {
  it('posts the query and documents to OpenRouter and returns the results best first', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          model: 'voyageai/rerank-3',
          results: [
            { index: 0, relevance_score: 0.2 },
            { index: 2, relevance_score: 0.95 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const reranker = openRouterReranker('sk-or-test', 'https://router.example/api/v1', fetchImpl);

    expect(reranker.model).toBe('voyageai/rerank-3');
    expect(await reranker.rerank('find carts', ['a', 'b', 'c'], 2, signal)).toEqual([
      { index: 2, score: 0.95 },
      { index: 0, score: 0.2 },
    ]);
    expect(requests[0]!.url).toBe('https://router.example/api/v1/rerank');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      model: 'voyageai/rerank-3',
      query: 'find carts',
      documents: ['a', 'b', 'c'],
      top_n: 2,
    });
  });

  it("reports OpenRouter's error without the key", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
        status: 402,
      })) as unknown as typeof fetch;
    const failure = openRouterReranker('sk-or-secret', undefined, fetchImpl).rerank('q', ['a'], 1, signal);
    await expect(failure).rejects.toThrow(
      'OpenRouter rerank request failed (402): Insufficient credits. Add credits to the OpenRouter account.',
    );
    await expect(failure).rejects.not.toThrow(/sk-or-secret/);
  });
});

describe('openRouterEmbedder', () => {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts Voyage code embeddings to OpenRouter and returns them in input order', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return respond(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    }) as unknown as typeof fetch;
    const embedder = openRouterEmbedder('sk-or-test', 'https://router.example/api/v1/', fetchImpl);

    expect(embedder.model).toBe('voyageai/voyage-code-4');
    expect(await embedder.embed(['first', 'second'], 'document', signal)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requests[0]!.url).toBe('https://router.example/api/v1/embeddings');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      model: 'voyageai/voyage-code-4',
      input: ['first', 'second'],
      input_type: 'document',
      encoding_format: 'float',
    });
  });

  it("reports OpenRouter's error without the key", async () => {
    const fetchImpl = (async () =>
      respond(401, { error: { message: 'No auth credentials found' } })) as unknown as typeof fetch;
    const failure = openRouterEmbedder('sk-or-secret', undefined, fetchImpl).embed(['x'], 'query', signal);
    await expect(failure).rejects.toThrow(
      'OpenRouter embeddings request failed (401): No auth credentials found. Check the OpenRouter API key in Settings.',
    );
    await expect(failure).rejects.not.toThrow(/sk-or-secret/);
  });

  it('fails when a successful response has no embeddings', async () => {
    const fetchImpl = (async () =>
      respond(200, { error: { message: 'Model is warming up' } })) as unknown as typeof fetch;
    await expect(openRouterEmbedder('k', undefined, fetchImpl).embed(['x'], 'query', signal)).rejects.toThrow(
      'OpenRouter embeddings request failed (200): Model is warming up',
    );
  });
});
