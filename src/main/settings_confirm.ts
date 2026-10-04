import type { ProjectInfo, ProjectSettings } from '@shared/project';
import type { McpServerConfig, Settings } from '@shared/settings';

// Settings changes that let the app run programs, let the agent act without asking, or send an API key to another
// host. The main process asks the user with a native dialog before applying them, so a compromised renderer cannot
// apply them silently. (It could still type into the terminal panel, a real shell, so keeping the renderer itself
// safe - DOMPurify, the CSP and Trusted Types - is the main control; this keeps a settings-only exploit from being
// enough.)
// Returns one line per change, or nothing when the patch needs no confirmation.
export function changesToConfirm(current: Settings, patch: Partial<Settings>, autoConfirmed: boolean): string[] {
  const changes: string[] = [];

  if (patch.approvalMode === 'auto' && current.approvalMode !== 'auto' && !autoConfirmed) {
    changes.push('Switch to Auto mode: file edits and commands run without asking.');
  }

  if (typeof patch.editorCommand === 'string' && editor(patch.editorCommand) !== editor(current.editorCommand)) {
    changes.push(`Open files with the editor command "${editor(patch.editorCommand)}".`);
  }

  if (Array.isArray(patch.mcpServers)) {
    for (const server of patch.mcpServers) {
      if (server.transport !== 'stdio') continue;
      const before = current.mcpServers.find((candidate) => candidate.name === server.name);
      const what = stdioChange(before, server);
      if (what) changes.push(`${what} MCP server "${server.name}": ${commandLine(server)}`);
    }
  }

  // The OpenAI API key goes to this host. Going back to the official API (empty) needs no confirmation.
  if (typeof patch.openaiBaseUrl === 'string') {
    const next = patch.openaiBaseUrl.trim();
    if (next && next !== current.openaiBaseUrl.trim()) {
      changes.push(`Send OpenAI requests and your OpenAI API key to ${next}.`);
    }
  }

  // Allow-list entries let the agent run a command or contact a host without asking; only new ones are confirmed.
  if (typeof patch.allowedCommands === 'string') {
    const added = addedEntries(current.allowedCommands, patch.allowedCommands);
    if (added.length > 0) changes.push(`Run these commands without asking: ${list(added)}`);
  }
  if (typeof patch.allowedNetworkHosts === 'string') {
    const added = addedEntries(current.allowedNetworkHosts, patch.allowedNetworkHosts);
    if (added.length > 0) changes.push(`Let network tools contact these hosts without asking: ${list(added)}`);
  }

  // The Anthropic key goes to this host. Going back to the official API (empty) needs no confirmation.
  if (typeof patch.anthropicBaseUrl === 'string') {
    const next = patch.anthropicBaseUrl.trim();
    if (next && next !== current.anthropicBaseUrl.trim()) {
      changes.push(`Send Claude requests and your Anthropic API key to ${next}.`);
    }
  }

  // Rules that let tool calls run without asking, or hand the decision to a program, are as sensitive as Auto mode.
  if (Array.isArray(patch.permissionRules)) {
    const known = new Set(current.permissionRules.map((rule) => JSON.stringify(rule)));
    for (const rule of patch.permissionRules) {
      if (rule.action !== 'allow' && rule.action !== 'delegate') continue;
      if (known.has(JSON.stringify(rule))) continue;
      const tools = [rule.tool].flat().join(', ');
      changes.push(
        rule.action === 'allow'
          ? `Allow ${tools} without asking (permission rule).`
          : `Let the program "${rule.to}" decide calls to ${tools} (permission rule).`,
      );
    }
  }
  return changes;
}

// The same check for a project's own allow-lists (Project settings), which add to the global ones.
export function projectChangesToConfirm(current: ProjectInfo | null, patch: ProjectSettings): string[] {
  const name = current?.name ?? 'this project';
  const changes: string[] = [];
  const commands = addedEntries(current?.allowedCommands ?? '', patch.allowedCommands);
  if (commands.length > 0) changes.push(`In ${name}, run these commands without asking: ${list(commands)}`);
  const hosts = addedEntries(current?.allowedNetworkHosts ?? '', patch.allowedNetworkHosts);
  if (hosts.length > 0)
    changes.push(`In ${name}, let network tools contact these hosts without asking: ${list(hosts)}`);
  return changes;
}

// Lines of `after` (one entry per line, as the allow-lists are written) that `before` does not have.
export function addedEntries(before: string, after: string): string[] {
  const entries = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const known = new Set(entries(before));
  return [...new Set(entries(after))].filter((entry) => !known.has(entry));
}

// A short list for the dialog: the first entries, then how many more.
function list(entries: string[]): string {
  const shown = entries.slice(0, 8).map((entry) => `"${entry}"`);
  const more = entries.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

// The command that actually runs, as `openInEditor` uses it.
function editor(command: string): string {
  return command.trim() || 'code';
}

// What changed about a stdio server that would start a different program, or the same one differently.
function stdioChange(before: McpServerConfig | undefined, server: McpServerConfig): string | null {
  if (!before || before.transport !== 'stdio') return 'Start the new';
  const same =
    before.command === server.command &&
    JSON.stringify(before.args ?? []) === JSON.stringify(server.args ?? []) &&
    (before.cwd ?? '') === (server.cwd ?? '');
  if (!same) return 'Start the changed';
  // An empty value keeps the stored one, so only a typed value changes the environment (e.g. NODE_OPTIONS).
  const newEnv = Object.entries(server.env ?? {}).filter(([, value]) => value);
  if (newEnv.length > 0) return `Set ${newEnv.map(([key]) => key).join(', ')} for the`;
  return null;
}

function commandLine(server: McpServerConfig): string {
  return [server.command ?? '', ...(server.args ?? [])].join(' ');
}
