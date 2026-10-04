import type { McpServerConfig, Settings } from '@shared/settings';

// Settings changes that let the app run programs, or let the agent act without asking. The main process asks the
// user with a native dialog before applying them, so a compromised renderer cannot apply them silently.
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
