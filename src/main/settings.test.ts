import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
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
    expect(store.get().maxIndexedFiles).toBe(1);
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
