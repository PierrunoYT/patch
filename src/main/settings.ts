import { EventEmitter } from 'node:events';
import { appLog } from './app_log';
import {
  DEFAULT_SETTINGS,
  sanitizeMcpServers,
  sanitizePermissionRules,
  baseUrlError,
  parsePermissionRules,
  SECRET_NAMES,
  parseMcpServers,
  type McpServerConfig,
  type McpServerView,
  type SecretName,
  type Settings,
  type SettingsView,
} from '@shared/settings';
import { readJson, writeJson } from './storage/json_file';

// A ChatGPT Codex login. Access and refresh tokens are sealed like other secrets before they are written.
export interface ChatGptSession {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  accountLabel: string | null;
  expiresAt: number;
}

interface StoredChatGpt {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  accountLabel?: string;
  expiresAt: number;
}

// Encrypts secrets at rest. In the app this is Electron's safeStorage (OS keychain / DPAPI); tests inject
// their own.
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
  // True when the system "encrypts" with a password anyone can know (Electron's basic_text backend on Linux).
  fixedKey?(): boolean;
}

interface StoredSettings {
  settings: Partial<Settings>;
  // Base64 ciphertext when encryption is available, otherwise plain text marked with a "plain:" prefix.
  secrets: Partial<Record<SecretName, string>>;
  // env and headers of MCP servers, encrypted the same way. Keyed by server name.
  mcpSecrets?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
  chatgpt?: StoredChatGpt;
}

export class SettingsStore extends EventEmitter {
  private settings: Settings;
  private secrets: Partial<Record<SecretName, string>>;
  private mcpSecrets: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
  private chatgpt: StoredChatGpt | null;

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher,
  ) {
    super();
    const raw = readJson<unknown>(path, null);
    const stored: Partial<Record<keyof StoredSettings, unknown>> = isRecord(raw) ? raw : {};
    this.settings = sanitize({
      ...DEFAULT_SETTINGS,
      ...(isRecord(stored.settings) ? (stored.settings as Partial<Settings>) : {}),
    });
    this.secrets = isRecord(stored.secrets) ? (stored.secrets as StoredSettings['secrets']) : {};
    this.mcpSecrets = isRecord(stored.mcpSecrets)
      ? (stored.mcpSecrets as NonNullable<StoredSettings['mcpSecrets']>)
      : {};
    this.chatgpt = sanitizeStoredChatGpt(stored.chatgpt);
    this.migratePlainSecrets();
  }

  get(): Settings {
    return { ...this.settings };
  }

  view(): SettingsView {
    this.migratePlainSecrets();
    const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, Boolean(this.secrets[name])])) as Record<
      SecretName,
      boolean
    >;
    const stored = this.sealedSecretValues();
    // A backend that seals with a fixed password (Linux without a keyring) protects nothing, whatever was stored (#258).
    const secretsEncrypted =
      !this.cipher.fixedKey?.() &&
      (stored.length > 0 ? stored.every((value) => !value.startsWith('plain:')) : this.cipher.isAvailable());
    const { mcpServers, ...rest } = this.settings;
    const session = this.getChatGptSession();
    return {
      ...rest,
      mcpServers: mcpServers.map((server) => this.mcpView(server)),
      secrets,
      secretsEncrypted,
      chatgpt: { signedIn: session !== null, accountLabel: session?.accountLabel ?? null },
    };
  }

  // Whether keys can be encrypted on this system. When not, a saved key is kept as plain text.
  canEncrypt(): boolean {
    return this.cipher.isAvailable();
  }

  // The full server config, including decrypted env and headers, for the process that connects to the servers.
  mcpServers(): McpServerConfig[] {
    return this.settings.mcpServers.map((server) => ({
      ...server,
      env: this.decryptMap(this.mcpSecrets[server.name]?.env),
      headers: this.decryptMap(this.mcpSecrets[server.name]?.headers),
    }));
  }

  // Names (never values) of the stored HTTP headers of each MCP server, for the settings confirmation: a changed URL
  // would send them to another host.
  mcpHeaderNames(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(this.mcpSecrets).map(([name, secrets]) => [name, Object.keys(secrets.headers ?? {})]),
    );
  }

  update(patch: Partial<Settings>): SettingsView {
    const known = pickKnown(patch);
    // User-entered server config is validated up front so the dialog can show the problem; a silent drop would
    // hide typos.
    if ('mcpServers' in known) this.validateMcpServers(known.mcpServers);
    if ('permissionRules' in known) parsePermissionRules(JSON.stringify(known.permissionRules));
    for (const [key, label] of [
      ['anthropicBaseUrl', 'The Claude base URL'],
      ['openaiBaseUrl', 'The OpenAI-compatible base URL'],
    ] as const) {
      if (!(key in known)) continue;
      const error = baseUrlError(label, String(known[key]));
      if (error) throw new Error(error);
    }
    const next = sanitize({ ...this.settings, ...known });
    // Staged, not assigned: the stored secrets change only once the file is written, so a failed write leaves memory
    // and disk in agreement (#184).
    const mcpSecrets = 'mcpServers' in known ? this.nextMcpSecrets(next.mcpServers) : this.mcpSecrets;
    next.mcpServers = next.mcpServers.map(({ env: _env, headers: _headers, ...server }) => server);
    this.persist(next, this.secrets, this.chatgpt, mcpSecrets);
    return this.view();
  }

  getSecret(name: SecretName): string {
    this.migratePlainSecrets();
    const stored = this.secrets[name];
    if (!stored) return '';
    if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
    try {
      return this.cipher.decrypt(stored);
    } catch {
      return '';
    }
  }

  // Saved keys that cannot be decrypted. safeStorage keeps its own key in the profile's `Local State`, which Chromium
  // writes about 10 s after the key is created or when the app quits, so a crash or forced exit soon after saving the
  // first key loses it and the saved keys can never be read again (#54). getSecret then returns '' and the app asks for
  // the key as if it was never entered; this lets startup say why. Nothing is deleted: on Linux decryption can also
  // fail while the keyring is locked, and saving the key again replaces it anyway.
  unreadableSecrets(): SecretName[] {
    const unreadable = SECRET_NAMES.filter((name) => {
      const stored = this.secrets[name];
      if (!stored || stored.startsWith('plain:')) return false;
      try {
        this.cipher.decrypt(stored);
        return false;
      } catch {
        return true;
      }
    });
    for (const name of unreadable) appLog.warn('settings', 'A saved key could not be decrypted.', { name });
    return unreadable;
  }

  setSecret(name: SecretName, value: string): SettingsView {
    const trimmed = value.trim();
    const secrets = { ...this.secrets };
    if (!trimmed) {
      delete secrets[name];
    } else if (this.cipher.isAvailable()) {
      secrets[name] = this.cipher.encrypt(trimmed);
    } else {
      secrets[name] = `plain:${trimmed}`;
    }
    this.persist(this.settings, secrets);
    return this.view();
  }

  getChatGptSession(): ChatGptSession | null {
    this.migratePlainSecrets();
    const stored = this.chatgpt;
    if (!stored) return null;
    const accessToken = this.openSealed(stored.accessToken);
    const refreshToken = this.openSealed(stored.refreshToken);
    if (!accessToken || !refreshToken || !stored.accountId) return null;
    const label = stored.accountLabel?.trim() || null;
    return {
      accessToken,
      refreshToken,
      accountId: stored.accountId,
      accountLabel: label && label !== accessToken && label !== refreshToken ? label : null,
      expiresAt: stored.expiresAt,
    };
  }

  setChatGptSession(session: ChatGptSession | null): SettingsView {
    if (!session) {
      this.persist(this.settings, this.secrets, null);
      return this.view();
    }
    const accessToken = session.accessToken.trim();
    const refreshToken = session.refreshToken.trim();
    const accountId = session.accountId.trim();
    if (!accessToken || !refreshToken || !accountId || !Number.isFinite(session.expiresAt)) {
      throw new Error('ChatGPT sign-in did not return a usable session.');
    }
    const accountLabel = session.accountLabel?.trim() || '';
    const stored: StoredChatGpt = {
      accessToken: this.seal(accessToken),
      refreshToken: this.seal(refreshToken),
      accountId,
      expiresAt: session.expiresAt,
      ...(accountLabel && accountLabel !== accessToken && accountLabel !== refreshToken ? { accountLabel } : {}),
    };
    this.persist(this.settings, this.secrets, stored);
    return this.view();
  }

  private migratePlainSecrets(): void {
    if (!this.cipher.isAvailable() || !this.sealedSecretValues().some((value) => value.startsWith('plain:'))) return;
    // Stage the complete migration before writing or changing memory. A failed cipher or write must leave keys usable.
    try {
      const secrets = { ...this.secrets };
      for (const name of SECRET_NAMES) {
        const value = secrets[name];
        if (value?.startsWith('plain:')) secrets[name] = this.cipher.encrypt(value.slice('plain:'.length));
      }
      const chatgpt = this.chatgpt ? this.reencryptChatGpt(this.chatgpt) : null;
      const mcpSecrets = this.reencryptMcpSecrets(this.mcpSecrets);
      this.writeStored(this.settings, secrets, chatgpt, mcpSecrets);
      this.secrets = secrets;
      this.chatgpt = chatgpt;
      this.mcpSecrets = mcpSecrets;
    } catch {
      // Retain the original storage representation; a later access can retry when encryption/storage recovers.
    }
  }

  private persist(
    settings: Settings,
    secrets: Partial<Record<SecretName, string>>,
    chatgpt: StoredChatGpt | null = this.chatgpt,
    mcpSecrets = this.mcpSecrets,
  ): void {
    this.writeStored(settings, secrets, chatgpt, mcpSecrets);
    this.settings = settings;
    this.secrets = secrets;
    this.chatgpt = chatgpt;
    this.mcpSecrets = mcpSecrets;
    this.emit('change', this.view());
  }

  private writeStored(
    settings: Settings,
    secrets: Partial<Record<SecretName, string>>,
    chatgpt: StoredChatGpt | null,
    mcpSecrets = this.mcpSecrets,
  ): void {
    const stored: StoredSettings = { settings, secrets, mcpSecrets };
    if (chatgpt) stored.chatgpt = chatgpt;
    writeJson(this.path, stored);
  }

  // Every stored secret: API keys, the ChatGPT tokens and MCP servers' env and header values (#113). The plaintext
  // check and the "encrypted" status in Settings both read this list.
  private sealedSecretValues(): string[] {
    const values = Object.values(this.secrets).filter((value): value is string => Boolean(value));
    if (this.chatgpt) values.push(this.chatgpt.accessToken, this.chatgpt.refreshToken);
    for (const secrets of Object.values(this.mcpSecrets)) {
      values.push(...Object.values(secrets.env ?? {}), ...Object.values(secrets.headers ?? {}));
    }
    return values;
  }

  // A copy with every `plain:` MCP env and header value encrypted; it throws, changing nothing, if the cipher fails.
  private reencryptMcpSecrets(all: typeof this.mcpSecrets): typeof this.mcpSecrets {
    const reseal = (map: Record<string, string> | undefined) =>
      map &&
      Object.fromEntries(
        Object.entries(map).map(([key, value]) => [
          key,
          value.startsWith('plain:') ? this.cipher.encrypt(value.slice('plain:'.length)) : value,
        ]),
      );
    return Object.fromEntries(
      Object.entries(all).map(([name, secrets]) => [
        name,
        { env: reseal(secrets.env), headers: reseal(secrets.headers) },
      ]),
    );
  }

  private seal(value: string): string {
    return this.cipher.isAvailable() ? this.cipher.encrypt(value) : `plain:${value}`;
  }

  private openSealed(value: string): string {
    if (!value) return '';
    if (value.startsWith('plain:')) return value.slice('plain:'.length);
    try {
      return this.cipher.decrypt(value);
    } catch {
      return '';
    }
  }

  private reencryptChatGpt(stored: StoredChatGpt): StoredChatGpt {
    return {
      ...stored,
      accessToken: stored.accessToken.startsWith('plain:')
        ? this.cipher.encrypt(stored.accessToken.slice('plain:'.length))
        : stored.accessToken,
      refreshToken: stored.refreshToken.startsWith('plain:')
        ? this.cipher.encrypt(stored.refreshToken.slice('plain:'.length))
        : stored.refreshToken,
    };
  }

  // The stored env and header secrets for a new server list. It changes nothing; persist stores the result.
  private nextMcpSecrets(servers: McpServerConfig[]): typeof this.mcpSecrets {
    const next: typeof this.mcpSecrets = {};
    const renamed = this.renamedServers(servers);
    for (const server of servers) {
      const previous = this.mcpSecrets[server.name] ?? this.mcpSecrets[renamed.get(server.name) ?? ''];
      next[server.name] = {
        // A missing map means the caller did not edit it, so the stored secrets stay. An empty value for a key that
        // is present keeps that one secret, so the dialog can show the key without the user retyping it.
        env: server.env ? this.encryptMap(server.env, previous?.env) : previous?.env,
        headers: server.headers ? this.encryptMap(server.headers, previous?.headers) : previous?.headers,
      };
    }
    return next;
  }

  // Maps the new name of each renamed server to its old one (#23). A server counts as renamed when its old name is gone
  // from the list and exactly one new, unmatched name has the same transport and endpoint (URL, or command and args).
  // The endpoint is unchanged, so carrying its secrets over sends them nowhere new; anything ambiguous keeps no secrets.
  private renamedServers(servers: McpServerConfig[]): Map<string, string> {
    const identity = (server: McpServerConfig) =>
      JSON.stringify(
        server.transport === 'http'
          ? ['http', (server.url ?? '').trim()]
          : ['stdio', server.command ?? '', server.args ?? []],
      );
    const names = new Set(servers.map((server) => server.name));
    const gone = this.settings.mcpServers.filter((server) => !names.has(server.name));
    const added = servers.filter((server) => !this.settings.mcpServers.some((old) => old.name === server.name));
    const renamed = new Map<string, string>();
    for (const server of added) {
      const sameOld = gone.filter((old) => identity(old) === identity(server));
      const sameNew = added.filter((candidate) => identity(candidate) === identity(server));
      if (sameOld.length === 1 && sameNew.length === 1) renamed.set(server.name, sameOld[0]!.name);
    }
    return renamed;
  }

  // An empty value keeps the stored secret, so saving the dialog without retyping a key does not clear it.
  private encryptMap(
    incoming: Record<string, string> | undefined,
    previous: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!incoming) return undefined;
    const stored: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!value) {
        if (previous?.[key]) stored[key] = previous[key];
        continue;
      }
      stored[key] = this.cipher.isAvailable() ? this.cipher.encrypt(value) : `plain:${value}`;
    }
    return Object.keys(stored).length > 0 ? stored : undefined;
  }

  private decryptMap(stored: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!stored) return undefined;
    const plain: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (value.startsWith('plain:')) plain[key] = value.slice('plain:'.length);
      else {
        try {
          plain[key] = this.cipher.decrypt(value);
        } catch {
          // A secret that cannot be decrypted is omitted rather than sent to the server as ciphertext.
        }
      }
    }
    return Object.keys(plain).length > 0 ? plain : undefined;
  }

  private mcpView(server: McpServerConfig): McpServerView {
    const stored = this.mcpSecrets[server.name];
    return {
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      ...(server.sandbox !== undefined && { sandbox: server.sandbox }),
      ...(server.sandboxNetwork !== undefined && { sandboxNetwork: server.sandboxNetwork }),
      envKeys: Object.keys(stored?.env ?? {}),
      headerKeys: Object.keys(stored?.headers ?? {}),
    };
  }

  private validateMcpServers(value: unknown): McpServerConfig[] {
    try {
      return parseMcpServers(JSON.stringify(value));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickKnown(patch: Partial<Settings>): Partial<Settings> {
  const known = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  return Object.fromEntries(Object.entries(patch).filter(([key]) => known.includes(key as keyof Settings)));
}

// Falls back to defaults for values of the wrong type, e.g. from a hand-edited settings file.
function sanitize(settings: Settings): Settings {
  const result = { ...settings };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof result[key] !== typeof DEFAULT_SETTINGS[key]) {
      (result as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (!['ask', 'auto'].includes(result.approvalMode)) result.approvalMode = DEFAULT_SETTINGS.approvalMode;
  if (!['off', 'auto', 'container'].includes(result.sandboxMode)) result.sandboxMode = DEFAULT_SETTINGS.sandboxMode;
  if (!['off', 'allow-list', 'on'].includes(result.sandboxNetwork))
    result.sandboxNetwork = DEFAULT_SETTINGS.sandboxNetwork;
  result.sandboxImage = result.sandboxImage.trim() || DEFAULT_SETTINGS.sandboxImage;
  if (!['dark', 'light'].includes(result.theme)) result.theme = DEFAULT_SETTINGS.theme;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(result.effort)) result.effort = DEFAULT_SETTINGS.effort;
  if (!['same', 'mid', 'small'].includes(result.subagentModel)) result.subagentModel = DEFAULT_SETTINGS.subagentModel;
  if (!['match', 'scaled'].includes(result.subagentEffort)) result.subagentEffort = DEFAULT_SETTINGS.subagentEffort;
  // An empty field arrives as 0 and a hand-edited file can hold NaN; neither means "index one file" (#184).
  const maxFiles = Math.floor(result.maxIndexedFiles);
  result.maxIndexedFiles = Number.isFinite(maxFiles) && maxFiles >= 1 ? maxFiles : DEFAULT_SETTINGS.maxIndexedFiles;
  result.model = result.model.trim() || DEFAULT_SETTINGS.model;
  result.mcpServers = sanitizeMcpServers(result.mcpServers);
  // A saved value that is not an http(s) URL would send nothing anywhere; fall back to the official API.
  result.anthropicBaseUrl = baseUrlError('', result.anthropicBaseUrl) ? '' : result.anthropicBaseUrl.trim();
  result.openaiBaseUrl = baseUrlError('', result.openaiBaseUrl) ? '' : result.openaiBaseUrl.trim();
  result.permissionRules = sanitizePermissionRules(result.permissionRules);
  result.claudeCodePath = result.claudeCodePath.trim();
  return result;
}

function sanitizeStoredChatGpt(value: unknown): StoredChatGpt | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.accessToken !== 'string' || typeof entry.refreshToken !== 'string') return null;
  if (typeof entry.accountId !== 'string' || !entry.accountId.trim()) return null;
  if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) return null;
  const accountLabel = typeof entry.accountLabel === 'string' ? entry.accountLabel.trim() : '';
  return {
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken,
    accountId: entry.accountId.trim(),
    expiresAt: entry.expiresAt,
    ...(accountLabel ? { accountLabel } : {}),
  };
}
