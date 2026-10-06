import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type McpServerConfig, type Settings } from '@shared/settings';
import type { ProjectInfo } from '@shared/project';
import { addedEntries, changesToConfirm, projectChangesToConfirm } from './settings_confirm';

const docs: McpServerConfig = { name: 'docs', transport: 'stdio', command: 'node', args: ['docs.js'] };
const current: Settings = { ...DEFAULT_SETTINGS, mcpServers: [docs] };

describe('changesToConfirm', () => {
  it('asks before sending OpenAI requests and the OpenAI key to another host, not when going back', () => {
    expect(changesToConfirm(current, { openaiBaseUrl: 'https://proxy.example/v1' }, false)).toEqual([
      'Send OpenAI requests and your OpenAI API key to https://proxy.example/v1.',
    ]);
    const custom = { ...current, openaiBaseUrl: 'https://proxy.example/v1' };
    expect(changesToConfirm(custom, { openaiBaseUrl: 'https://proxy.example/v1' }, false)).toEqual([]);
    expect(changesToConfirm(custom, { openaiBaseUrl: '' }, false)).toEqual([]);
  });

  it('asks only about allow-list entries that are new, never about removed or reordered ones', () => {
    const lists = { ...current, allowedCommands: 'npm test\nnpm run lint', allowedNetworkHosts: 'example.com' };
    expect(
      changesToConfirm(lists, { allowedCommands: 'npm run lint\nnpm test\ngit push', allowedNetworkHosts: '' }, false),
    ).toEqual(['Run these commands without asking: "git push".']);
    expect(changesToConfirm(lists, { allowedNetworkHosts: 'example.com\nevil.example\n' }, false)).toEqual([
      'Let network tools contact these hosts without asking: "evil.example".',
    ]);
    // The dialog sends every setting on save: unchanged lists ask nothing.
    expect(changesToConfirm(lists, { ...lists }, false)).toEqual([]);
  });

  it('asks only for new native sandbox environment grants', () => {
    const configured = { ...current, sandboxEnvAllowList: 'CC\nJAVA_TOOL_OPTIONS' };
    expect(
      changesToConfirm(configured, { sandboxEnvAllowList: ' JAVA_TOOL_OPTIONS \nCC\nPRIVATE_BUILD_VALUE' }, false),
    ).toEqual([
      'Expose these host environment variables to native sandbox commands; their values may contain secrets and appear in model output: "PRIVATE_BUILD_VALUE".',
    ]);
    expect(changesToConfirm(configured, { sandboxEnvAllowList: ' CC \nJAVA_TOOL_OPTIONS\n' }, false)).toEqual([]);
    expect(changesToConfirm(configured, { sandboxEnvAllowList: 'CC' }, false)).toEqual([]);
    expect(changesToConfirm(configured, { sandboxEnvAllowList: '' }, false)).toEqual([]);
  });

  it('asks for a changed nonempty native sandbox PATH, not removal, no-op or whitespace', () => {
    const configured = { ...current, sandboxPath: '/trusted/bin' };
    expect(changesToConfirm(current, { sandboxPath: '/trusted/bin' }, false)).toEqual([
      'Use "/trusted/bin" as PATH for native sandbox commands.',
    ]);
    expect(changesToConfirm(configured, { sandboxPath: '/other/bin' }, false)).toEqual([
      'Use "/other/bin" as PATH for native sandbox commands.',
    ]);
    expect(changesToConfirm(configured, { sandboxPath: ' /trusted/bin ' }, false)).toEqual([]);
    expect(changesToConfirm(configured, { sandboxPath: '' }, false)).toEqual([]);
  });

  it("asks about a project's own new allow-list entries, naming the project", () => {
    const project: ProjectInfo = {
      path: '/p',
      name: 'demo',
      instructions: '',
      allowedCommands: 'npm test',
      allowedNetworkHosts: '',
      lastOpened: '',
    };
    expect(
      projectChangesToConfirm(project, {
        instructions: 'x',
        allowedCommands: 'npm test\nmake',
        allowedNetworkHosts: 'api.example',
      }),
    ).toEqual([
      'In demo, run these commands without asking: "make".',
      'In demo, let network tools contact these hosts without asking: "api.example".',
    ]);
    expect(
      projectChangesToConfirm(project, {
        instructions: 'changed',
        allowedCommands: 'npm test',
        allowedNetworkHosts: '',
      }),
    ).toEqual([]);
  });

  it('lists added entries once, trimmed, and shortens a long list', () => {
    expect(addedEntries('a\r\nb', ' c \nb\nc\n\n')).toEqual(['c']);
    const many = Array.from({ length: 12 }, (_, i) => `cmd${i}`).join('\n');
    expect(changesToConfirm(current, { allowedCommands: many }, false)[0]).toMatch(/"cmd7" and 4 more\.$/);
  });

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

  // #110: headers are stored by server name and kept when a save leaves them out or empty.
  describe('saved MCP HTTP headers', () => {
    const api: McpServerConfig = { name: 'api', transport: 'http', url: 'https://mcp.example/v1' };
    const withApi: Settings = { ...current, mcpServers: [docs, api] };
    const stored = { api: ['Authorization'] };

    it('asks before a changed URL sends the saved headers to another host', () => {
      const moved = { ...api, url: 'https://evil.example/mcp' };
      expect(changesToConfirm(withApi, { mcpServers: [docs, moved] }, false, stored)).toEqual([
        'Send the saved headers Authorization of MCP server "api" to https://evil.example/mcp.',
      ]);
      // An empty value in the dialog keeps the stored header too.
      expect(
        changesToConfirm(withApi, { mcpServers: [docs, { ...moved, headers: { Authorization: '' } }] }, false, stored),
      ).toHaveLength(1);
    });

    it('asks when a stdio server under the same name becomes an HTTP server that keeps stored headers', () => {
      const stdioApi: McpServerConfig = { name: 'api', transport: 'stdio', command: 'node' };
      expect(
        changesToConfirm({ ...current, mcpServers: [stdioApi] }, { mcpServers: [api] }, false, stored),
      ).toHaveLength(1);
    });

    it('does not ask for the same URL, a typed replacement, or a server without stored headers', () => {
      expect(
        changesToConfirm(withApi, { mcpServers: [docs, { ...api, url: ' https://mcp.example/v1 ' }] }, false, stored),
      ).toEqual([]);
      const typed = { ...api, url: 'https://new.example/mcp', headers: { Authorization: 'Bearer typed-now' } };
      expect(changesToConfirm(withApi, { mcpServers: [docs, typed] }, false, stored)).toEqual([]);
      expect(
        changesToConfirm(withApi, { mcpServers: [docs, { ...api, url: 'https://new.example' }] }, false, {}),
      ).toEqual([]);
      expect(changesToConfirm(current, { mcpServers: [docs, api] }, false, {})).toEqual([]);
    });
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
