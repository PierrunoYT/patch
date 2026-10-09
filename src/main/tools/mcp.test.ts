import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@shared/settings';
import { launchConfig, McpHub, resolveCommand } from './mcp';
import { mcpSandboxUnavailable } from './mcp_sandbox';
import { findHelper } from './sandbox_windows';

// The mock MCP server used by the end-to-end tests; spawning it here exercises the real client over stdio.
const mockServerScript = join(__dirname, '../../../tests/e2e/mock_mcp_server.mjs');

describe('McpHub', () => {
  it('connects over stdio, lists tools and calls one', async () => {
    const servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    let changed = 0;
    const hub = new McpHub(
      () => servers,
      () => changed++,
    );
    try {
      await hub.refresh();

      expect(changed).toBe(1);
      expect(hub.status()).toEqual([{ name: 'test', state: 'connected', tools: ['mcp_test_echo'] }]);
      const tools = hub.tools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.requiresApproval).toBe(true);
      expect(tools[0]!.jsonSchema).toEqual({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      });

      const output = await tools[0]!.run({ text: 'hi' }, {} as never);
      expect(output.content).toBe('echo:hi');
      expect(output.isError).toBeUndefined();
    } finally {
      await hub.stop();
    }
  });

  it('introduces itself to servers with the name and version it was given (#72)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-client-'));
    const file = join(dir, 'client.json');
    const servers: McpServerConfig[] = [
      {
        name: 'test',
        transport: 'stdio',
        command: process.execPath,
        args: [mockServerScript],
        env: { MOCK_MCP_CLIENT_FILE: file },
      },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
      { name: 'Patch', version: '9.8.7' },
    );
    try {
      await hub.refresh();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ name: 'Patch', version: '9.8.7' });
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a server that cannot start and still serves the others', async () => {
    const servers: McpServerConfig[] = [
      { name: 'broken', transport: 'stdio', command: 'definitely-not-a-real-command-12345' },
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    try {
      await hub.refresh();
      const status = Object.fromEntries(hub.status().map((entry) => [entry.name, entry]));
      expect(status.broken).toMatchObject({ state: 'error' });
      expect(status.broken!.error).toBeTruthy();
      expect(status.test).toMatchObject({ state: 'connected' });
      expect(hub.tools().map((tool) => tool.name)).toEqual(['mcp_test_echo']);
    } finally {
      await hub.stop();
    }
  });

  it('does not start a server that uses ${project} while no project is open', async () => {
    const servers = [
      launchConfig(
        { name: 'fs', transport: 'stdio', command: process.execPath, args: [mockServerScript, '${project}'] },
        undefined,
        __dirname,
      ),
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    try {
      await hub.refresh();
      expect(hub.status()[0]).toMatchObject({ state: 'error', error: expect.stringMatching(/Open a project/) });
    } finally {
      await hub.stop();
    }
  });

  it('drops removed servers and reconnects changed ones', async () => {
    let servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    try {
      await hub.refresh();
      expect(hub.tools()).toHaveLength(1);

      servers = [];
      await hub.refresh();
      expect(hub.tools()).toEqual([]);
      expect(hub.status()).toEqual([]);
    } finally {
      await hub.stop();
    }
  });

  // #166: a server that exits after connecting must not stay "connected" with tools that can only fail.
  it('reports a server that stops after connecting and reconnects it on the next refresh', async () => {
    const servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    let changed = 0;
    const hub = new McpHub(
      () => servers,
      () => changed++,
    );
    try {
      await hub.refresh();
      const tool = hub.tools()[0]!;
      const pid = serverPid(hub, 'test');
      process.kill(pid, 'SIGKILL');
      for (let i = 0; i < 100 && hub.status()[0]!.state === 'connected'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(hub.status()).toEqual([{ name: 'test', state: 'error', error: 'The server stopped.', tools: [] }]);
      expect(hub.tools()).toEqual([]);
      expect(changed).toBe(2);
      await expect(tool.run({ text: 'hi' }, {} as never)).rejects.toThrow('The MCP server "test" is not connected.');

      await hub.refresh();
      expect(hub.status()).toEqual([{ name: 'test', state: 'connected', tools: ['mcp_test_echo'] }]);
      expect(serverPid(hub, 'test')).not.toBe(pid);
      const output = await hub.tools()[0]!.run({ text: 'back' }, {} as never);
      expect(output.content).toBe('echo:back');
    } finally {
      await hub.stop();
    }
  });

  it('does not report a server it closed itself as stopped', async () => {
    let servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    let changed = 0;
    const hub = new McpHub(
      () => servers,
      () => changed++,
    );
    try {
      await hub.refresh();
      // A changed config closes the old client and connects a new one; the old client's close must not touch it.
      servers = [{ ...servers[0]!, env: { CHANGED: '1' } }];
      await hub.refresh();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hub.status()).toEqual([{ name: 'test', state: 'connected', tools: ['mcp_test_echo'] }]);
      // One notice per refresh, and none for the close the hub asked for.
      expect(changed).toBe(2);
      await hub.stop();
      expect(changed).toBe(2);
    } finally {
      await hub.stop();
    }
  });

  // #117: wrappers such as npx make the real server a grandchild; stopping must not leave it running.
  it('stops the processes a stdio server started, not only the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-tree-'));
    const script = join(dir, 'wrapper.mjs');
    const pidFile = join(dir, 'child.pid');
    // Starts a child that ignores stdin and runs until killed, then serves MCP itself. Detached, because on Windows
    // Node otherwise ends its children with it (a kill-on-close job), which cmd.exe running npx does not do.
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        `await import(${JSON.stringify(pathToFileURL(mockServerScript).href)});`,
      ].join('\n'),
    );
    const servers: McpServerConfig[] = [
      { name: 'wrapped', transport: 'stdio', command: process.execPath, args: [script] },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let child = 0;
    try {
      await hub.refresh();
      expect(hub.status()[0]).toMatchObject({ state: 'connected' });
      child = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(child)).toBe(true);
      await hub.stop();
      await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 5_000 });
    } finally {
      await hub.stop();
      if (child && alive(child)) process.kill(child, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // #190: quitting while a server is still connecting must not wait out the connect and tool-list timeouts.
  it('stops at once while a server is still connecting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-hang-'));
    const script = join(dir, 'hang.mjs');
    // Starts but never answers the initialize request.
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const servers: McpServerConfig[] = [
      { name: 'slow', transport: 'stdio', command: process.execPath, args: [script] },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    try {
      hub.start();
      for (let i = 0; i < 100 && hub.status()[0]?.state !== 'connecting'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      await hub.stop();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(hub.status()[0]).toMatchObject({ state: 'connecting' });
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// The process id of a connected stdio server, read from the hub's private state.
function serverPid(hub: McpHub, name: string): number {
  const states = (hub as unknown as { states: Map<string, { client: { transport?: { pid?: number } } | null }> })
    .states;
  const pid = states.get(name)?.client?.transport?.pid;
  if (typeof pid !== 'number') throw new Error(`no process for ${name}`);
  return pid;
}

// #142: a stdio server must never run a program planted in the project, or start inside it.
describe('launchConfig', () => {
  const server: McpServerConfig = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server', '.'] };

  it('starts stdio servers in the private folder, whatever project is open', () => {
    const a = launchConfig({ ...server, env: { TOKEN: 'x' } }, 'C:\\a', 'C:\\data\\mcp');
    expect(a).toEqual({ ...server, env: { TOKEN: 'x' }, cwd: 'C:\\data\\mcp' });
    // Unchanged config across a project switch, so the server is not reconnected.
    expect(launchConfig(server, 'C:\\b', 'C:\\data\\mcp')).toEqual(launchConfig(server, 'C:\\a', 'C:\\data\\mcp'));
  });

  it('gives the project path only where args or env name ${project}', () => {
    const withProject = { ...server, args: ['server', '${project}/src'], env: { ROOT: '${project}', TOKEN: 'x' } };
    expect(launchConfig(withProject, '/home/me/p', '/data/mcp')).toEqual({
      ...withProject,
      args: ['server', '/home/me/p/src'],
      env: { ROOT: '/home/me/p', TOKEN: 'x' },
      cwd: '/data/mcp',
    });
    expect(launchConfig(withProject, undefined, '/data/mcp').args).toEqual(['server', '${project}/src']);
  });

  it('leaves HTTP servers alone', () => {
    const http: McpServerConfig = { name: 'docs', transport: 'http', url: 'https://x.test/mcp' };
    expect(launchConfig(http, 'C:\\a', 'C:\\data\\mcp')).toBe(http);
  });

  // #87: a sandboxed server writes only its own folder, and the project only when it names it.
  it('gives a sandboxed server its own folder, and project access only through ${project}', () => {
    const sandboxed = { ...server, sandbox: true };
    const plain = launchConfig(sandboxed, '/home/me/p', '/data/mcp');
    expect(plain.cwd).toMatch(/[\\/]sandboxed[\\/]fs-[0-9a-f]{8}$/);
    expect(plain.cwd!.startsWith(join('/data/mcp', 'sandboxed'))).toBe(true);
    expect(plain.projectAccess).toBeUndefined();
    expect(launchConfig({ ...sandboxed, name: 'f s' }, undefined, '/data/mcp').cwd).not.toBe(plain.cwd);
    const withProject = launchConfig({ ...sandboxed, args: ['${project}'] }, '/home/me/p', '/data/mcp');
    expect(withProject).toMatchObject({ args: ['/home/me/p'], projectAccess: '/home/me/p' });
    // Access is never taken from the stored settings, and an unsandboxed server has no use for it.
    expect(launchConfig({ ...sandboxed, projectAccess: '/etc' }, '/home/me/p', '/data/mcp').projectAccess).toBe(
      undefined,
    );
    expect(launchConfig({ ...server, args: ['${project}'] }, '/home/me/p', '/data/mcp').projectAccess).toBe(undefined);
  });
});

describe('sandboxed stdio servers (#87)', () => {
  it('names why a sandboxed server cannot start, and never starts it unsandboxed', async () => {
    const support = { bwrap: false, seatbelt: true, appcontainer: 'helper.exe', container: null };
    expect(mcpSandboxUnavailable('win32', support)).toBeNull();
    expect(mcpSandboxUnavailable('win32', { ...support, appcontainer: null })).toMatch(/sandbox helper/);
    expect(mcpSandboxUnavailable('darwin', support)).toMatch(/Linux \(bubblewrap\) and Windows/);
    expect(mcpSandboxUnavailable('linux', support)).toMatch(/bubblewrap/);
    expect(mcpSandboxUnavailable('linux', { ...support, bwrap: true })).toBeNull();
  });

  it.skipIf(process.platform === 'linux' || (process.platform === 'win32' && Boolean(findHelper())))(
    'reports a sandboxed server as an error on this platform',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-unsandboxable-'));
      const marker = join(dir, 'started.txt');
      const servers: McpServerConfig[] = [
        launchConfig(
          {
            name: 'boxed',
            transport: 'stdio',
            command: process.execPath,
            args: [mockServerScript],
            env: { MOCK_MCP_CLIENT_FILE: marker },
            sandbox: true,
          },
          undefined,
          dir,
        ),
      ];
      const hub = new McpHub(
        () => servers,
        () => {},
      );
      try {
        await hub.refresh();
        expect(hub.status()[0]).toMatchObject({
          state: 'error',
          error: expect.stringMatching(/Linux \(bubblewrap\) and Windows|sandbox helper/),
        });
        expect(existsSync(marker)).toBe(false);
      } finally {
        await hub.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('resolveCommand', () => {
  const files =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it('ignores PATH entries that depend on the working folder, where a project could plant the program', () => {
    const exists = files('npx.cmd', 'C:\\proj\\npx.cmd', 'C:\\node\\npx.cmd');
    expect(resolveCommand('npx', '.;;proj;C:\\node', '.exe;.cmd', 'win32', exists)).toBe('C:\\node\\npx.cmd');
    expect(resolveCommand('npx', '.:bin:/usr/bin', undefined, 'linux', files('bin/npx', '/usr/bin/npx'))).toBe(
      '/usr/bin/npx',
    );
  });

  it('follows PATH order and PATHEXT, and keeps an extension that is already given', () => {
    const exists = files('C:\\a\\tool.CMD', 'C:\\b\\tool.EXE', 'C:\\b\\tool.cmd');
    expect(resolveCommand('tool', '"C:\\a";C:\\b', '.EXE;.CMD', 'win32', exists)).toBe('C:\\a\\tool.CMD');
    expect(resolveCommand('tool.cmd', 'C:\\a;C:\\b', '.EXE;.CMD', 'win32', exists)).toBe('C:\\b\\tool.cmd');
  });

  it('runs an absolute path as it is and refuses relative paths', () => {
    expect(resolveCommand('C:\\tools\\srv.exe', '', undefined, 'win32', files())).toBe('C:\\tools\\srv.exe');
    expect(resolveCommand('/opt/srv', '', undefined, 'linux', files())).toBe('/opt/srv');
    for (const relative of ['.\\srv.exe', 'bin\\srv', 'C:srv.exe', '\\srv.exe'])
      expect(() => resolveCommand(relative, 'C:\\bin', undefined, 'win32', files())).toThrow(/relative path/);
    expect(() => resolveCommand('./srv', '/bin', undefined, 'linux', files())).toThrow(/relative path/);
  });

  it('says when the program is not on PATH', () => {
    expect(() => resolveCommand('uvx', 'C:\\bin', undefined, 'win32', files())).toThrow(/not found on PATH/);
  });
});
