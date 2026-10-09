import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@shared/settings';
import { launchConfig, McpHub } from './mcp';
import { probeSandboxSupport } from './sandbox';
import { listProcesses } from './shell_leftovers';

// A real stdio MCP server in a real sandbox (#87). Linux (bubblewrap) or Windows (AppContainer).
const support = await probeSandboxSupport();
const available =
  (process.platform === 'linux' && support.bwrap) || (process.platform === 'win32' && Boolean(support.appcontainer));
const mockServer = join(__dirname, '../../../tests/e2e/mock_mcp_server.mjs');

describe.skipIf(!available)('sandboxed stdio MCP server', () => {
  let home: string;
  let project: string;
  let data: string;
  let script: string;

  beforeAll(() => {
    // Under the home folder, which the sandbox hides, so reads outside the granted folders really are denied.
    home = realpathSync(mkdtempSync(join(homedir(), '.patch-mcp-sandbox-')));
    project = join(home, 'project');
    data = join(home, 'userData', 'mcp');
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(home, 'secret.txt'), 'HOME-SECRET');
    writeFileSync(join(project, 'inside.txt'), 'PROJECT-FILE');
    // The server script must be readable inside: the project is, the test checkout in the home folder is not.
    script = join(project, 'server.mjs');
    copyFileSync(mockServer, script);
  });

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const withServer = async (
    server: Omit<McpServerConfig, 'transport' | 'command'>,
    check: (call: (action: string, target: string) => Promise<string>, hub: McpHub) => Promise<void>,
  ) => {
    const config = launchConfig(
      {
        transport: 'stdio',
        command: process.execPath,
        env: { MOCK_MCP_PROBE: '1' },
        sandbox: true,
        ...server,
      },
      project,
      data,
    );
    const hub = new McpHub(
      () => [config],
      () => {},
    );
    try {
      await hub.refresh();
      expect(hub.status()[0], JSON.stringify(hub.status())).toMatchObject({ state: 'connected' });
      const tool = hub.tools().find((entry) => entry.name.endsWith('_probe'))!;
      await check(async (action, target) => (await tool.run({ action, target }, {} as never)).content, hub);
    } finally {
      await hub.stop();
    }
  };

  it('serves tools, writes only its own folder and the named project, and sees nothing else', async () => {
    const state = launchConfig({ name: 'boxed', transport: 'stdio', command: 'x', sandbox: true }, project, data).cwd!;
    await withServer({ name: 'boxed', args: ['${project}/server.mjs'] }, async (call) => {
      expect(await call('read', join(project, 'inside.txt'))).toBe('content:PROJECT-FILE');
      expect(await call('read', join(home, 'secret.txt'))).toMatch(/^(ENOENT|EACCES|EPERM)$/);
      expect(await call('write', join(project, 'made-by-mcp.txt'))).toBe('written');
      expect(readFileSync(join(project, 'made-by-mcp.txt'), 'utf8')).toBe('WRITTEN-BY-MCP');
      expect(await call('write', join(project, '.git', 'hooks', 'pre-commit'))).toMatch(/^(EROFS|EACCES|EPERM)$/);
      expect(existsSync(join(project, '.git', 'hooks', 'pre-commit'))).toBe(false);
      // The home folder inside is a private tmpfs: a write may succeed there, but never reaches the host.
      await call('write', join(home, 'planted.txt'));
      expect(existsSync(join(home, 'planted.txt'))).toBe(false);
      // Its HOME is its own folder, kept between starts.
      expect(await call('write', join(state, 'state.txt'))).toBe('written');
    });
    expect(readFileSync(join(state, 'state.txt'), 'utf8')).toBe('WRITTEN-BY-MCP');
  }, 60_000);

  it('cannot write the project when it does not name ${project}', async () => {
    // The script is still passed by its path, so ${project} is not in the args: copy it into the server's folder.
    const name = 'unscoped';
    const state = launchConfig({ name, transport: 'stdio', command: 'x', sandbox: true }, project, data).cwd!;
    mkdirSync(state, { recursive: true });
    copyFileSync(mockServer, join(state, 'server.mjs'));
    await withServer({ name, args: ['server.mjs'] }, async (call) => {
      expect(await call('read', join(project, 'inside.txt'))).toMatch(/^(ENOENT|EACCES|EPERM)$/);
      expect(await call('write', join(project, 'unscoped.txt'))).toMatch(/^(ENOENT|EROFS|EACCES|EPERM)$/);
    });
    expect(existsSync(join(project, 'unscoped.txt'))).toBe(false);
  }, 60_000);

  it('reaches the network only with sandboxNetwork, and leaves no process behind', async () => {
    const listener = createServer((socket) => socket.end());
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    // Windows cannot reach the host's loopback listener reliably, so it probes a public address; Linux bubblewrap with network shares it.
    const publicHost = process.platform === 'win32';
    const target = publicHost ? '1.1.1.1:443' : `127.0.0.1:${(listener.address() as { port: number }).port}`;
    const hostCanConnect =
      !publicHost ||
      (await new Promise<boolean>((resolve) => {
        const socket = connect({ host: '1.1.1.1', port: 443, timeout: 4000 }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      }));
    const running = async () => {
      if (process.platform === 'win32') {
        try {
          const count = execFileSync(
            'powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ${JSON.stringify(`*server.mjs*`)} }).Count`,
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
          );
          return Number(count.trim());
        } catch {
          return 0;
        }
      }
      return ((await listProcesses()) ?? []).filter((row) => {
        try {
          return readFileSync(`/proc/${row.pid}/cmdline`, 'utf8').includes(script);
        } catch {
          return false;
        }
      }).length;
    };
    try {
      await withServer({ name: 'offline', args: ['${project}/server.mjs'] }, async (call) => {
        expect(await call('connect', target)).toMatch(
          /^(ENETUNREACH|ECONNREFUSED|EACCES|EPERM|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/,
        );
      });
      if (hostCanConnect) {
        await withServer({ name: 'online', args: ['${project}/server.mjs'], sandboxNetwork: true }, async (call) => {
          expect(await call('connect', target)).toBe('connected');
          expect(await running()).toBeGreaterThan(0);
        });
      }
      // Nothing that ran the sandboxed server outlives the stop.
      let left = await running();
      for (let attempt = 0; left > 0 && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        left = await running();
      }
      expect(left).toBe(0);
    } finally {
      listener.close();
    }
  }, 90_000);
});
