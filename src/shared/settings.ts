import {
  DEFAULT_MODEL,
  DEFAULT_SUBAGENT_EFFORT,
  DEFAULT_SUBAGENT_MODEL,
  type Effort,
  type SubagentEffortChoice,
  type SubagentModelChoice,
} from './models';

export type Theme = 'dark' | 'light';

// 'ask': file edits and shell commands wait for approval. 'auto': the agent runs them directly.
export type ApprovalMode = 'ask' | 'auto';

// How run_command is confined. 'auto': bubblewrap on Linux or Seatbelt on macOS when available, otherwise no sandbox
// (and the approval card says so). 'container': always Docker or Podman, and the command does not run without one.
// 'off': never.
export type SandboxMode = 'off' | 'auto' | 'container';

// Network inside the sandbox. 'allow-list': only commands whose URLs are all on the allowed network hosts.
export type SandboxNetwork = 'off' | 'allow-list' | 'on';

// One Model Context Protocol server whose tools are offered to the agent. Stdio servers run as child processes of
// the app; HTTP servers are Streamable HTTP endpoints.
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  // Stdio: executable and arguments. cwd is the open project, set when connecting, not stored.
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // HTTP: endpoint URL.
  url?: string;
  headers?: Record<string, string>;
}

export interface McpStatus {
  name: string;
  state: 'connected' | 'connecting' | 'error' | 'disabled';
  error?: string;
  tools: string[];
}

// What the renderer sees of one server. `env` and `headers` carry secrets, so only their names leave the main process.
export interface McpServerView {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
}

// One rule of the permissions setting. The first rule that matches a tool call decides it; with no match the tool's
// own approval rules apply. `tool` and the `matches` values are globs (`*` any text, `?` one character), an array
// means "any of these". `matches` compares input fields of the call, e.g. {"command": "git push*"}.
export interface PermissionRule {
  tool: string | string[];
  matches?: Record<string, string | string[]>;
  // allow: run without asking. reject: never run (the model sees `message`). ask: always ask, even in Auto mode.
  // delegate: the program in `to` gets {tool,input,context} as JSON on stdin and prints allow, reject or ask.
  action: 'allow' | 'reject' | 'ask' | 'delegate';
  message?: string;
  to?: string;
  // Only calls made by the chat itself or only by its subagents.
  context?: 'thread' | 'subagent';
}

export interface Settings {
  model: string;
  // How much the model thinks before acting (current Claude models and OpenAI via the Responses API).
  effort: Effort;
  // task only. oracle stays on the chat model; finder stays on the small model.
  subagentModel: SubagentModelChoice;
  // match keeps the chat effort. scaled uses low for finder and medium for task; oracle keeps the chat effort.
  subagentEffort: SubagentEffortChoice;
  approvalMode: ApprovalMode;
  // Plan mode: the agent proposes a plan as an approval card before working through multi-step changes. The card is
  // shown even in Auto mode, so a plan is never treated as approved without the user seeing it.
  planMode: boolean;
  // While a Claude chat is idle, re-send its last request with max_tokens 0 about every 4 minutes, for up to an hour,
  // so the prompt cache does not expire between turns. Each keep-alive costs a cache read; off by default because
  // it sends requests the user did not start.
  keepCacheWarm: boolean;
  // Commands that run without approval in 'ask' mode, one per line; a line also allows the command with arguments
  // ("npm test" allows "npm test -- foo"). Commands with shell operators (; & | > < ` $() are never allowed this way.
  allowedCommands: string;
  // Exact http(s) URL hostnames that network tools may contact without asking, one per line.
  allowedNetworkHosts: string;
  sandboxMode: SandboxMode;
  sandboxNetwork: SandboxNetwork;
  // Image for the container sandbox; it must provide the tools the project's commands need.
  sandboxImage: string;
  theme: Theme;
  // Base URL for an OpenAI-compatible API. Empty means api.openai.com.
  openaiBaseUrl: string;
  // Base URL for Claude requests (a proxy or gateway serving the Anthropic Messages API). Empty means api.anthropic.com.
  // The Anthropic key is sent there, so setting or changing it asks for confirmation.
  anthropicBaseUrl: string;
  // Command used to open files from chat links, e.g. "code" or "cursor". The file path is appended.
  editorCommand: string;
  maxIndexedFiles: number;
  googleSearchEngineId: string;
  // Model Context Protocol servers. Their tools are offered to the agent with approval required, like file edits.
  mcpServers: McpServerConfig[];
  // Rules that allow, reject or force approval of tool calls (see PermissionRule). The first match wins.
  permissionRules: PermissionRule[];
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: 'high',
  subagentModel: DEFAULT_SUBAGENT_MODEL,
  subagentEffort: DEFAULT_SUBAGENT_EFFORT,
  approvalMode: 'ask',
  planMode: false,
  keepCacheWarm: false,
  allowedCommands: '',
  allowedNetworkHosts: '',
  sandboxMode: 'auto',
  sandboxNetwork: 'off',
  sandboxImage: 'node:lts',
  theme: 'dark',
  openaiBaseUrl: '',
  anthropicBaseUrl: '',
  editorCommand: 'code',
  maxIndexedFiles: 2000,
  googleSearchEngineId: '',
  mcpServers: [],
  permissionRules: [],
};

export type SecretName = 'anthropicApiKey' | 'openaiApiKey' | 'openrouterApiKey' | 'googleApiKey';

export const SECRET_NAMES: SecretName[] = ['anthropicApiKey', 'openaiApiKey', 'openrouterApiKey', 'googleApiKey'];

// Validates one entry of the MCP servers setting; returns an error message or null when it is usable.
function mcpServerError(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return 'every entry must be an object';
  const server = entry as Record<string, unknown>;
  if (typeof server.name !== 'string' || !server.name.trim()) return '"name" is required';
  if (server.transport !== 'stdio' && server.transport !== 'http') return '"transport" must be "stdio" or "http"';
  if (server.transport === 'stdio' && typeof server.command !== 'string') return 'stdio servers need a "command"';
  if (server.transport === 'http' && (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)))
    return 'http servers need an "url" starting with http(s)://';
  for (const key of ['args', 'headers', 'env'] as const) {
    const value = server[key];
    if (value === undefined) continue;
    if (key === 'args') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        return '"args" must be string arrays';
    } else if (typeof value !== 'object' || value === null) {
      return `"${key}" must be an object`;
    }
  }
  return null;
}

// Parses the JSON the settings dialog collects for MCP servers, throwing a readable error when unusable.
export function parseMcpServers(text: string): McpServerConfig[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`MCP servers must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) throw new Error('MCP servers must be a JSON array of server objects.');
  const names = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const problem = mcpServerError(entry);
    if (problem) throw new Error(`MCP servers: entry ${index + 1}: ${problem}`);
    const name = (entry as McpServerConfig).name;
    if (names.has(name)) throw new Error(`MCP servers: entry ${index + 1}: duplicate name "${name}"`);
    names.add(name);
  }
  return parsed as McpServerConfig[];
}

// Drops entries that cannot work (e.g. from a hand-edited settings file) instead of failing to start.
export function sanitizeMcpServers(servers: unknown): McpServerConfig[] {
  if (!Array.isArray(servers)) return [];
  return servers.filter((entry) => mcpServerError(entry) === null) as McpServerConfig[];
}

const globs = (value: unknown): boolean =>
  typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

function permissionRuleError(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'every entry must be an object';
  const rule = entry as Record<string, unknown>;
  if (!globs(rule.tool) || rule.tool === '' || (Array.isArray(rule.tool) && rule.tool.length === 0))
    return '"tool" must be a glob or a list of globs';
  if (!['allow', 'reject', 'ask', 'delegate'].includes(rule.action as string))
    return '"action" must be allow, reject, ask or delegate';
  if (rule.matches !== undefined) {
    const matches = rule.matches;
    if (typeof matches !== 'object' || matches === null || Array.isArray(matches))
      return '"matches" must be an object of globs';
    if (!Object.values(matches).every(globs)) return '"matches" values must be globs or lists of globs';
  }
  if (rule.action === 'delegate' && (typeof rule.to !== 'string' || !rule.to.trim()))
    return 'delegate rules need "to", the program to ask';
  if (rule.message !== undefined && typeof rule.message !== 'string') return '"message" must be text';
  if (rule.to !== undefined && typeof rule.to !== 'string') return '"to" must be text';
  if (rule.context !== undefined && rule.context !== 'thread' && rule.context !== 'subagent')
    return '"context" must be thread or subagent';
  return null;
}

// Parses the JSON the settings dialog collects for permission rules, throwing a readable error when unusable.
export function parsePermissionRules(text: string): PermissionRule[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Permission rules must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) throw new Error('Permission rules must be a JSON array of rule objects.');
  for (const [index, entry] of parsed.entries()) {
    const problem = permissionRuleError(entry);
    if (problem) throw new Error(`Permission rules: entry ${index + 1}: ${problem}`);
  }
  return parsed as PermissionRule[];
}

// Drops rules that cannot work (e.g. from a hand-edited settings file) instead of failing to start.
export function sanitizePermissionRules(rules: unknown): PermissionRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.filter((entry) => permissionRuleError(entry) === null) as PermissionRule[];
}

// What the renderer sees of a ChatGPT sign-in. Tokens stay in the main process.
export interface ChatGptAccountView {
  signedIn: boolean;
  // Email from the ChatGPT id token, when the login response included one.
  accountLabel: string | null;
}

// What the renderer sees. Secrets never leave the main process; the UI only learns whether each one is set.
export interface SettingsView extends Omit<Settings, 'mcpServers'> {
  mcpServers: McpServerView[];
  secrets: Record<SecretName, boolean>;
  secretsEncrypted: boolean;
  chatgpt: ChatGptAccountView;
}

// Official OpenAI chats (no custom base URL) can use a ChatGPT session or an API key. A custom base URL always
// needs the API key; the ChatGPT session is not sent there.
export function openaiCredentialMissing(view: Pick<SettingsView, 'openaiBaseUrl' | 'secrets' | 'chatgpt'>): boolean {
  if (view.openaiBaseUrl.trim()) return !view.secrets.openaiApiKey;
  return !view.secrets.openaiApiKey && !view.chatgpt.signedIn;
}

// Why a base URL setting cannot be used, or null when it is empty (the official API) or an http(s) URL.
export function baseUrlError(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  } catch {
    // Not a URL at all.
  }
  return `${label} must be an http:// or https:// URL.`;
}
