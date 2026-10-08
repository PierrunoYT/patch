import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolver } from './net_address';
import { ShellRunner } from './shell';
import type { AgentTool, ToolContext } from './types';
import {
  charsetFrom,
  clearFetchCache,
  fetchUrlTool,
  fetchWithoutCrossOriginRedirect,
  readBodyCapped,
  webTransport,
} from './web';
import { Workspace } from './workspace';

// fetch_url against real local servers: local addresses must ask even in Auto mode, the request must connect to the
// address that was checked, and redirects must keep the origin.
let root: string;
let context: ToolContext;
let servers: Server[];
let received: Array<{ port: number; host: string | undefined; path: string | undefined }>;

async function listen(
  handler: (request: IncomingMessage, port: number) => [number, Record<string, string>, Buffer | string],
) {
  const server = createServer((request, response) => {
    const port = (server.address() as AddressInfo).port;
    received.push({ port, host: request.headers.host, path: request.url });
    const [status, headers, body] = handler(request, port);
    response.writeHead(status, headers).end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

// What the agent does with one call: validate once, then hand the same input to mustAsk, preview and run.
async function ask(tool: AgentTool, input: object, ctx = context) {
  const parsed = tool.schema!.parse(input);
  return { parsed, mustAsk: await tool.mustAsk!(parsed, ctx), preview: await tool.preview!(parsed, ctx) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-web-'));
  const workspace = new Workspace(root);
  context = {
    workspace,
    signal: new AbortController().signal,
    readFiles: new Map(),
    shell: new ShellRunner(() => workspace.root),
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
  servers = [];
  received = [];
  clearFetchCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearFetchCache();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

describe('fetch_url and local addresses', () => {
  it('asks for a loopback address with the reason, and fetches it once approved', async () => {
    const port = await listen(() => [200, { 'content-type': 'text/plain' }, 'local service']);
    const { parsed, mustAsk, preview } = await ask(fetchUrlTool, { url: `http://127.0.0.1:${port}/status` });
    expect(mustAsk).toBe(true);
    expect(preview.note).toBe('fetch_url to a local or private address (127.0.0.1); asks even in Auto mode.');
    const result = await fetchUrlTool.run(parsed, context);
    expect(result.content).toBe('local service');
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
    'http://10.0.0.1/',
  ])('asks for %s', async (url) => {
    expect((await ask(fetchUrlTool, { url })).mustAsk).toBe(true);
  });

  it('asks when a public-looking name resolves to loopback', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const { mustAsk, preview } = await ask(fetchUrlTool, { url: 'https://docs.example.com/' });
    expect(mustAsk).toBe(true);
    expect(preview.note).toContain('(127.0.0.1)');
  });

  it('does not ask for a public address or a host the user allow-listed', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const publicCall = await ask(fetchUrlTool, { url: 'https://example.com/' });
    expect(publicCall.mustAsk).toBe(false);
    expect(publicCall.preview.note).toBeUndefined();
    const listed = { ...context, allowsNetworkUrl: (url: string) => new URL(url).hostname === '127.0.0.1' };
    expect((await ask(fetchUrlTool, { url: 'http://127.0.0.1:3000/' }, listed)).mustAsk).toBe(false);
  });

  it('connects to the address that was checked, even if DNS later answers differently', async () => {
    const port = await listen(() => [200, { 'content-type': 'text/plain' }, 'pinned']);
    const lookup = vi
      .spyOn(resolver, 'lookup')
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValue([{ address: '203.0.113.9', family: 4 }]);
    const { parsed, mustAsk } = await ask(fetchUrlTool, { url: `http://rebind.example:${port}/page` });
    expect(mustAsk).toBe(true);
    const result = await fetchUrlTool.run(parsed, context);
    expect(result.content).toBe('pinned');
    expect(lookup).toHaveBeenCalledTimes(1);
    // The request went to the checked address but still names the host, as a browser would.
    expect(received).toEqual([{ port, host: `rebind.example:${port}`, path: '/page' }]);
  });

  it('passes only the checked addresses to the transport', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const request = vi.spyOn(webTransport, 'request').mockResolvedValue(new Response('ok'));
    const { parsed } = await ask(fetchUrlTool, { url: 'https://example.com/' });
    await fetchUrlTool.run(parsed, context);
    expect(request.mock.calls[0]![1]).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses a redirect to another port on the same host without contacting it', async () => {
    const other = await listen(() => [200, {}, 'other service']);
    const port = await listen(() => [302, { location: `http://127.0.0.1:${other}/admin` }, '']);
    await expect(
      fetchUrlTool.run(fetchUrlTool.schema!.parse({ url: `http://127.0.0.1:${port}/` }), context),
    ).rejects.toThrow(/Blocked redirect to http:\/\/127\.0\.0\.1:\d+\/admin\. Its origin/);
    expect(received.map((entry) => entry.port)).toEqual([port]);
  });

  it('refuses a redirect that changes the scheme on the same host and port', async () => {
    const port = await listen((_request, own) => [302, { location: `https://127.0.0.1:${own}/` }, '']);
    await expect(
      fetchUrlTool.run(fetchUrlTool.schema!.parse({ url: `http://127.0.0.1:${port}/` }), context),
    ).rejects.toThrow(/Blocked redirect/);
  });

  it('follows a same-origin redirect and decodes a compressed body', async () => {
    const port = await listen((request) =>
      request.url === '/start'
        ? [301, { location: '/final' }, '']
        : [200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, gzipSync('decoded body')],
    );
    const result = await fetchUrlTool.run(
      fetchUrlTool.schema!.parse({ url: `http://127.0.0.1:${port}/start` }),
      context,
    );
    expect(result.content).toBe('decoded body');
    expect(received.map((entry) => entry.path)).toEqual(['/start', '/final']);
  });
});

// A body that sends `chunks` and then never ends.
function stalledBody(chunks: string[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
  return new Response(stream, { headers });
}

describe('fetch_url timeouts', () => {
  it('returns what was read when the body is still arriving at the deadline', async () => {
    const body = await readBodyCapped(stalledBody(['first part, ', 'second part']), 1024, 20);
    expect(body).toEqual({ text: 'first part, second part', truncated: true, timedOut: true });
  });

  it('still throws when the user stops a slow body', async () => {
    const stop = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        stop.signal.addEventListener('abort', () => controller.error(stop.signal.reason));
      },
    });
    const reading = readBodyCapped(new Response(stream), 1024, 60_000);
    stop.abort(new DOMException('Stopped', 'AbortError'));
    await expect(reading).rejects.toThrow('Stopped');
  });

  it('clears the headers timeout once the response arrives, so it cannot abort the body', async () => {
    vi.useFakeTimers();
    try {
      let passed: AbortSignal | undefined;
      vi.spyOn(webTransport, 'request').mockImplementation(async (_url, _addresses, signal) => {
        passed = signal;
        return new Response('ok');
      });
      await fetchWithoutCrossOriginRedirect(new URL('https://example.com/'), context.signal, {
        addresses: [{ address: '93.184.216.34', family: 4 }],
        local: null,
      });
      vi.advanceTimersByTime(60_000);
      expect(passed?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notes a page cut by the body timeout', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    vi.spyOn(webTransport, 'request').mockResolvedValue(stalledBody(['slow page'], { 'content-type': 'text/plain' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const running = fetchUrlTool.run(fetchUrlTool.schema!.parse({ url: 'https://example.com/slow' }), context);
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await running;
      expect(result.content).toContain('slow page');
      expect(result.content).toContain('still downloading after 15 s');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetch_url charsets', () => {
  it.each([
    ['text/html; charset=ISO-8859-1', 'ISO-8859-1'],
    ['text/html;charset="Shift_JIS"', 'Shift_JIS'],
    ['text/plain; format=flowed; Charset=utf-8', 'utf-8'],
    ['text/html', null],
    [null, null],
  ])('reads the charset of %s', (header, charset) => {
    expect(charsetFrom(header)).toBe(charset);
  });

  it('decodes a Latin-1 body', async () => {
    const response = new Response(Buffer.from('café crème', 'latin1'), {
      headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
    });
    expect((await readBodyCapped(response)).text).toBe('café crème');
  });

  it('decodes a Shift-JIS body', async () => {
    // 日本語 in Shift-JIS.
    const response = new Response(new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), {
      headers: { 'content-type': 'text/html; charset=shift_jis' },
    });
    expect((await readBodyCapped(response)).text).toBe('日本語');
  });

  it('falls back to UTF-8 for an unknown charset', async () => {
    const response = new Response('naïve', { headers: { 'content-type': 'text/plain; charset=not-a-charset' } });
    expect((await readBodyCapped(response)).text).toBe('naïve');
  });
});
