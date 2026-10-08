import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type McpServerConfig } from '@shared/settings';
import { SettingsStore, type SecretCipher } from './settings';

const reversingCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join('')).toString('base64'),
  decrypt: (encoded) => [...Buffer.from(encoded, 'base64').toString()].reverse().join(''),
};

const noCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('unavailable');
  },
  decrypt: () => {
    throw new Error('unavailable');
  },
};

describe('SettingsStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-settings-'));
    file = join(dir, 'settings.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports saved keys that can no longer be decrypted, without deleting them', () => {
    new SettingsStore(file, reversingCipher).setSecret('anthropicApiKey', 'sk-ant-123');
    // The encryption key is gone (#54): the stored value no longer decrypts.
    const lost: SecretCipher = {
      ...reversingCipher,
      decrypt: () => {
        throw new Error('bad key');
      },
    };
    const store = new SettingsStore(file, lost);
    expect(store.unreadableSecrets()).toEqual(['anthropicApiKey']);
    expect(store.getSecret('anthropicApiKey')).toBe('');
    // Still stored: saving the key again replaces it, and a keyring that was only locked can read it later.
    expect(store.view().secrets.anthropicApiKey).toBe(true);
    expect(new SettingsStore(file, reversingCipher).unreadableSecrets()).toEqual([]);
  });

  it('keeps a Claude base URL only when it is http(s), rejecting a typo and dropping a bad saved one', () => {
    const store = new SettingsStore(file, reversingCipher);
    expect(store.update({ anthropicBaseUrl: ' https://gateway.example/anthropic ' }).anthropicBaseUrl).toBe(
      'https://gateway.example/anthropic',
    );
    expect(() => store.update({ anthropicBaseUrl: 'gateway.example' })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => store.update({ anthropicBaseUrl: 'file:///etc/passwd' })).toThrow(/http:\/\/ or https:\/\//);
    expect(store.update({ anthropicBaseUrl: '' }).anthropicBaseUrl).toBe('');

    writeFileSync(file, JSON.stringify({ ...DEFAULT_SETTINGS, anthropicBaseUrl: 'ftp://old.example' }));
    expect(new SettingsStore(file, reversingCipher).get().anthropicBaseUrl).toBe('');
  });

  it('keeps an OpenAI-compatible base URL only when it is http(s) (#184)', () => {
    const store = new SettingsStore(file, reversingCipher);
    expect(store.update({ openaiBaseUrl: ' http://localhost:11434/v1 ' }).openaiBaseUrl).toBe(
      'http://localhost:11434/v1',
    );
    expect(() => store.update({ openaiBaseUrl: 'localhost:11434' })).toThrow(/OpenAI-compatible base URL/);
    expect(store.get().openaiBaseUrl).toBe('http://localhost:11434/v1');
    expect(store.update({ openaiBaseUrl: '' }).openaiBaseUrl).toBe('');

    writeFileSync(file, JSON.stringify({ ...DEFAULT_SETTINGS, openaiBaseUrl: 'javascript:alert(1)' }));
    expect(new SettingsStore(file, reversingCipher).get().openaiBaseUrl).toBe('');
  });

  it('uses the default max indexed files for an empty, zero or non-finite value (#184)', () => {
    const store = new SettingsStore(file, reversingCipher);
    expect(store.update({ maxIndexedFiles: 500.7 }).maxIndexedFiles).toBe(500);
    for (const value of [Number(''), NaN, Infinity, 0.5]) {
      expect(store.update({ maxIndexedFiles: value }).maxIndexedFiles).toBe(DEFAULT_SETTINGS.maxIndexedFiles);
    }
    writeFileSync(file, JSON.stringify({ settings: { ...DEFAULT_SETTINGS, maxIndexedFiles: 0 } }));
    expect(new SettingsStore(file, reversingCipher).get().maxIndexedFiles).toBe(DEFAULT_SETTINGS.maxIndexedFiles);
  });

  it('keeps the previous MCP secrets in memory when saving new ones fails (#184)', () => {
    const store = new SettingsStore(file, reversingCipher);
    const server = { name: 'docs', transport: 'stdio' as const, command: 'server' };
    store.update({ mcpServers: [{ ...server, env: { TOKEN: 'old' } }] });
    const seen: unknown[] = [];
    store.on('change', (view) => seen.push(view));
    renameSync(file, join(dir, 'saved.json'));
    mkdirSync(file);
    expect(() => store.update({ mcpServers: [{ ...server, env: { TOKEN: 'new' } }] })).toThrow();
    expect(store.mcpServers()[0]!.env).toEqual({ TOKEN: 'old' });
    expect(seen).toEqual([]);
  });

  it('keeps a truncated settings file as a .corrupt copy and starts from defaults', () => {
    const broken = '{"settings": {"theme": "light"}, "secrets": {"anthropicApiKey": "plain:sk-ant-1';
    writeFileSync(file, broken);
    const store = new SettingsStore(file, reversingCipher);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    store.update({ theme: 'light' });
    const copies = readdirSync(dir).filter((name) => name.startsWith('settings.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), 'utf8')).toBe(broken);
  });

  it.each(['null', '[]', '"text"', '42', '{"settings": null, "secrets": []}'])(
    'starts with defaults when the settings file holds %s',
    (content) => {
      writeFileSync(file, content);
      const store = new SettingsStore(file, reversingCipher);
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
      expect(store.setSecret('openaiApiKey', 'sk-1').secrets.openaiApiKey).toBe(true);
    },
  );

  it('starts from defaults', () => {
    const store = new SettingsStore(file, reversingCipher);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.view().secrets).toEqual({
      anthropicApiKey: false,
      openaiApiKey: false,
      openrouterApiKey: false,
      googleApiKey: false,
    });
    expect(store.get().allowedNetworkHosts).toBe('');
  });

  it('uses the safe network default for older settings files', () => {
    writeFileSync(file, JSON.stringify({ settings: { allowedCommands: 'npm test' }, secrets: {} }));
    expect(new SettingsStore(file, reversingCipher).get().allowedNetworkHosts).toBe('');
  });

  it('persists updates and ignores unknown keys', () => {
    new SettingsStore(file, reversingCipher).update({
      theme: 'light',
      bogus: 1,
      subagentModel: 'small',
      subagentEffort: 'scaled',
    } as never);
    const reloaded = new SettingsStore(file, reversingCipher);
    expect(reloaded.get().theme).toBe('light');
    expect(reloaded.get().subagentModel).toBe('small');
    expect(reloaded.get().subagentEffort).toBe('scaled');
    expect(reloaded.get()).not.toHaveProperty('bogus');
  });

  it('replaces invalid values with defaults', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.update({
      approvalMode: 'yolo' as never,
      maxIndexedFiles: -5,
      model: '  ',
      subagentModel: 'huge' as never,
      subagentEffort: 'turbo' as never,
    });
    expect(store.get().approvalMode).toBe('ask');
    expect(store.get().maxIndexedFiles).toBe(DEFAULT_SETTINGS.maxIndexedFiles);
    expect(store.get().model).toBe(DEFAULT_SETTINGS.model);
    expect(store.get().subagentModel).toBe('same');
    expect(store.get().subagentEffort).toBe('match');
  });

  it('stores secrets encrypted and never exposes them in the view', () => {
    const store = new SettingsStore(file, reversingCipher);
    const view = store.setSecret('anthropicApiKey', ' sk-ant-123 ');
    expect(view.secrets.anthropicApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-ant-123');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-123');
    expect(new SettingsStore(file, reversingCipher).getSecret('anthropicApiKey')).toBe('sk-ant-123');
  });

  it('keeps MCP server secrets when an unrelated setting is saved', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.update({
      mcpServers: [
        {
          name: 'docs',
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      ],
    });
    expect(JSON.stringify(store.view())).not.toContain('Bearer secret');
    expect(readFileSync(file, 'utf8')).not.toContain('Bearer secret');

    store.update({ theme: 'light' });
    expect(store.mcpServers()[0]!.headers).toEqual({ Authorization: 'Bearer secret' });
    // The confirmation check gets header names only, never values (#110).
    expect(store.mcpHeaderNames()).toEqual({ docs: ['Authorization'] });
    expect(JSON.stringify(store.mcpHeaderNames())).not.toContain('Bearer');
  });

  it('keeps an MCP secret the dialog sends back as an empty value, and drops one the user removed', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.update({
      mcpServers: [{ name: 'docs', transport: 'stdio', command: 'server', env: { TOKEN: 'abc', OTHER: 'def' } }],
    });
    store.update({
      mcpServers: [{ name: 'docs', transport: 'stdio', command: 'server', env: { TOKEN: '' } }],
    });
    expect(store.mcpServers()[0]!.env).toEqual({ TOKEN: 'abc' });
  });

  describe('renaming an MCP server (#23)', () => {
    const docs = { name: 'docs', transport: 'http', url: 'https://example.com/mcp' } as const;

    it('keeps the secrets of a server whose name changed and whose endpoint did not', () => {
      const store = new SettingsStore(file, reversingCipher);
      store.update({ mcpServers: [{ ...docs, headers: { Authorization: 'Bearer secret' } }] });
      store.update({ mcpServers: [{ ...docs, name: 'docs-prod', headers: { Authorization: '' } }] });
      expect(store.mcpServers()).toMatchObject([{ name: 'docs-prod', headers: { Authorization: 'Bearer secret' } }]);
      expect(store.mcpHeaderNames()).toEqual({ 'docs-prod': ['Authorization'] });
    });

    it('keeps stdio env secrets across a rename', () => {
      const store = new SettingsStore(file, reversingCipher);
      const server: McpServerConfig = { name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] };
      store.update({ mcpServers: [{ ...server, env: { TOKEN: 'abc' } }] });
      store.update({ mcpServers: [{ ...server, name: 'renamed', env: { TOKEN: '' } }] });
      expect(store.mcpServers()).toMatchObject([{ name: 'renamed', env: { TOKEN: 'abc' } }]);
    });

    it('does not carry secrets to a server with a different URL', () => {
      const store = new SettingsStore(file, reversingCipher);
      store.update({ mcpServers: [{ ...docs, headers: { Authorization: 'Bearer secret' } }] });
      store.update({
        mcpServers: [{ ...docs, name: 'other', url: 'https://attacker.example/mcp', headers: { Authorization: '' } }],
      });
      expect(store.mcpServers()[0]!.headers).toBeUndefined();
    });

    it('does not guess when several new servers share the old endpoint', () => {
      const store = new SettingsStore(file, reversingCipher);
      store.update({ mcpServers: [{ ...docs, headers: { Authorization: 'Bearer secret' } }] });
      store.update({
        mcpServers: [
          { ...docs, name: 'a', headers: { Authorization: '' } },
          { ...docs, name: 'b', headers: { Authorization: '' } },
        ],
      });
      expect(store.mcpServers().map((server) => server.headers)).toEqual([undefined, undefined]);
    });

    it('moves the secrets instead of copying them, so the old name no longer holds them', () => {
      const store = new SettingsStore(file, reversingCipher);
      store.update({ mcpServers: [{ ...docs, headers: { Authorization: 'Bearer secret' } }] });
      store.update({ mcpServers: [{ ...docs, name: 'docs-prod', headers: { Authorization: '' } }] });
      expect(store.mcpHeaderNames()).not.toHaveProperty('docs');
    });
  });

  it('clears a secret when set to an empty string', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.setSecret('openaiApiKey', 'sk-1');
    store.setSecret('openaiApiKey', '');
    expect(store.getSecret('openaiApiKey')).toBe('');
    expect(store.view().secrets.openaiApiKey).toBe(false);
  });

  it('falls back to plain storage when encryption is unavailable', () => {
    const store = new SettingsStore(file, noCipher);
    store.setSecret('googleApiKey', 'g-key');
    expect(store.view().secretsEncrypted).toBe(false);
    expect(new SettingsStore(file, noCipher).getSecret('googleApiKey')).toBe('g-key');
  });

  it('migrates loaded plaintext keys before reporting encryption', () => {
    const plain = new SettingsStore(file, noCipher);
    plain.setSecret('googleApiKey', 'g-key');
    plain.setSecret('openaiApiKey', 'o-key');
    const store = new SettingsStore(file, reversingCipher);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.secrets.googleApiKey).toBe(reversingCipher.encrypt('g-key'));
    expect(disk.secrets.openaiApiKey).toBe(reversingCipher.encrypt('o-key'));
    expect(store.view().secretsEncrypted).toBe(true);
    expect(new SettingsStore(file, reversingCipher).getSecret('googleApiKey')).toBe('g-key');
  });

  // #113: MCP env and header secrets were left out of migration and of the encryption status.
  it('migrates plaintext MCP env and header secrets and reports them until then', () => {
    let available = false;
    const store = new SettingsStore(file, { ...reversingCipher, isAvailable: () => available });
    store.update({
      mcpServers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://mcp.example/v1',
          headers: { Authorization: 'Bearer h-secret' },
        },
        { name: 'local', transport: 'stdio', command: 'node', env: { TOKEN: 'e-secret' } },
      ],
    });
    // Only MCP secrets are stored, and they are plaintext: Settings must not call them encrypted.
    expect(readFileSync(file, 'utf8')).toContain('plain:Bearer h-secret');
    expect(store.view().secretsEncrypted).toBe(false);

    available = true;
    expect(store.view().secretsEncrypted).toBe(true);
    const disk = readFileSync(file, 'utf8');
    expect(disk).not.toContain('h-secret');
    expect(disk).not.toContain('e-secret');
    const reopened = new SettingsStore(file, reversingCipher).mcpServers();
    expect(reopened.find((server) => server.name === 'api')!.headers).toEqual({ Authorization: 'Bearer h-secret' });
    expect(reopened.find((server) => server.name === 'local')!.env).toEqual({ TOKEN: 'e-secret' });
  });

  it('keeps plaintext MCP secrets usable if their encryption fails during migration', () => {
    const plain = new SettingsStore(file, noCipher);
    plain.update({ mcpServers: [{ name: 'local', transport: 'stdio', command: 'node', env: { TOKEN: 'e-secret' } }] });
    plain.setSecret('googleApiKey', 'g-key');
    const original = readFileSync(file, 'utf8');
    const store = new SettingsStore(file, {
      ...reversingCipher,
      encrypt(value) {
        if (value === 'e-secret') throw new Error('keychain failed');
        return reversingCipher.encrypt(value);
      },
    });
    expect(store.view().secretsEncrypted).toBe(false);
    expect(store.mcpServers()[0]!.env).toEqual({ TOKEN: 'e-secret' });
    expect(store.getSecret('googleApiKey')).toBe('g-key');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('migrates when the cipher becomes available in the current process', () => {
    let available = false;
    const store = new SettingsStore(file, { ...reversingCipher, isAvailable: () => available });
    store.setSecret('googleApiKey', 'g-key');
    available = true;
    expect(store.view().secretsEncrypted).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).secrets.googleApiKey).toBe(reversingCipher.encrypt('g-key'));
    available = false;
    expect(store.view().secretsEncrypted).toBe(true);
  });

  it('retains every plaintext key if encryption fails partway through migration', () => {
    const plain = new SettingsStore(file, noCipher);
    plain.setSecret('anthropicApiKey', 'a-key');
    plain.setSecret('googleApiKey', 'g-key');
    const original = readFileSync(file, 'utf8');
    const store = new SettingsStore(file, {
      ...reversingCipher,
      encrypt(value) {
        if (value === 'g-key') throw new Error('keychain failed');
        return reversingCipher.encrypt(value);
      },
    });
    expect(store.view().secretsEncrypted).toBe(false);
    expect(store.getSecret('anthropicApiKey')).toBe('a-key');
    expect(store.getSecret('googleApiKey')).toBe('g-key');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('keeps plaintext status and keys when migration cannot be persisted, then recovers', () => {
    let available = false;
    const store = new SettingsStore(file, { ...reversingCipher, isAvailable: () => available });
    store.setSecret('googleApiKey', 'g-key');
    const backup = join(dir, 'saved.json');
    renameSync(file, backup);
    mkdirSync(file);
    available = true;
    expect(store.view().secretsEncrypted).toBe(false);
    expect(store.getSecret('googleApiKey')).toBe('g-key');
    expect(JSON.parse(readFileSync(backup, 'utf8')).secrets.googleApiKey).toBe('plain:g-key');
    rmSync(file, { recursive: true });
    renameSync(backup, file);
    expect(store.view().secretsEncrypted).toBe(true);
    expect(new SettingsStore(file, reversingCipher).getSecret('googleApiKey')).toBe('g-key');
  });

  it('keeps the previous key when saving a replacement fails', () => {
    const store = new SettingsStore(file, reversingCipher);
    store.setSecret('googleApiKey', 'original-key');
    const backup = join(dir, 'saved.json');
    renameSync(file, backup);
    mkdirSync(file);
    expect(() => store.setSecret('googleApiKey', 'replacement-key')).toThrow();
    expect(store.getSecret('googleApiKey')).toBe('original-key');
    expect(new SettingsStore(backup, reversingCipher).getSecret('googleApiKey')).toBe('original-key');
  });

  it('emits change events', () => {
    const store = new SettingsStore(file, reversingCipher);
    const seen: string[] = [];
    store.on('change', (view) => seen.push(view.theme));
    store.update({ theme: 'light' });
    expect(seen).toEqual(['light']);
  });
});
