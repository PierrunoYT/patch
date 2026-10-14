import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDestination,
  clientHelloServerName,
  startFilteringProxy,
  type FilteringProxy,
  type ProxyPolicy,
} from './net_proxy';

// The filtering proxy's decision for one request (#97). Real connections are covered by the bubblewrap test in
// sandbox.integration.test.ts.
describe('checkDestination', () => {
  const resolve =
    (address: string, local: string | null = null) =>
    async () => ({ address, local });
  const policy = (extra: Partial<ProxyPolicy> = {}): ProxyPolicy => ({
    allowedHosts: 'registry.npmjs.org\nPyPI.org\n93.184.216.34',
    resolve: resolve('104.16.0.1'),
    ...extra,
  });

  it('allows a listed host on 80 or 443 and connects to the address it checked', async () => {
    expect(await checkDestination('registry.npmjs.org', 443, policy())).toEqual({ address: '104.16.0.1' });
    expect(await checkDestination('REGISTRY.npmjs.org.', 80, policy())).toEqual({ address: '104.16.0.1' });
    expect(await checkDestination('pypi.org', 443, policy())).toEqual({ address: '104.16.0.1' });
  });

  it('refuses unlisted hosts, subdomains, other ports and unresolvable names', async () => {
    expect(await checkDestination('evil.example', 443, policy())).toEqual({
      refused: 'evil.example is not on the network allow-list',
    });
    expect(await checkDestination('x.registry.npmjs.org', 443, policy())).toMatchObject({ refused: /allow-list/ });
    expect(await checkDestination('registry.npmjs.org', 22, policy())).toEqual({
      refused: 'port 22 is not allowed (only 80 and 443)',
    });
    const failing = policy({ resolve: async () => Promise.reject(new Error('ENOTFOUND')) });
    expect(await checkDestination('registry.npmjs.org', 443, failing)).toEqual({
      refused: 'registry.npmjs.org did not resolve',
    });
  });

  it('refuses a listed name that resolves to a local address (DNS rebinding)', async () => {
    const rebound = policy({ resolve: resolve('10.0.0.5', '10.0.0.5') });
    expect(await checkDestination('registry.npmjs.org', 443, rebound)).toEqual({
      refused: 'registry.npmjs.org resolves to a local address (10.0.0.5)',
    });
  });

  it('checks IP literals like names, with the real resolver', async () => {
    const real = { allowedHosts: '93.184.216.34\n127.0.0.1\n::1' };
    expect(await checkDestination('93.184.216.34', 443, real)).toEqual({ address: '93.184.216.34' });
    expect(await checkDestination('127.0.0.1', 443, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('[::1]', 443, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('169.254.169.254', 80, real)).toMatchObject({ refused: /allow-list/ });
  });
});

// A TLS ClientHello as Node's own client sends it, naming `servername` (or none).
async function captureClientHello(servername?: string): Promise<Buffer> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const hello = new Promise<Buffer>((resolve) =>
    server.once('connection', (socket) => {
      let data = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (clientHelloServerName(data) !== 'incomplete') {
          resolve(data);
          socket.destroy();
        }
      });
    }),
  );
  const client = tlsConnect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false });
  client.on('error', () => {});
  const data = await hello;
  client.destroy();
  server.close();
  return data;
}

describe('clientHelloServerName (#239)', () => {
  it('reads the server name of a real ClientHello, and knows when it is incomplete or not TLS', async () => {
    const hello = await captureClientHello('registry.npmjs.org');
    expect(clientHelloServerName(hello)).toBe('registry.npmjs.org');
    expect(clientHelloServerName(hello.subarray(0, 20))).toBe('incomplete');
    expect(clientHelloServerName(Buffer.from('GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n'))).toBe('not-tls');
    // Node sends no server name for an IP address.
    expect(clientHelloServerName(await captureClientHello())).toBeNull();
  });

  it('reads a hello split over two handshake records', async () => {
    const hello = await captureClientHello('pypi.org');
    const body = hello.subarray(5, 5 + hello.readUInt16BE(3));
    const record = (part: Buffer) =>
      Buffer.concat([Buffer.from([0x16, 0x03, 0x01, part.length >> 8, part.length & 0xff]), part]);
    const split = Buffer.concat([record(body.subarray(0, 40)), record(body.subarray(40))]);
    expect(clientHelloServerName(split.subarray(0, 50))).toBe('incomplete');
    expect(clientHelloServerName(split)).toBe('pypi.org');
  });
});

describe('the filtering proxy relays a CONNECT tunnel only for TLS naming the checked host (#239)', () => {
  let proxy: FilteringProxy;
  let upstream: Server;
  let received: Buffer[];

  beforeAll(async () => {
    received = [];
    upstream = createServer((socket) => socket.on('data', (chunk: Buffer) => received.push(chunk)));
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const { port } = upstream.address() as AddressInfo;
    proxy = await startFilteringProxy({
      allowedHosts: 'registry.npmjs.org\n127.0.0.1',
      ports: new Set([port]),
      resolve: async () => ({ address: '127.0.0.1', local: null }),
    });
  });

  afterAll(async () => {
    await proxy?.close();
    upstream?.close();
  });

  // Opens a tunnel to `host`, sends `payload` through it, and reports whether the upstream got anything.
  async function tunnel(host: string, payload: Buffer): Promise<boolean> {
    received.length = 0;
    const { port } = upstream.address() as AddressInfo;
    const socket = connect(proxy.socketPath);
    await once(socket, 'connect');
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    const [answer] = (await once(socket, 'data')) as [Buffer];
    expect(answer.toString()).toMatch(/^HTTP\/1\.1 200/);
    socket.write(payload);
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.destroy();
    return received.length > 0;
  }

  it('relays a hello that names the host the CONNECT was checked for', async () => {
    expect(await tunnel('registry.npmjs.org', await captureClientHello('registry.npmjs.org'))).toBe(true);
    // An IP literal target may have a hello without a server name.
    expect(await tunnel('127.0.0.1', await captureClientHello())).toBe(true);
  });

  it('cuts a tunnel whose hello names another site, has no name, or is not TLS', async () => {
    expect(await tunnel('registry.npmjs.org', await captureClientHello('attacker.workers.dev'))).toBe(false);
    expect(await tunnel('registry.npmjs.org', await captureClientHello())).toBe(false);
    expect(
      await tunnel('registry.npmjs.org', Buffer.from('GET / HTTP/1.1\r\nHost: attacker.workers.dev\r\n\r\n')),
    ).toBe(false);
  });
});

describe('the agent browser proxy checks every connection of a public page (#301)', () => {
  let proxy: FilteringProxy;
  let upstream: Server;
  let lookups = 0;

  beforeAll(async () => {
    upstream = createServer((socket) => socket.on('data', (chunk: Buffer) => socket.write(chunk)));
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    proxy = await startFilteringProxy(
      {
        allowedHosts: null,
        ports: 'any',
        tlsName: false,
        // The fixture stands in for a public site; rebind.test answers public once, then this machine (TTL 0).
        resolve: async (host) => {
          if (host === 'rebind.test') lookups++;
          const local = host === 'rebind.test' && lookups > 1 ? '127.0.0.1' : host === 'local.test' ? '10.0.0.1' : null;
          return { address: '127.0.0.1', local };
        },
      },
      process.platform,
      { tcp: true },
    );
  });

  afterAll(async () => {
    await proxy?.close();
    upstream?.close();
  });

  // Opens a tunnel to host:port through the proxy and returns the proxy's answer and what came back for `payload`.
  async function tunnel(host: string, payload = 'ping'): Promise<{ status: string; echo: string }> {
    const { port } = upstream.address() as AddressInfo;
    const socket = connect(proxy.port!, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    const [answer] = (await once(socket, 'data')) as [Buffer];
    const status = answer.toString().split('\r\n')[0]!;
    let echo = '';
    if (status.includes(' 200 ')) {
      socket.write(payload);
      echo = ((await once(socket, 'data')) as [Buffer])[0].toString();
    }
    socket.destroy();
    return { status, echo };
  }

  it('listens on a loopback port and tunnels plain data (WebSockets) to any public host and port', async () => {
    expect(proxy.socketPath).toBe(`127.0.0.1:${proxy.port}`);
    expect(await tunnel('public.test', 'GET /socket HTTP/1.1\r\n\r\n')).toEqual({
      status: 'HTTP/1.1 200 Connection Established',
      echo: 'GET /socket HTTP/1.1\r\n\r\n',
    });
  });

  it('refuses a name once it rebinds to this machine, and names that resolve to the local network', async () => {
    expect((await tunnel('rebind.test')).echo).toBe('ping');
    expect((await tunnel('rebind.test')).status).toMatch(/^HTTP\/1\.1 403/);
    expect((await tunnel('local.test')).status).toMatch(/^HTTP\/1\.1 403/);
  });

  it('refuses address literals of this machine with the real resolver', async () => {
    const real = { allowedHosts: null, ports: 'any' as const };
    expect(await checkDestination('127.0.0.1', 8080, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('169.254.169.254', 80, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('[::1]', 9000, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('93.184.216.34', 8443, real)).toEqual({ address: '93.184.216.34' });
    expect(await checkDestination('93.184.216.34', 0, real)).toMatchObject({ refused: /not valid/ });
  });
});
