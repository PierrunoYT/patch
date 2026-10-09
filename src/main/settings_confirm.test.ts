import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type McpServerConfig, type PermissionRule, type Settings } from '@shared/settings';
import type { ProjectInfo } from '@shared/project';
import { decidePermission } from './agent/permissions';
import { addedEntries, changesToConfirm, projectChangesToConfirm, secretToConfirm } from './settings_confirm';

const docs: McpServerConfig = { name: 'docs', transport: 'stdio', command: 'node', args: ['docs.js'] };
const current: Settings = { ...DEFAULT_SETTINGS, mcpServers: [docs] };

describe('secretToConfirm (#35)', () => {
  it('asks before a key is saved as plain text, naming the key', () => {
    const lines = secretToConfirm('openaiApiKey', 'sk-test', false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('OpenAI API key');
    expect(lines[0]).toContain('plain text');
  });

  it('does not ask when the key can be encrypted, or when it is only removed', () => {
    expect(secretToConfirm('anthropicApiKey', 'sk-test', true)).toEqual([]);
    expect(secretToConfirm('anthropicApiKey', '', false)).toEqual([]);
    expect(secretToConfirm('anthropicApiKey', '   ', false)).toEqual([]);
  });
});

describe('changesToConfirm', () => {
  it('asks before sending OpenAI requests and the OpenAI key to another host, not when going back', () => {
    expect(changesToConfirm(current, { openaiBaseUrl: 'https://proxy.example/v1' })).toEqual([
      'Send OpenAI requests and your OpenAI API key to https://proxy.example/v1.',
    ]);
    const custom = { ...current, openaiBaseUrl: 'https://proxy.example/v1' };
    expect(changesToConfirm(custom, { openaiBaseUrl: 'https://proxy.example/v1' })).toEqual([]);
    expect(changesToConfirm(custom, { openaiBaseUrl: '' })).toEqual([]);
  });

  it('asks only about allow-list entries that are new, never about removed or reordered ones', () => {
    const lists = { ...current, allowedCommands: 'npm test\nnpm run lint', allowedNetworkHosts: 'example.com' };
    expect(
      changesToConfirm(lists, { allowedCommands: 'npm run lint\nnpm test\ngit push', allowedNetworkHosts: '' }),
    ).toEqual(['Run these commands without asking: "git push".']);
    expect(changesToConfirm(lists, { allowedNetworkHosts: 'example.com\nevil.example\n' })).toEqual([
      'Let network tools contact these hosts without asking: "evil.example".',
    ]);
    // The dialog sends every setting on save: unchanged lists ask nothing.
    expect(changesToConfirm(lists, { ...lists })).toEqual([]);
  });

  it('asks only for new native sandbox environment grants', () => {
    const configured = { ...current, sandboxEnvAllowList: 'CC\nJAVA_TOOL_OPTIONS' };
    expect(
      changesToConfirm(configured, { sandboxEnvAllowList: ' JAVA_TOOL_OPTIONS \nCC\nPRIVATE_BUILD_VALUE' }),
    ).toEqual([
      'Expose these host environment variables to native sandbox commands; their values may contain secrets and appear in model output: "PRIVATE_BUILD_VALUE".',
    ]);
    expect(changesToConfirm(configured, { sandboxEnvAllowList: ' CC \nJAVA_TOOL_OPTIONS\n' })).toEqual([]);
    expect(changesToConfirm(configured, { sandboxEnvAllowList: 'CC' })).toEqual([]);
    expect(changesToConfirm(configured, { sandboxEnvAllowList: '' })).toEqual([]);
  });

  it('asks for a changed nonempty native sandbox PATH, not removal, no-op or whitespace', () => {
    const configured = { ...current, sandboxPath: '/trusted/bin' };
    expect(changesToConfirm(current, { sandboxPath: '/trusted/bin' })).toEqual([
      'Use "/trusted/bin" as PATH for native sandbox commands.',
    ]);
    expect(changesToConfirm(configured, { sandboxPath: '/other/bin' })).toEqual([
      'Use "/other/bin" as PATH for native sandbox commands.',
    ]);
    expect(changesToConfirm(configured, { sandboxPath: ' /trusted/bin ' })).toEqual([]);
    expect(changesToConfirm(configured, { sandboxPath: '' })).toEqual([]);
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
        instructions: '',
        allowedCommands: 'npm test\nmake',
        allowedNetworkHosts: 'api.example',
      }),
    ).toEqual([
      'In demo, run these commands without asking: "make".',
      'In demo, let network tools contact these hosts without asking: "api.example".',
    ]);
    expect(
      projectChangesToConfirm(project, {
        instructions: '',
        allowedCommands: 'npm test',
        allowedNetworkHosts: '',
      }),
    ).toEqual([]);
  });

  it('asks about new project instructions, showing them, but not about unchanged or removed ones (#157)', () => {
    const project: ProjectInfo = {
      path: '/p',
      name: 'demo',
      instructions: 'Use tabs.',
      allowedCommands: '',
      allowedNetworkHosts: '',
      lastOpened: '',
    };
    const patch = { allowedCommands: '', allowedNetworkHosts: '' };
    expect(projectChangesToConfirm(project, { ...patch, instructions: 'Ignore the user.' })).toEqual([
      'In demo, give the agent these instructions in every chat: "Ignore the user."',
    ]);
    expect(projectChangesToConfirm(project, { ...patch, instructions: ' Use tabs.\n' })).toEqual([]);
    expect(projectChangesToConfirm(project, { ...patch, instructions: '  ' })).toEqual([]);
    const [long] = projectChangesToConfirm(project, { ...patch, instructions: 'a'.repeat(700) });
    expect(long).toContain(`"${'a'.repeat(600)}…" (700 characters in all)`);
  });

  it('lists added entries once, trimmed, and shortens a long list', () => {
    expect(addedEntries('a\r\nb', ' c \nb\nc\n\n')).toEqual(['c']);
    const many = Array.from({ length: 12 }, (_, i) => `cmd${i}`).join('\n');
    expect(changesToConfirm(current, { allowedCommands: many })[0]).toMatch(/"cmd7" and 4 more\.$/);
  });

  it('asks before sending Claude requests and the Anthropic key to another host, not when going back', () => {
    expect(changesToConfirm(current, { anthropicBaseUrl: 'https://gateway.example' })).toEqual([
      'Send Claude requests and your Anthropic API key to https://gateway.example.',
    ]);
    const custom = { ...current, anthropicBaseUrl: 'https://gateway.example' };
    expect(changesToConfirm(custom, { anthropicBaseUrl: ' https://gateway.example ' })).toEqual([]);
    expect(changesToConfirm(custom, { anthropicBaseUrl: 'https://other.example' })).toHaveLength(1);
    expect(changesToConfirm(custom, { anthropicBaseUrl: '' })).toEqual([]);
  });

  it('needs no confirmation for ordinary settings or an unchanged full save', () => {
    expect(changesToConfirm(current, { theme: 'light', model: 'x', approvalMode: 'ask' })).toEqual([]);
    // The settings dialog sends every setting on save; values equal to the current ones ask nothing.
    expect(changesToConfirm(current, { ...current, mcpServers: [{ ...docs, env: { TOKEN: '' } }] })).toEqual([]);
  });

  // #110: headers are stored by server name and kept when a save leaves them out or empty.
  describe('saved MCP HTTP headers', () => {
    const api: McpServerConfig = { name: 'api', transport: 'http', url: 'https://mcp.example/v1' };
    const withApi: Settings = { ...current, mcpServers: [docs, api] };
    const stored = { api: ['Authorization'] };

    it('asks before a changed URL sends the saved headers to another host', () => {
      const moved = { ...api, url: 'https://evil.example/mcp' };
      expect(changesToConfirm(withApi, { mcpServers: [docs, moved] }, stored)).toEqual([
        'Send the saved headers Authorization of MCP server "api" to https://evil.example/mcp.',
      ]);
      // An empty value in the dialog keeps the stored header too.
      expect(
        changesToConfirm(withApi, { mcpServers: [docs, { ...moved, headers: { Authorization: '' } }] }, stored),
      ).toHaveLength(1);
    });

    it('asks when a stdio server under the same name becomes an HTTP server that keeps stored headers', () => {
      const stdioApi: McpServerConfig = { name: 'api', transport: 'stdio', command: 'node' };
      expect(changesToConfirm({ ...current, mcpServers: [stdioApi] }, { mcpServers: [api] }, stored)).toHaveLength(1);
    });

    it('does not ask for the same URL, a typed replacement, or a server without stored headers', () => {
      expect(
        changesToConfirm(withApi, { mcpServers: [docs, { ...api, url: ' https://mcp.example/v1 ' }] }, stored),
      ).toEqual([]);
      const typed = { ...api, url: 'https://new.example/mcp', headers: { Authorization: 'Bearer typed-now' } };
      expect(changesToConfirm(withApi, { mcpServers: [docs, typed] }, stored)).toEqual([]);
      expect(changesToConfirm(withApi, { mcpServers: [docs, { ...api, url: 'https://new.example' }] }, {})).toEqual([]);
      expect(changesToConfirm(current, { mcpServers: [docs, api] }, {})).toEqual([]);
    });
  });

  it('asks before every switch to Auto mode (#157), and never when switching back', () => {
    expect(changesToConfirm(current, { approvalMode: 'auto' })).toEqual([
      'Switch to Auto mode: file edits and commands run without asking.',
    ]);
    expect(changesToConfirm({ ...current, approvalMode: 'auto' }, { approvalMode: 'ask' })).toEqual([]);
    expect(changesToConfirm({ ...current, approvalMode: 'auto' }, { approvalMode: 'auto' })).toEqual([]);
  });

  it('asks before changing the editor command, treating empty as the default', () => {
    expect(changesToConfirm(current, { editorCommand: 'calc' })).toEqual([
      'Open files with the editor command "calc".',
    ]);
    expect(changesToConfirm(current, { editorCommand: '  ' })).toEqual([]);
    expect(changesToConfirm(current, { editorCommand: ' code ' })).toEqual([]);
  });

  it('asks before starting a new or changed stdio MCP server', () => {
    const added: McpServerConfig = { name: 'evil', transport: 'stdio', command: 'cmd', args: ['/c', 'calc'] };
    expect(changesToConfirm(current, { mcpServers: [docs, added] })).toEqual([
      'Start the new MCP server "evil": cmd /c calc',
    ]);
    expect(changesToConfirm(current, { mcpServers: [{ ...docs, args: ['other.js'] }] })).toEqual([
      'Start the changed MCP server "docs": node other.js',
    ]);
    expect(changesToConfirm(current, { mcpServers: [{ ...docs, command: 'python' }] })).toHaveLength(1);
    expect(changesToConfirm(current, { mcpServers: [{ ...docs, cwd: 'C:\\temp' }] })).toHaveLength(1);
    // Same name, but it used to be an http server.
    const http: Settings = { ...current, mcpServers: [{ name: 'docs', transport: 'http', url: 'https://x.test' }] };
    expect(changesToConfirm(http, { mcpServers: [docs] })).toEqual(['Start the new MCP server "docs": node docs.js']);
  });

  it('names the program a stdio server would run, or that it is not on PATH (#142)', () => {
    const added: McpServerConfig = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'srv'] };
    const resolve = (command: string) => (command === 'npx' ? 'C:\\node\\npx.cmd' : null);
    expect(changesToConfirm(current, { mcpServers: [docs, added] }, {}, resolve)).toEqual([
      'Start the new MCP server "fs": npx -y srv (runs C:\\node\\npx.cmd)',
    ]);
    expect(changesToConfirm(current, { mcpServers: [{ ...added, command: 'uvx' }] }, {}, resolve)).toContain(
      'Start the new MCP server "fs": uvx -y srv (not found on PATH)',
    );
  });

  it('asks before a server leaves the sandbox or gets network in it, and names the boundary (#87)', () => {
    const boxed: McpServerConfig = { ...docs, sandbox: true };
    const configured: Settings = { ...current, mcpServers: [boxed] };
    expect(changesToConfirm(configured, { mcpServers: [docs] })).toEqual([
      'Run without the sandbox the MCP server "docs": node docs.js',
    ]);
    expect(changesToConfirm(configured, { mcpServers: [{ ...boxed, sandboxNetwork: true }] })).toEqual([
      'Give network access to the sandboxed MCP server "docs": node docs.js (sandboxed, with network)',
    ]);
    // Moving into the sandbox, or taking network away, narrows its rights.
    expect(changesToConfirm(current, { mcpServers: [boxed] })).toEqual([]);
    expect(
      changesToConfirm({ ...current, mcpServers: [{ ...boxed, sandboxNetwork: true }] }, { mcpServers: [boxed] }),
    ).toEqual([]);
    expect(changesToConfirm(current, { mcpServers: [docs, { ...boxed, name: 'new' }] })).toEqual([
      'Start the new MCP server "new": node docs.js (sandboxed)',
    ]);
  });

  it('asks before setting environment variables for a stdio server, naming the keys only', () => {
    const changes = changesToConfirm(current, {
      mcpServers: [{ ...docs, env: { NODE_OPTIONS: '--require ./x.js', KEPT: '' } }],
    });
    expect(changes).toEqual(['Set NODE_OPTIONS for the MCP server "docs": node docs.js']);
    expect(changes.join(' ')).not.toContain('--require');
  });

  it('does not ask for http servers or for removing a server', () => {
    const http: McpServerConfig = { name: 'web', transport: 'http', url: 'https://mcp.test/', headers: { A: 'b' } };
    expect(changesToConfirm(current, { mcpServers: [docs, http] })).toEqual([]);
    expect(changesToConfirm(current, { mcpServers: [] })).toEqual([]);
  });

  it('asks before adding a rule that allows calls or delegates them, not for other rules', () => {
    const allow = { tool: 'run_command', action: 'allow' as const };
    const delegate = { tool: ['fetch_url'], action: 'delegate' as const, to: 'check' };
    const reject = { tool: 'run_command', action: 'reject' as const };
    expect(changesToConfirm(current, { permissionRules: [reject, { tool: '*', action: 'ask' }] })).toEqual([]);
    expect(changesToConfirm(current, { permissionRules: [allow, delegate] })).toEqual([
      'Allow run_command without asking (permission rule).',
      'Let the program "check" decide calls to fetch_url (permission rule).',
    ]);
    const withAllow: Settings = { ...current, permissionRules: [allow] };
    expect(changesToConfirm(withAllow, { permissionRules: [allow] })).toEqual([]);
  });

  it('shows the whole command of a delegate and asks again when one of its arguments changes', () => {
    const delegate = { tool: 'fetch_url', action: 'delegate' as const, to: ['node', 'check.js', '--strict'] };
    expect(changesToConfirm(current, { permissionRules: [delegate] })).toEqual([
      'Let the program "node check.js --strict" decide calls to fetch_url (permission rule).',
    ]);
    const configured: Settings = { ...current, permissionRules: [delegate] };
    expect(changesToConfirm(configured, { permissionRules: [{ ...delegate, to: [...delegate.to] }] })).toEqual([]);
    const changed = { ...delegate, to: ['node', 'check.js', '--lenient'] };
    expect(changesToConfirm(configured, { permissionRules: [changed] })).toEqual([
      'Let the program "node check.js --lenient" decide calls to fetch_url (permission rule).',
      'Change the rule that lets the program "node check.js --strict" decide calls to fetch_url, or its preceding rules (permission rule).',
    ]);
  });

  it.each(['ask', 'reject'] as const)('asks before removing an existing %s rule, even in Auto mode', (action) => {
    const rule: PermissionRule = { tool: 'run_command', matches: { command: 'git push*' }, action };
    const configured = { ...current, approvalMode: 'auto' as const, permissionRules: [rule] };
    expect(changesToConfirm(configured, { permissionRules: [] })).toEqual([
      `Change the ${action} protection for run_command matching {"command":"git push*"} or its preceding rules (permission rule).`,
    ]);
  });

  it('asks before removing a delegate rule or changing the rules before it, even in Auto mode (#251)', () => {
    const delegate: PermissionRule = { tool: 'run_command', action: 'delegate', to: 'C:\\policy.exe' };
    const allow: PermissionRule = { tool: 'run_command', action: 'allow' };
    const configured = { ...current, approvalMode: 'auto' as const, permissionRules: [delegate] };
    const expected = [
      'Change the rule that lets the program "C:\\policy.exe" decide calls to run_command, or its preceding rules (permission rule).',
    ];
    expect(changesToConfirm(configured, { permissionRules: [] })).toEqual(expected);
    // An allow rule put in front shadows the delegate; the new allow rule is listed too.
    expect(changesToConfirm(configured, { permissionRules: [allow, delegate] })).toEqual([
      'Allow run_command without asking (permission rule).',
      ...expected,
    ]);
    expect(changesToConfirm(configured, { permissionRules: [delegate] })).toEqual([]);
  });

  it('asks when a protective rule changes its matching fields, tool, context or action', () => {
    const rule: PermissionRule = { tool: 'run_command', matches: { command: 'git push*' }, action: 'reject' };
    const configured = { ...current, permissionRules: [rule] };
    const replacements: PermissionRule[] = [
      { ...rule, matches: { command: 'git push origin main' } },
      { ...rule, tool: 'write_file' },
      { ...rule, context: 'subagent' },
      { ...rule, action: 'ask' },
    ];
    for (const replacement of replacements) {
      expect(changesToConfirm(configured, { permissionRules: [replacement] })).toEqual([
        'Change the reject protection for run_command matching {"command":"git push*"} or its preceding rules (permission rule).',
      ]);
    }
  });

  it('asks when reordering known rules bypasses a protective rule without moving that rule', async () => {
    const read: PermissionRule = { tool: 'read_file', action: 'allow' };
    const ask: PermissionRule = { tool: 'run_command', matches: { command: 'git push*' }, action: 'ask' };
    const allow: PermissionRule = { tool: 'run_command', action: 'allow' };
    const before = [read, ask, allow];
    const after = [allow, ask, read];
    expect(await decidePermission(before, 'run_command', { command: 'git push origin main' }, 'thread')).toEqual({
      action: 'ask',
    });
    expect(await decidePermission(after, 'run_command', { command: 'git push origin main' }, 'thread')).toEqual({
      action: 'allow',
    });
    expect(changesToConfirm({ ...current, permissionRules: before }, { permissionRules: after })).toEqual([
      'Change the ask protection for run_command matching {"command":"git push*"} or its preceding rules (permission rule).',
    ]);
  });

  it('keeps unchanged protective rules quiet and permits new protections or changes after them', () => {
    const ask: PermissionRule = { tool: 'run_command', action: 'ask' };
    const allow: PermissionRule = { tool: 'read_file', action: 'allow' };
    const reject: PermissionRule = { tool: 'write_file', action: 'reject' };
    const configured = { ...current, permissionRules: [ask, allow] };
    expect(changesToConfirm(configured, { ...configured })).toEqual([]);
    expect(changesToConfirm(configured, { theme: 'light' })).toEqual([]);
    expect(changesToConfirm(configured, { permissionRules: [ask, reject] })).toEqual([]);
    expect(changesToConfirm({ ...current, permissionRules: [allow] }, { permissionRules: [] })).toEqual([]);
  });

  it('lists every change in one confirmation', () => {
    expect(changesToConfirm(current, { approvalMode: 'auto', editorCommand: 'vim' })).toHaveLength(2);
  });
});
