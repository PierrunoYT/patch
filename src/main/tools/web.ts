import { Readability } from '@mozilla/readability';
import type { LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { destinationFor, resolveDestination, type Destination } from './net_address';
import { defineTool, ToolError } from './types';

// How long to wait for the response headers. Reading the body has its own limit, so a slow page still returns what
// arrived in time instead of failing.
const FETCH_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 10;
// A response is read only up to this many bytes, so a huge or endless body cannot fill the main process's memory.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Pages fetched in this session, so paging through one (offset) or asking again does not download it twice.
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_PAGES = 20;
const MAX_HIGHLIGHTS = 15;

interface CachedPage {
  text: string;
  truncated: boolean;
  timedOut: boolean;
  at: number;
}

const pageCache = new Map<string, CachedPage>();

export function clearFetchCache(): void {
  pageCache.clear();
}

function cachedPage(url: string): CachedPage | null {
  const page = pageCache.get(url);
  if (!page) return null;
  if (Date.now() - page.at > CACHE_TTL_MS) {
    pageCache.delete(url);
    return null;
  }
  return page;
}

function rememberPage(url: string, page: CachedPage): void {
  pageCache.delete(url);
  pageCache.set(url, page);
  while (pageCache.size > CACHE_MAX_PAGES) pageCache.delete(pageCache.keys().next().value as string);
}

// The charset named in a Content-Type header, or null when there is none.
export function charsetFrom(contentType: string | null): string | null {
  const match = /;\s*charset\s*=\s*("[^"]*"|[^;\s]*)/i.exec(contentType ?? '');
  const label = match?.[1]?.replace(/^"|"$/g, '').trim();
  return label ? label : null;
}

// A decoder for the response's charset, falling back to UTF-8 when it is missing or not a known label.
function textDecoderFor(charset: string | null): TextDecoder {
  if (charset) {
    try {
      return new TextDecoder(charset, { fatal: false });
    } catch {
      // An unknown label: read the page as UTF-8.
    }
  }
  return new TextDecoder('utf-8', { fatal: false });
}

export interface BodyText {
  text: string;
  // The body was cut: it was longer than `maxBytes`, or it was still arriving when the time ran out.
  truncated: boolean;
  timedOut: boolean;
}

// Reads at most `maxBytes` of the body, for at most `timeoutMs`, and stops the download there. A body still arriving
// when the time runs out returns what was read so far; an abort by the user still throws.
export async function readBodyCapped(
  response: Response,
  maxBytes = MAX_BODY_BYTES,
  timeoutMs = BODY_TIMEOUT_MS,
): Promise<BodyText> {
  if (!response.body) return { text: '', truncated: false, timedOut: false };
  const reader = response.body.getReader();
  const decoder = textDecoderFor(charsetFrom(response.headers.get('content-type')));
  let text = '';
  let received = 0;
  let truncated = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout') {
        truncated = timedOut = true;
        reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = next;
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        text += decoder.decode(value.subarray(0, value.byteLength - (received - maxBytes)), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  return { text: text + decoder.decode(), truncated, timedOut };
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'how', 'are', 'was', 'can']);

// The lines of a long page that share the most words with what the model is looking for, in page order.
export function relevantLines(text: string, objective: string): string[] {
  const words = [
    ...new Set((objective.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word))),
  ];
  if (words.length === 0) return [];
  const scored = text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      const lower = line.toLowerCase();
      return {
        line: line.length > 300 ? `${line.slice(0, 300)}…` : line,
        index,
        score: words.filter((w) => lower.includes(w)).length,
      };
    })
    .filter(({ score }) => score > 0);
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_HIGHLIGHTS)
    .sort((a, b) => a.index - b.index)
    .map(({ line }) => line);
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web (Google). Use for current information such as new library versions, error messages or documentation. Returns titles, links and snippets; use fetch_url to read a page.',
  schema: z.object({ query: z.string().min(1) }),
  requiresApproval: false,
  async run({ query }, context) {
    if (!context.webSearch) {
      throw new ToolError(
        'Web search is not configured. The user can add a Google API key and search engine id in Settings.',
      );
    }
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', context.webSearch.googleApiKey);
    url.searchParams.set('cx', context.webSearch.googleSearchEngineId);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '8');

    const response = await fetch(url, { signal: withTimeout(context.signal) });
    if (!response.ok) throw new ToolError(`Search failed: HTTP ${response.status}`);
    const data = (await response.json()) as { items?: Array<{ title: string; link: string; snippet?: string }> };
    const items = data.items ?? [];
    return {
      content:
        items.map((item, i) => `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet ?? ''}`).join('\n') ||
        'No results.',
      summary: `Searched the web for "${query}"`,
    };
  },
});

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  description:
    'Fetch a web page and return its main text content (for documentation, articles, issues). Long pages come back in parts of about 20,000 characters: follow the offset in the note to read on. Pass objective (what you are looking for) to get the lines of a long page that matter most first. Pages are kept for 15 minutes, so reading the next part does not download it again.',
  schema: z.object({
    url: z.string().url(),
    objective: z
      .string()
      .optional()
      .describe('What you are looking for; the most relevant lines of a long page are listed first.'),
    offset: z.number().int().min(0).optional().describe('Character offset to continue from (default 0).'),
    force_refetch: z.boolean().optional().describe('Download the page again even if it was fetched recently.'),
  }),
  requiresApproval: true,
  // A local or private address (this machine, the LAN, cloud metadata) asks even in Auto mode, unless the user listed
  // the host in allowedNetworkHosts.
  async mustAsk(input, context) {
    return (await localDestination(input, input.url, context)) !== null;
  },
  async preview(input, context) {
    const local = await localDestination(input, input.url, context).catch(() => null);
    return {
      title: `Fetch ${input.url}`,
      note: local ? `fetch_url to a local or private address (${local}); asks even in Auto mode.` : undefined,
    };
  },
  async run(input, context) {
    const { url, objective, offset = 0, force_refetch = false } = input;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ToolError('Only http and https URLs can be fetched.');

    let page = force_refetch ? null : cachedPage(parsed.href);
    if (!page) {
      const destination = await destinationFor(input, parsed.hostname);
      const response = await fetchWithoutCrossOriginRedirect(parsed, context.signal, destination);
      if (!response.ok) {
        await response.body?.cancel();
        throw new ToolError(`HTTP ${response.status} for ${url}`);
      }
      const type = response.headers.get('content-type') ?? '';
      const body = await readBodyCapped(response);
      page = {
        text: type.includes('html') ? extractArticle(body.text) : body.text,
        truncated: body.truncated,
        timedOut: body.timedOut,
        at: Date.now(),
      };
      rememberPage(parsed.href, page);
    }

    const total = page.text.length;
    if (offset > 0 && offset >= total)
      throw new ToolError(`offset ${offset} is past the end of the page (${total} characters).`);
    const part = page.text.slice(offset, offset + MAX_PAGE_CHARS);
    const end = offset + part.length;

    const sections: string[] = [];
    if (objective && offset === 0 && total > MAX_PAGE_CHARS) {
      const lines = relevantLines(page.text, objective);
      if (lines.length > 0) sections.push(`Lines most relevant to "${objective}":\n${lines.join('\n')}\n\n---`);
    }
    sections.push(part);
    if (end < total) {
      sections.push(`(Characters ${offset}-${end} of ${total}. Use offset=${end} to read on.)`);
    } else if (page.timedOut) {
      sections.push(
        `(The page was still downloading after ${BODY_TIMEOUT_MS / 1000} s and was cut there; the rest is not available. Pass force_refetch to try again.)`,
      );
    } else if (page.truncated) {
      sections.push(
        `(The download was cut at ${MAX_BODY_BYTES / 1024 / 1024} MB; the rest of the page is not available.)`,
      );
    }
    return {
      content: sections.join('\n\n'),
      summary: offset > 0 ? `Fetched ${url} (from character ${offset})` : `Fetched ${url}`,
    };
  },
});

// The local address a call to `url` would reach, or null when it is public, not http(s), or allow-listed by the user.
export async function localDestination(
  call: object,
  url: string,
  context: { allowsNetworkUrl?(url: string): boolean },
): Promise<string | null> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || context.allowsNetworkUrl?.(url)) return null;
  return (await destinationFor(call, parsed.hostname)).local;
}

// Follows redirects that stay on the same origin (scheme, host and port), so a redirect cannot reach another service
// on the same host or drop from https to http. Every request connects only to the checked addresses.
export async function fetchWithoutCrossOriginRedirect(
  initial: URL,
  signal: AbortSignal,
  destination?: Destination,
): Promise<Response> {
  // A same-origin hop has the same host, so it uses the same checked addresses instead of asking DNS again.
  const { addresses } = destination ?? (await resolveDestination(initial.hostname));
  let current = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    // The timeout covers only the wait for the headers and is cleared once they arrive, so it cannot abort the body
    // (readBodyCapped has its own limit). The caller's signal still aborts the body.
    const headersTimeout = new AbortController();
    const timer = setTimeout(
      () => headersTimeout.abort(new DOMException('The server did not answer in time.', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await webTransport.request(current, addresses, AbortSignal.any([signal, headersTimeout.signal]));
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    const next = new URL(location, current);
    if (next.origin !== initial.origin) {
      throw new ToolError(
        `Blocked redirect to ${next.href}. Its origin (scheme, host and port) was not approved; request that URL separately.`,
      );
    }
    current = next;
  }
  throw new ToolError(`Too many redirects for ${initial.href}`);
}

// Sends the request over node:http(s) with a lookup that returns only the checked addresses: fetch has no hook to pin
// the address, and DNS rebinding could otherwise swap in a private address between the check and the connection.
// An object so tests can replace it.
export const webTransport = {
  request(url: URL, addresses: LookupAddress[], signal: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, br' },
          lookup: pinnedLookup(addresses),
          // No shared connection pool: a pooled socket could have been opened to another address for the same host.
          agent: false,
          signal,
        },
        (message) => {
          try {
            resolve(toResponse(message));
          } catch (error) {
            message.destroy();
            reject(error);
          }
        },
      );
      request.on('error', reject);
      request.end();
    });
  },
};

const USER_AGENT = 'Mozilla/5.0 (compatible; Patch)';

export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const usable = options.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
    if (usable.length === 0) {
      callback(Object.assign(new Error('No checked address for this host.'), { code: 'ENOTFOUND' }), '');
    } else if (options.all) {
      callback(null, usable);
    } else {
      callback(null, usable[0]!.address, usable[0]!.family);
    }
  };
}

function toResponse(message: IncomingMessage): Response {
  const status = message.statusCode ?? 0;
  if (status < 200 || status > 599) throw new ToolError(`Unexpected HTTP status ${status}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  if ([204, 205, 304].includes(status)) {
    message.resume();
    return new Response(null, { status, headers });
  }
  const decoder = decoderFor(headers.get('content-encoding'));
  const body: Readable = decoder ? pipeline(message, decoder, () => {}) : message;
  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, headers });
}

// fetch decompressed bodies itself; node:http does not.
function decoderFor(encoding: string | null) {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return null;
  }
}

export function extractArticle(html: string): string {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.textContent ?? document.body?.textContent ?? '';
  const title = article?.title ? `${article.title}\n\n` : '';
  return title + text.replace(/\n{3,}/g, '\n\n').trim();
}

function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}
