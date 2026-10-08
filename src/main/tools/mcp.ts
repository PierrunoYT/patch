import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpStatus } from '@shared/settings';
import { fixedSearchPath } from '../exec_search';
import type { JsonObjectSchema } from '../llm/types';
import { ToolError, truncateOutput, type AgentTool, type ToolOutput } from './types';

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

export const PROJECT_PLACEHOLDER = '${project}';

// Stdio servers never start in the project (#142): there, `npx` prefers the project's node_modules/.bin, `python -m`
// imports from it, and the MCP SDK's cross-spawn looks for the program itself in the working folder first on
// Windows. They start in a private folder instead, and see the open project only where their args or env name it as
// ${project}, so a project switch reconnects only those servers.
export function launchConfig(server: McpServerConfig, project: string | undefined, workDir: string): McpServerConfig {
  if (server.transport !== 'stdio') return server;
  const expand = (value: string) => (project ? value.split(PROJECT_PLACEHOLDER).join(project) : value);
  return {
    ...server,
    ...(server.args && { args: server.args.map(expand) }),
    ...(server.env && {
      env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)])),
    }),
    cwd: workDir,
  };
}

function usesProject(server: McpServerConfig): boolean {
  return [...(server.args ?? []), ...Object.values(server.env ?? {})].some((value) =>
    value.includes(PROJECT_PLACEHOLDER),
  );
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// The absolute path of the program a stdio server runs, found only in PATH folders that don't depend on the working
// folder, so nothing planted in a project can stand in for it.
export function resolveCommand(
  command: string,
  searchPath: string,
  pathExt: string | undefined,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isFile,
): string {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  if (windows ? /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(command) : command.startsWith('/')) return command;
  if (/[\\/]/.test(command) || (windows && command.includes(':'))) {
    throw new Error(`"${command}" is a relative path; use a program name found on PATH or an absolute path.`);
  }
  const extensions = (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  const suffixes = windows && !hasExtension ? extensions : [''];
  for (const entry of fixedSearchPath(searchPath, platform).path.split(windows ? ';' : ':')) {
    const folder = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!folder) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(folder, command + suffix);
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error(`"${command}" was not found on PATH.`);
}

function pathOf(env: Record<string, string>): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key ? env[key]! : '';
}

interface ServerState {
  config: McpServerConfig;
  client: Client | null;
  // Set while a connection attempt is in flight, so a timeout or a later stop can close what it spawned.
  connecting: Client | null;
  error?: string;
  // The server's own tool descriptions, named only after every server has connected so names cannot collide.
  listed: McpToolDescription[];
  tools: AgentTool[];
}

interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: JsonObjectSchema;
}

// Connects to the configured Model Context Protocol servers and exposes their tools to the agent. Connections are
// refreshed in the background; the per-turn tool callback needs a synchronous list, so it reads the cache.
export class McpHub {
  private readonly states = new Map<string, ServerState>();
  private updating: Promise<void> | null = null;
  private stopped = false;
  private dirty = false;

  constructor(
    private readonly getServers: () => McpServerConfig[],
    private readonly onToolsChanged: () => void,
    private readonly clientInfo = { name: 'CodeCompanion', version: '0.1.0' },
  ) {}

  // Reconnects every configured server in the background. Called at startup and when the servers setting changes.
  start(): void {
    void this.refresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Close clients still connecting right away (#190): their pending connect/listTools then fail at once, instead
    // of quitting waiting out the connect and tool-list timeouts. connectOne checks `stopped` afterwards.
    await Promise.all([...this.states.values()].filter((state) => state.connecting).map((state) => closeClient(state)));
    await this.updating;
    await Promise.all([...this.states.values()].map((state) => closeClient(state)));
    this.states.clear();
  }

  tools(): AgentTool[] {
    return [...this.states.values()].flatMap((state) => state.tools);
  }

  status(): McpStatus[] {
    return this.getServers().map((config) => {
      const state = this.states.get(config.name);
      if (!state || state.connecting) return { name: config.name, state: 'connecting' as const, tools: [] };
      return {
        name: config.name,
        state: state.client ? ('connected' as const) : ('error' as const),
        error: state.error,
        tools: state.tools.map((tool) => tool.name),
      };
    });
  }

  async refresh(): Promise<void> {
    // A config change that arrives while a refresh is connecting must not be lost: the in-flight one read the old
    // config. One follow-up covers every waiter, so several changes collapse into a single extra refresh.
    if (this.updating) {
      this.dirty = true;
      return this.updating;
    }
    this.updating = this.refreshNow().finally(() => (this.updating = null));
    await this.updating;
    if (this.dirty && !this.stopped) {
      this.dirty = false;
      return this.refresh();
    }
  }

  private async refreshNow(): Promise<void> {
    const configs = this.getServers();
    for (const [name, state] of [...this.states]) {
      if (!configs.some((config) => config.name === name)) {
        await closeClient(state);
        this.states.delete(name);
      }
    }
    await Promise.all(configs.map((config) => this.connectOne(config)));
    this.assignToolNames();
    this.onToolsChanged();
  }

  private async connectOne(config: McpServerConfig): Promise<void> {
    const existing = this.states.get(config.name);
    if (existing?.client && JSON.stringify(existing.config) === JSON.stringify(config)) return;
    if (existing) {
      await closeClient(existing);
      existing.client = null;
      existing.tools = [];
    }
    const state: ServerState = existing ?? { config, client: null, connecting: null, listed: [], tools: [] };
    state.config = config;
    state.listed = [];
    this.states.set(config.name, state);

    const client = new Client(this.clientInfo, { capabilities: {} });
    state.connecting = client;
    try {
      const transport =
        config.transport === 'stdio'
          ? stdioTransport(config)
          : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });
      await withTimeout(client.connect(transport), `connecting to ${config.name} timed out`);
      const listed = await withTimeout(client.listTools(), `listing tools of ${config.name} timed out`);
      if (this.stopped) {
        await closeClient(state);
        return;
      }
      state.client = client;
      state.error = undefined;
      state.listed = listed.tools as McpToolDescription[];
      client.onclose = () => this.onServerClosed(state, client);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.tools = [];
      await closeClient(state);
    } finally {
      state.connecting = null;
    }
  }

  // A server that exits or drops the connection on its own. closeClient clears state.client before closing, so this
  // only acts on unexpected closes, and the instance check ignores a late callback from a client already replaced.
  // The next refresh reconnects it, because a state without a client is never skipped.
  private onServerClosed(state: ServerState, client: Client): void {
    if (state.client !== client || this.stopped) return;
    state.client = null;
    state.error = 'The server stopped.';
    state.listed = [];
    state.tools = [];
    this.onToolsChanged();
  }

  // Names are assigned in config order once every server has connected, so two servers that connect in parallel
  // cannot both claim the same name.
  private assignToolNames(): void {
    const taken = new Set<string>();
    for (const state of this.states.values()) {
      state.tools = state.listed.map((tool) => this.toAgentTool(state.config, state, tool, taken));
    }
  }

  private toAgentTool(
    config: McpServerConfig,
    state: ServerState,
    tool: McpToolDescription,
    taken: Set<string>,
  ): AgentTool {
    const name = qualifiedToolName(config.name, tool.name, taken);
    taken.add(name);
    return {
      name,
      description: tool.description ?? '',
      jsonSchema: tool.inputSchema ?? { type: 'object' },
      // MCP tools come from outside the app and run programs the user configured, so they ask even in Auto mode.
      requiresApproval: true,
      alwaysAsk: true,
      run: async (input, context) => {
        const client = state.client;
        if (!client) throw new ToolError(`The MCP server "${config.name}" is not connected.`);
        const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
          timeout: CALL_TIMEOUT_MS,
          signal: context.signal,
        });
        return toToolOutput(result as McpToolResult);
      },
    };
  }
}

function stdioTransport(config: McpServerConfig): StdioClientTransport {
  if (usesProject(config)) throw new Error(`Open a project to start this server: it uses ${PROJECT_PLACEHOLDER}.`);
  const env = { ...getDefaultEnvironment(), ...config.env };
  return new StdioClientTransport({
    command: resolveCommand(config.command!, pathOf(env), process.env.PATHEXT),
    args: config.args ?? [],
    env,
    cwd: config.cwd,
  });
}

// Namespaced tool name the model sees: mcp_<server>_<tool>, sanitized to what the provider APIs accept. The suffix
// that disambiguates a collision is budgeted inside the 64-character limit.
function qualifiedToolName(server: string, tool: string, taken: Set<string>): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const base = `mcp_${sanitize(server)}_${sanitize(tool)}`;
  for (let suffix = 1; ; suffix++) {
    const extra = suffix === 1 ? '' : `_${suffix}`;
    const name = base.slice(0, 64 - extra.length) + extra;
    if (!taken.has(name)) return name;
  }
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function toToolOutput(result: McpToolResult): ToolOutput {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const images = blocks.flatMap((block) =>
    block.type === 'image' && block.data && isSupportedImage(block.mimeType)
      ? [{ mediaType: block.mimeType as 'image/png', base64: block.data }]
      : [],
  );
  const skipped = [...new Set(blocks.map((block) => block.type))].filter((type) => type !== 'text' && type !== 'image');
  const note = skipped.length > 0 ? '\n(' + skipped.join(', ') + ' content was not forwarded)' : '';
  return { content: truncateOutput(text + note) || '(no output)', isError: result.isError || undefined, images };
}

function isSupportedImage(mimeType: unknown): mimeType is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/gif' || mimeType === 'image/webp';
}

async function closeClient(state: ServerState): Promise<void> {
  const client = state.client ?? state.connecting;
  const pid = client ? stdioPid(client) : undefined;
  // Cleared first, so the client's onclose sees a close the hub asked for and does not report the server as stopped.
  state.client = null;
  state.connecting = null;
  try {
    await client?.close();
  } catch {
    // A server that will not close cleanly is killed below; the process is going away anyway.
  }
  await killProcessTree(pid);
}

function stdioPid(client: Client): number | undefined {
  const transport = (client as unknown as { transport?: { pid?: number | null } }).transport;
  return typeof transport?.pid === 'number' ? transport.pid : undefined;
}

// close() kills the spawned process but not what it started. `npx` runs under cmd.exe on Windows, and killing that
// leaves the node grandchild running, so the whole tree goes.
// Asynchronous, so the main process keeps running meanwhile; stop() and quitting still wait for it.
async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) =>
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()),
      );
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
