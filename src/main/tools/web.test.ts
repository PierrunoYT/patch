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
import { clearFetchCache, fetchUrlTool, webTransport } from './web';
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
