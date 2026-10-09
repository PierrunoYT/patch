import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNetworkUrlAllowed } from '../agent/allowed_network_hosts';
import { bareHostname, resolveDestination } from './net_address';

// The only way out of a sandboxed command's network namespace when the network setting is "allow-list" (#97). The
// command has no route and no resolver of its own; a bridge inside forwards 127.0.0.1:PROXY_PORT to this server's
// Unix socket, mounted into the sandbox (on Windows: a loopback port inside the AppContainer, relayed to this
// server's named pipe by sandbox-helper). Each request is checked here: the hostname must be on the allow-list
// (exactly, as everywhere in Patch: an entry does not cover its subdomains), the port 80 or 443, and every address
// the name resolves to public. The proxy
// resolves the name itself and dials only the address it checked, so DNS rebinding and IP literals of local
// services get nowhere. A redirect to another host is a new request and is checked again.

export const PROXY_PORT = 3128;
const PORTS = new Set([80, 443]);

export interface FilteringProxy {
  socketPath: string;
  close(): Promise<void>;
}

export interface ProxyPolicy {
  allowedHosts: string;
  // Tests only: other ports, and a resolver that can name a loopback fixture as public.
  ports?: ReadonlySet<number>;
  resolve?: (host: string) => Promise<{ address: string; local: string | null }>;
}

async function resolvePublic(host: string): Promise<{ address: string; local: string | null }> {
  const destination = await resolveDestination(host);
  return { address: destination.addresses[0]!.address, local: destination.local };
}

// Why a destination is refused, or the one address the proxy may connect to.
export async function checkDestination(
  host: string,
  port: number,
  policy: ProxyPolicy,
): Promise<{ refused: string } | { address: string }> {
  const bare = bareHostname(host);
  if (!(policy.ports ?? PORTS).has(port)) return { refused: `port ${port} is not allowed (only 80 and 443)` };
  // URL parsing normalizes the name the same way the allow-list entries are matched.
  const url = `https://${isIP(bare) === 6 ? `[${bare}]` : bare}/`;
  if (!isNetworkUrlAllowed(url, policy.allowedHosts)) return { refused: `${bare} is not on the network allow-list` };
  try {
    const destination = await (policy.resolve ?? resolvePublic)(bare);
    if (destination.local) return { refused: `${bare} resolves to a local address (${destination.local})` };
    return { address: destination.address };
  } catch {
    return { refused: `${bare} did not resolve` };
  }
}

function refuse(response: ServerResponse, reason: string): void {
  response.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
  response.end(`Patch sandbox: ${reason}.\n`);
}

// host:port of a CONNECT target, with IPv6 literals in brackets.
function parseTarget(target: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
  return match ? { host: match[1]!, port: Number(match[2]) } : null;
}

// On Windows the proxy listens on a named pipe that only this user can open; sandbox-helper relays the command's
// AppContainer to it. Elsewhere it is a Unix socket in a private folder, mounted into the sandbox.
export async function startFilteringProxy(
  policy: ProxyPolicy,
  platform: NodeJS.Platform = process.platform,
): Promise<FilteringProxy> {
  const folder = platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'patch-net-'));
  const socketPath = folder ? join(folder, 'proxy.sock') : `\\\\.\\pipe\\patch-net-${randomBytes(16).toString('hex')}`;
  const open = new Set<Socket>();
  const track = (socket: Socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // A plain HTTP request through a proxy names the absolute URL; HTTPS must use CONNECT.
    let url: URL;
    try {
      url = new URL(request.url ?? '');
    } catch {
      return refuse(response, 'only proxy requests with an absolute http:// URL are served');
    }
    if (url.protocol !== 'http:') return refuse(response, 'use CONNECT for HTTPS');
    const port = Number(url.port || 80);
    void checkDestination(url.hostname, port, policy).then((checked) => {
      if ('refused' in checked) return refuse(response, checked.refused);
      const upstream = httpRequest(
        {
          host: checked.address,
          port,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: { ...request.headers, host: url.host },
          setHost: false,
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.once('error', () => {
        if (!response.headersSent) refuse(response, `cannot reach ${url.hostname}`);
        else response.destroy();
      });
      request.pipe(upstream);
    });
  });
  server.on('connection', track);
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    const target = parseTarget(request.url ?? '');
    const deny = (reason: string) => {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nPatch sandbox: ${reason}.\n`);
    };
    if (!target) return deny('a CONNECT target must be host:port');
    void checkDestination(target.host, target.port, policy).then((checked) => {
      if ('refused' in checked) return deny(checked.refused);
      const upstream = connect({ host: checked.address, port: target.port });
      track(upstream);
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const end = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.once('error', () => (upstream.connecting ? deny(`cannot reach ${target.host}`) : end()));
      client.once('error', end);
      client.once('close', end);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          if (folder) rmSync(folder, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
