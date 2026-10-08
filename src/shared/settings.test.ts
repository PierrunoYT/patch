import { describe, expect, it } from 'vitest';
import {
  openaiCredentialMissing,
  parseMcpServers,
  parsePermissionRules,
  sanitizeMcpServers,
  sanitizePermissionRules,
  type SettingsView,
} from './settings';

function credentialView(patch: {
  openaiBaseUrl?: string;
  secrets?: Partial<SettingsView['secrets']>;
  chatgpt?: Partial<SettingsView['chatgpt']>;
}): Pick<SettingsView, 'openaiBaseUrl' | 'secrets' | 'chatgpt'> {
  return {
    openaiBaseUrl: patch.openaiBaseUrl ?? '',
    secrets: {
      anthropicApiKey: false,
      openaiApiKey: false,
      openrouterApiKey: false,
      googleApiKey: false,
      ...patch.secrets,
    },
    chatgpt: { signedIn: false, accountLabel: null, ...patch.chatgpt },
  };
}

describe('openaiCredentialMissing', () => {
  it('passes a ChatGPT session for official OpenAI and still fails with neither session nor key', () => {
    expect(openaiCredentialMissing(credentialView({ chatgpt: { signedIn: true, accountLabel: 'a@b.c' } }))).toBe(false);
    expect(openaiCredentialMissing(credentialView({ secrets: { openaiApiKey: true } }))).toBe(false);
    expect(openaiCredentialMissing(credentialView({}))).toBe(true);
    expect(
      openaiCredentialMissing(
        credentialView({ openaiBaseUrl: 'http://localhost:11434/v1', chatgpt: { signedIn: true, accountLabel: null } }),
      ),
    ).toBe(true);
  });
});

describe('parseMcpServers', () => {
  it('accepts valid stdio and http servers', () => {
    const servers = parseMcpServers(
      JSON.stringify([
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { DEBUG: '1' } },
        { name: 'docs', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      ]),
    );
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: 'fs', transport: 'stdio' });
    expect(servers[1]).toMatchObject({ name: 'docs', transport: 'http' });
  });

  it('accepts an empty list', () => {
    expect(parseMcpServers('')).toEqual([]);
    expect(parseMcpServers('[]')).toEqual([]);
  });

  it('rejects broken JSON and invalid entries with a readable message', () => {
    expect(() => parseMcpServers('{')).toThrow(/valid JSON/);
    expect(() => parseMcpServers('{}')).toThrow(/JSON array/);
    expect(() =>
      parseMcpServers(
        '[{"name":"a","transport":"stdio","command":"x"},{"name":"a","transport":"stdio","command":"y"}]',
      ),
    ).toThrow(/duplicate name/);
    expect(() => parseMcpServers('[{}]')).toThrow(/entry 1.*"name" is required/);
    expect(() => parseMcpServers('[{"name":"x","transport":"ws"}]')).toThrow(/"transport" must be/);
    expect(() => parseMcpServers('[{"name":"x","transport":"stdio"}]')).toThrow(/need a "command"/);
    expect(() => parseMcpServers('[{"name":"x","transport":"http","url":"ftp://x"}]')).toThrow(/http\(s\):\/\//);
    expect(() => parseMcpServers('[{"name":"x","transport":"stdio","command":"a","args":[1]}]')).toThrow(
      /"args" must be string arrays/,
    );
  });
});

describe('sanitizeMcpServers', () => {
  it('drops unusable entries instead of failing to start', () => {
    expect(
      sanitizeMcpServers([
        { name: 'ok', transport: 'stdio', command: 'run' },
        { name: '', transport: 'stdio', command: 'run' },
        'nonsense',
        { name: 'no-url', transport: 'http' },
      ]),
    ).toEqual([{ name: 'ok', transport: 'stdio', command: 'run' }]);
  });

  it('rejects non-arrays', () => {
    expect(sanitizeMcpServers(undefined)).toEqual([]);
    expect(sanitizeMcpServers({})).toEqual([]);
  });
});

describe('parsePermissionRules', () => {
  it('accepts valid rules and empty text', () => {
    expect(parsePermissionRules('')).toEqual([]);
    const rules = [
      { tool: 'run_command', matches: { command: ['git push*', 'rm *'] }, action: 'reject', message: 'no' },
      { tool: ['a', 'b'], action: 'delegate', to: 'check', context: 'subagent' },
      { tool: 'x', action: 'delegate', to: 'C:\\Program Files\\check.exe' },
      { tool: 'x', action: 'delegate', to: ['node', 'check.js', '--strict'] },
    ];
    expect(parsePermissionRules(JSON.stringify(rules))).toEqual(rules);
  });

  it.each([
    ['not json', '{'],
    ['not an array', '{}'],
    ['bad action', '[{"tool":"x","action":"maybe"}]'],
    ['missing tool', '[{"action":"allow"}]'],
    ['delegate without program', '[{"tool":"x","action":"delegate"}]'],
    ['delegate with an empty program', '[{"tool":"x","action":"delegate","to":"  "}]'],
    ['delegate with an empty list', '[{"tool":"x","action":"delegate","to":[]}]'],
    ['delegate with an empty argument', '[{"tool":"x","action":"delegate","to":["node",""]}]'],
    ['delegate with a non-text argument', '[{"tool":"x","action":"delegate","to":["node",1]}]'],
    ['bad matches', '[{"tool":"x","action":"ask","matches":{"a":1}}]'],
    ['bad context', '[{"tool":"x","action":"ask","context":"main"}]'],
  ])('rejects %s', (_name, text) => {
    expect(() => parsePermissionRules(text)).toThrow();
  });

  it('drops unusable stored rules', () => {
    expect(sanitizePermissionRules([{ tool: 'x', action: 'ask' }, { action: 'ask' }, 5])).toEqual([
      { tool: 'x', action: 'ask' },
    ]);
    expect(sanitizePermissionRules('nope')).toEqual([]);
  });
});
