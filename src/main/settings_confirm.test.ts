import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type McpServerConfig, type Settings } from '@shared/settings';
import { changesToConfirm } from './settings_confirm';

const docs: McpServerConfig = { name: 'docs', transport: 'stdio', command: 'node', args: ['docs.js'] };
const current: Settings = { ...DEFAULT_SETTINGS, mcpServers: [docs] };

describe('changesToConfirm', () => {
  it('asks before sending Claude requests and the Anthropic key to another host, not when going back', () => {
    expect(changesToConfirm(current, { anthropicBaseUrl: 'https://gateway.example' }, false)).toEqual([
      'Send Claude requests and your Anthropic API key to https://gateway.example.',
    ]);
    const custom = { ...current, anthropicBaseUrl: 'https://gateway.example' };
    expect(changesToConfirm(custom, { anthropicBaseUrl: ' https://gateway.example ' }, false)).toEqual([]);
    expect(changesToConfirm(custom, { anthropicBaseUrl: 'https://other.example' }, false)).toHaveLength(1);
    expect(changesToConfirm(custom, { anthropicBaseUrl: '' }, false)).toEqual([]);
  });

  it('needs no confirmation for ordinary settings or an unchanged full save', () => {
    expect(changesToConfirm(current, { theme: 'light', model: 'x', approvalMode: 'ask' }, false)).toEqual([]);
    // The settings dialog sends every setting on save; values equal to the current ones ask nothing.
    expect(changesToConfirm(current, { ...current, mcpServers: [{ ...docs, env: { TOKEN: '' } }] }, false)).toEqual([]);
  });

  it('asks before switching to Auto mode, once per session, and never when switching back', () => {
    expect(changesToConfirm(current, { approvalMode: 'auto' }, false)).toEqual([
      'Switch to Auto mode: file edits and commands run without asking.',
    ]);
    expect(changesToConfirm(current, { approvalMode: 'auto' }, true)).toEqual([]);
    expect(changesToConfirm({ ...current, approvalMode: 'auto' }, { approvalMode: 'ask' }, false)).toEqual([]);
    expect(changesToConfirm({ ...current, approvalMode: 'auto' }, { approvalMode: 'auto' }, false)).toEqual([]);
  });

  it('asks before changing the editor command, treating empty as the default', () => {
    expect(changesToConfirm(current, { editorCommand: 'calc' }, false)).toEqual([
      'Open files with the editor command "calc".',
    ]);
    expect(changesToConfirm(current, { editorCommand: '  ' }, false)).toEqual([]);
    expect(changesToConfirm(current, { editorCommand: ' code ' }, false)).toEqual([]);
  });

  it('asks before starting a new or changed stdio MCP server', () => {
    const added: McpServerConfig = { name: 'evil', transport: 'stdio', command: 'cmd', args: ['/c', 'calc'] };
    expect(changesToConfirm(current, { mcpServers: [docs, added] }, false)).toEqual([
      'Start the new MCP server "evil": cmd /c calc',
    ]);
    expect(changesToConfirm(current, { mcpServers: [{ ...docs, args: ['other.js'] }] }, false)).toEqual([
      'Start the changed MCP server "docs": node other.js',
    ]);
    expect(changesToConfirm(current, { mcpServers: [{ ...docs, command: 'python' }] }, false)).toHaveLength(1);
    expect(changesToConfirm(current, { mcpServers: [{ ...docs, cwd: 'C:\\temp' }] }, false)).toHaveLength(1);
    // Same name, but it used to be an http server.
    const http: Settings = { ...current, mcpServers: [{ name: 'docs', transport: 'http', url: 'https://x.test' }] };
    expect(changesToConfirm(http, { mcpServers: [docs] }, false)).toEqual([
      'Start the new MCP server "docs": node docs.js',
    ]);
  });

  it('asks before setting environment variables for a stdio server, naming the keys only', () => {
    const changes = changesToConfirm(
      current,
      { mcpServers: [{ ...docs, env: { NODE_OPTIONS: '--require ./x.js', KEPT: '' } }] },
      false,
    );
    expect(changes).toEqual(['Set NODE_OPTIONS for the MCP server "docs": node docs.js']);
    expect(changes.join(' ')).not.toContain('--require');
  });

  it('does not ask for http servers or for removing a server', () => {
    const http: McpServerConfig = { name: 'web', transport: 'http', url: 'https://mcp.test/', headers: { A: 'b' } };
    expect(changesToConfirm(current, { mcpServers: [docs, http] }, false)).toEqual([]);
    expect(changesToConfirm(current, { mcpServers: [] }, false)).toEqual([]);
  });

  it('asks before adding a rule that allows calls or delegates them, not for other rules', () => {
    const allow = { tool: 'run_command', action: 'allow' as const };
    const delegate = { tool: ['fetch_url'], action: 'delegate' as const, to: 'check' };
    const reject = { tool: 'run_command', action: 'reject' as const };
    expect(changesToConfirm(current, { permissionRules: [reject, { tool: '*', action: 'ask' }] }, false)).toEqual([]);
    expect(changesToConfirm(current, { permissionRules: [allow, delegate] }, false)).toEqual([
      'Allow run_command without asking (permission rule).',
      'Let the program "check" decide calls to fetch_url (permission rule).',
    ]);
    const withAllow: Settings = { ...current, permissionRules: [allow] };
    expect(changesToConfirm(withAllow, { permissionRules: [allow] }, false)).toEqual([]);
  });

  it('lists every change in one confirmation', () => {
    expect(changesToConfirm(current, { approvalMode: 'auto', editorCommand: 'vim' }, false)).toHaveLength(2);
  });
});
