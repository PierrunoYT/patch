import type { ProjectInfo, ProjectSettings } from '@shared/project';
import type { McpServerConfig, SecretName, Settings } from '@shared/settings';
import { delegateLabel } from './agent/permissions';

// Settings changes that let the app run programs, let the agent act without asking, or send an API key to another
// host. The main process asks the user with a native dialog before applying them, so a compromised renderer cannot
// apply them silently. (It could still type into the terminal panel, a real shell, so keeping the renderer itself
// safe - DOMPurify, the CSP and Trusted Types - is the main control; this keeps a settings-only exploit from being
// enough.)
// Saving a key while the system cannot encrypt it writes it to settings.json as plain text (#35). Removing a key, or
// saving one that can be encrypted, needs no confirmation.
export function secretToConfirm(name: SecretName, value: string, canEncrypt: boolean): string[] {
  if (canEncrypt || !value.trim()) return [];
  return [
    `Save the ${SECRET_LABELS[name]} unencrypted: this system cannot encrypt it, so it is stored as plain text in settings.json, readable by anyone who can read your profile folder.`,
  ];
}

const SECRET_LABELS: Record<SecretName, string> = {
  anthropicApiKey: 'Anthropic API key',
  openaiApiKey: 'OpenAI API key',
  openrouterApiKey: 'OpenRouter API key',
  googleApiKey: 'Google API key',
};

// Returns one line per change, or nothing when the patch needs no confirmation. `storedHeaders` names the encrypted
// HTTP headers kept per MCP server (SettingsStore.mcpHeaderNames), which a changed URL would send to another host.
// `resolveProgram` gives the absolute path a stdio server's command runs (null when it isn't found), so the dialog
// names the actual program.
export function changesToConfirm(
  current: Settings,
  patch: Partial<Settings>,
  storedHeaders: Record<string, string[]> = {},
  resolveProgram: (command: string) => string | null = (command) => command,
): string[] {
  const changes: string[] = [];

  // Every time, not once per session: a script in the renderer could otherwise turn it back on silently (#157).
  if (patch.approvalMode === 'auto' && current.approvalMode !== 'auto') {
    changes.push('Switch to Auto mode: file edits and commands run without asking.');
  }

  if (patch.sandboxMode === 'off' && current.sandboxMode !== 'off') {
    changes.push('Turn the command sandbox off: commands run with your full rights.');
  }
  if (patch.sandboxNetwork === 'on' && current.sandboxNetwork !== 'on') {
    changes.push(
      'Give sandboxed commands full network access, including local network services such as databases and dev servers (on macOS, not local Unix sockets; on Linux, also abstract Unix sockets such as the X11 display).',
    );
  }
  if (typeof patch.sandboxImage === 'string' && patch.sandboxImage.trim() !== current.sandboxImage.trim()) {
    changes.push(`Run container-sandboxed commands in the image "${patch.sandboxImage.trim()}".`);
  }
  if (typeof patch.sandboxEnvAllowList === 'string') {
    const added = addedEntries(current.sandboxEnvAllowList, patch.sandboxEnvAllowList);
    if (added.length > 0) {
      changes.push(
        `Expose these host environment variables to native sandbox commands; their values may contain secrets and appear in model output: ${list(added)}`,
      );
    }
  }
  if (typeof patch.sandboxPath === 'string') {
    const next = patch.sandboxPath.trim();
    if (next && next !== current.sandboxPath.trim()) {
      changes.push(`Use "${next}" as PATH for native sandbox commands.`);
    }
  }

  if (typeof patch.editorCommand === 'string' && editor(patch.editorCommand) !== editor(current.editorCommand)) {
    changes.push(`Open files with the editor command "${editor(patch.editorCommand)}".`);
  }

  if (Array.isArray(patch.mcpServers)) {
    for (const server of patch.mcpServers) {
      const before = current.mcpServers.find((candidate) => candidate.name === server.name);
      if (server.transport !== 'stdio') {
        // Headers are stored by server name and kept when the dialog leaves them out or empty, so a new URL under an
        // existing name would send a saved Authorization header to that host (#110).
        const kept = keptHeaders(storedHeaders[server.name] ?? [], server.headers);
        const sameHost = before?.transport === 'http' && (before.url ?? '').trim() === (server.url ?? '').trim();
        if (kept.length > 0 && !sameHost) {
          changes.push(`Send the saved headers ${kept.join(', ')} of MCP server "${server.name}" to ${server.url}.`);
        }
        continue;
      }
      const what = stdioChange(before, server);
      if (what) {
        const command = server.command ?? '';
        const program = resolveProgram(command);
        const runs = program === null ? ' (not found on PATH)' : program !== command ? ` (runs ${program})` : '';
        const boundary = server.sandbox ? (server.sandboxNetwork ? ' (sandboxed, with network)' : ' (sandboxed)') : '';
        changes.push(`${what} MCP server "${server.name}": ${commandLine(server)}${runs}${boundary}`);
      }
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
          : `Let the program "${delegateLabel(rule.to ?? '')}" decide calls to ${tools} (permission rule).`,
      );
    }
    // First match wins: changing any part of the prefix through an ask/reject rule can bypass its protection,
    // including reordering existing allow rules while leaving the protective rule itself at the same index. A delegate
    // rule protects too: its program may answer ask or reject, and in Auto mode it can be the only check (#251).
    let prefixUnchanged = true;
    for (const [index, rule] of current.permissionRules.entries()) {
      prefixUnchanged &&= JSON.stringify(rule) === JSON.stringify(patch.permissionRules[index]);
      if (prefixUnchanged || rule.action === 'allow') continue;
      const tools = [rule.tool].flat().join(', ');
      const matches = rule.matches ? ` matching ${JSON.stringify(rule.matches)}` : '';
      changes.push(
        rule.action === 'delegate'
          ? `Change the rule that lets the program "${delegateLabel(rule.to ?? '')}" decide calls to ${tools}${matches}, or its preceding rules (permission rule).`
          : `Change the ${rule.action} protection for ${tools}${matches} or its preceding rules (permission rule).`,
      );
    }
  }
  return changes;
}

// The same check for a project's own allow-lists (Project settings), which add to the global ones, and for its
// instructions, which go into every chat's system prompt (#157). Removing instructions needs no confirmation.
export function projectChangesToConfirm(current: ProjectInfo | null, patch: ProjectSettings): string[] {
  const name = current?.name ?? 'this project';
  const changes: string[] = [];
  const instructions = patch.instructions.trim();
  if (instructions && instructions !== (current?.instructions ?? '').trim()) {
    const shown = instructions.length > MAX_SHOWN_INSTRUCTIONS;
    changes.push(
      `In ${name}, give the agent these instructions in every chat: "${instructions.slice(0, MAX_SHOWN_INSTRUCTIONS)}${shown ? '…' : ''}"${shown ? ` (${instructions.length} characters in all)` : ''}`,
    );
  }
  const commands = addedEntries(current?.allowedCommands ?? '', patch.allowedCommands);
  if (commands.length > 0) changes.push(`In ${name}, run these commands without asking: ${list(commands)}`);
  const hosts = addedEntries(current?.allowedNetworkHosts ?? '', patch.allowedNetworkHosts);
  if (hosts.length > 0)
    changes.push(`In ${name}, let network tools contact these hosts without asking: ${list(hosts)}`);
  return changes;
}

const MAX_SHOWN_INSTRUCTIONS = 600;

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
  // Leaving the sandbox, or getting network inside it, gives the same program more rights (#87).
  if (before.sandbox && !server.sandbox) return 'Run without the sandbox the';
  if (server.sandbox && server.sandboxNetwork && !before.sandboxNetwork) return 'Give network access to the sandboxed';
  // An empty value keeps the stored one, so only a typed value changes the environment (e.g. NODE_OPTIONS).
  const newEnv = Object.entries(server.env ?? {}).filter(([, value]) => value);
  if (newEnv.length > 0) return `Set ${newEnv.map(([key]) => key).join(', ')} for the`;
  return null;
}

// Stored header names that survive the save: all of them when the patch leaves headers out, otherwise those it lists
// with an empty value (a typed value replaces the stored one, and the renderer already knows what it typed).
function keptHeaders(stored: string[], incoming: Record<string, string> | undefined): string[] {
  if (!incoming) return stored;
  return stored.filter((name) => name in incoming && !incoming[name]);
}

function commandLine(server: McpServerConfig): string {
  return [server.command ?? '', ...(server.args ?? [])].join(' ');
}
