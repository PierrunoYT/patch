import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryDecision } from '../agent/retry';
import { appLog } from '../app_log';
import { SettingsStore, type SecretCipher } from '../settings';
import {
  CODEX_CALLBACK_PORT,
  CODEX_REDIRECT_URI,
  ensureFreshCodexSession,
  signInWithChatGpt,
  signOutChatGpt,
} from './codex_auth';
import { setPackagedBuild } from './endpoints';
import { LlmService } from './index';
import { CODEX_RESPONSES_BASE_URL, chooseOpenAIRoute, codexResponsesBaseUrl } from './openai_route';
import { MockApiServer } from './test_server';
import { ChatGptSignInRequiredError, MissingApiKeyError, type TurnRequest } from './types';

const reversingCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join('')).toString('base64'),
  decrypt: (encoded) => [...Buffer.from(encoded, 'base64').toString()].reverse().join(''),
};

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function textEvents(text: string) {
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const completed = {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-6-sol',
    status: 'completed',
    output: [message],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 14,
    },
    error: null,
    incomplete_details: null,
  };
  let sequence = 0;
  const add = (type: string, data: object) => ({
    event: type,
    data: { type, sequence_number: sequence++, ...data },
  });
  return [
    add('response.created', { response: { ...completed, status: 'in_progress', output: [] } }),
    add('response.output_item.added', {
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    }),
    add('response.content_part.added', {
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
    add('response.output_text.delta', {
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    }),
    add('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text, logprobs: [] }),
    add('response.content_part.done', {
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      part: message.content[0],
    }),
    add('response.output_item.done', { output_index: 0, item: message }),
    add('response.completed', { response: completed }),
  ];
}

function turn(): TurnRequest & { text: string[] } {
  const text: string[] = [];
  return {
    system: 'sys',
    tools: [],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => text.push(delta) },
    text,
  };
}

function form(body: unknown): URLSearchParams {
  return new URLSearchParams(typeof body === 'string' ? body : '');
}

// These tests point the clients at local servers through the PATCH_TEST_* hooks, which only development builds honor.
beforeAll(() => setPackagedBuild(false));
afterAll(() => setPackagedBuild(true));

describe('ChatGPT Codex login', () => {
  let dir: string;
  let file: string;
  let tokens: MockApiServer;
  let tokenUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-codex-login-'));
    file = join(dir, 'settings.json');
    tokens = new MockApiServer();
    tokenUrl = await tokens.start();
  });

  afterEach(async () => {
    await tokens.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function store(): SettingsStore {
    return new SettingsStore(file, reversingCipher);
  }

  it('stores a matching callback, ignores a mismatched one, and sign-out clears the session', async () => {
    const accessToken = 'codex-access-login-7f3a9c';
    const refreshToken = 'codex-refresh-login-91bc2e';
    tokens.queueJson(200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: jwt({
        email: 'ada@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-chatgpt-1' },
      }),
    });
    const settings = store();

    const view = await signInWithChatGpt(settings, {
      tokenUrl,
      timeoutMs: 5_000,
      openUrl: async (url) => {
        const auth = new URL(url);
        expect(auth.origin + auth.pathname).toBe('https://auth.openai.com/oauth/authorize');
        expect(auth.searchParams.get('redirect_uri')).toBe(CODEX_REDIRECT_URI);
        expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
        expect(auth.searchParams.get('client_id')).toBeTruthy();
        const response = await fetch(
          `http://127.0.0.1:${CODEX_CALLBACK_PORT}/auth/callback?code=auth-code-1&state=${auth.searchParams.get('state')}`,
        );
        expect(response.status).toBe(200);
        const posted = form(tokens.requests[0]?.body);
        expect(posted.get('grant_type')).toBe('authorization_code');
        expect(posted.get('code')).toBe('auth-code-1');
        expect(posted.get('redirect_uri')).toBe(CODEX_REDIRECT_URI);
        expect(posted.get('client_id')).toBe(auth.searchParams.get('client_id'));
        const verifier = posted.get('code_verifier') ?? '';
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
      },
    });

    expect(view.chatgpt).toEqual({ signedIn: true, accountLabel: 'ada@example.com' });
    expect(JSON.stringify(view)).not.toContain(accessToken);
    expect(JSON.stringify(view)).not.toContain(refreshToken);
    const session = settings.getChatGptSession();
    expect(session).toMatchObject({
      accessToken,
      refreshToken,
      accountId: 'acct-chatgpt-1',
      accountLabel: 'ada@example.com',
    });
    const disk = JSON.parse(readFileSync(file, 'utf8')) as {
      chatgpt: { accessToken: string; refreshToken: string };
    };
    expect(disk.chatgpt.accessToken).toBe(reversingCipher.encrypt(accessToken));
    expect(disk.chatgpt.refreshToken).toBe(reversingCipher.encrypt(refreshToken));
    expect(readFileSync(file, 'utf8')).not.toContain(accessToken);
    expect(readFileSync(file, 'utf8')).not.toContain(refreshToken);
    expect(new SettingsStore(file, reversingCipher).getChatGptSession()?.accessToken).toBe(accessToken);

    const mismatchAccess = 'codex-access-login-after-mismatch';
    const mismatchRefresh = 'codex-refresh-login-after-mismatch';
    tokens.queueJson(200, {
      access_token: mismatchAccess,
      refresh_token: mismatchRefresh,
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: jwt({ chatgpt_account_id: 'acct-after-mismatch' }),
    });
    const mismatched = new SettingsStore(join(dir, 'mismatch.json'), reversingCipher);
    const mismatchView = await signInWithChatGpt(mismatched, {
      tokenUrl,
      timeoutMs: 5_000,
      openUrl: async (url) => {
        const auth = new URL(url);
        const state = auth.searchParams.get('state');
        const stray = await fetch(
          `http://127.0.0.1:${CODEX_CALLBACK_PORT}/auth/callback?code=other-code&state=${state}no`,
        );
        expect(stray.status).toBe(400);
        expect(tokens.requests).toHaveLength(1);
        const matching = await fetch(
          `http://127.0.0.1:${CODEX_CALLBACK_PORT}/auth/callback?code=auth-code-2&state=${state}`,
        );
        expect(matching.status).toBe(200);
      },
    });
    expect(mismatchView.chatgpt.signedIn).toBe(true);
    expect(mismatched.getChatGptSession()).toMatchObject({
      accessToken: mismatchAccess,
      refreshToken: mismatchRefresh,
      accountId: 'acct-after-mismatch',
    });
    expect(tokens.requests).toHaveLength(2);
    expect(form(tokens.requests[1]?.body).get('code')).toBe('auth-code-2');

    const abandoned = new SettingsStore(join(dir, 'abandoned.json'), reversingCipher);
    await expect(signInWithChatGpt(abandoned, { tokenUrl, timeoutMs: 200, openUrl: () => undefined })).rejects.toThrow(
      /not finished/,
    );
    expect(abandoned.getChatGptSession()).toBeNull();
    expect(tokens.requests).toHaveLength(2);

    const signedOut = signOutChatGpt(settings);
    expect(signedOut.chatgpt).toEqual({ signedIn: false, accountLabel: null });
    expect(settings.getChatGptSession()).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8')).chatgpt).toBeUndefined();
    expect(readFileSync(file, 'utf8')).not.toContain(accessToken);
    expect(readFileSync(file, 'utf8')).not.toContain(refreshToken);
  });

  it('replaces a sign-in that is still waiting', async () => {
    const accessToken = 'codex-access-replaced-login';
    const refreshToken = 'codex-refresh-replaced-login';
    tokens.queueJson(200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: jwt({ email: 'second@example.com', chatgpt_account_id: 'acct-second' }),
    });
    const firstStore = new SettingsStore(join(dir, 'first-login.json'), reversingCipher);
    const secondStore = new SettingsStore(join(dir, 'second-login.json'), reversingCipher);
    let firstOpened: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      firstOpened = resolve;
    });
    const first = signInWithChatGpt(firstStore, {
      tokenUrl,
      timeoutMs: 60_000,
      openUrl: () => firstOpened(),
    });
    await opened;
    const firstFailed = expect(first).rejects.toThrow(/replaced by a new attempt/);
    const second = await signInWithChatGpt(secondStore, {
      tokenUrl,
      timeoutMs: 5_000,
      openUrl: async (url) => {
        const state = new URL(url).searchParams.get('state');
        const response = await fetch(
          `http://127.0.0.1:${CODEX_CALLBACK_PORT}/auth/callback?code=second-code&state=${state}`,
        );
        expect(response.status).toBe(200);
      },
    });
    await firstFailed;
    expect(firstStore.getChatGptSession()).toBeNull();
    expect(second.chatgpt).toEqual({ signedIn: true, accountLabel: 'second@example.com' });
    expect(secondStore.getChatGptSession()?.accessToken).toBe(accessToken);
    expect(tokens.requests).toHaveLength(1);
    expect(form(tokens.requests[0]?.body).get('code')).toBe('second-code');
  });

  it('reports a bind failure and stores nothing when port 1455 is taken', async () => {
    const blocker = createServer((_req, res) => {
      res.writeHead(200).end('busy');
    });
    await new Promise<void>((resolve) => blocker.listen(CODEX_CALLBACK_PORT, '127.0.0.1', resolve));
    try {
      const settings = store();
      await expect(
        signInWithChatGpt(settings, { tokenUrl, timeoutMs: 2_000, openUrl: () => undefined }),
      ).rejects.toThrow(/1455/);
      expect(settings.getChatGptSession()).toBeNull();
      expect(tokens.requests).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('wires Sign in with ChatGPT and sign-out without placing tokens in the dialog', () => {
    const dialogs = readFileSync(join(process.cwd(), 'src/renderer/src/views/dialogs.ts'), 'utf8');
    const app = readFileSync(join(process.cwd(), 'src/renderer/src/app.ts'), 'utf8');
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(dialogs).toContain('Sign in with ChatGPT');
    expect(dialogs).toContain('Sign out');
    expect(dialogs).toContain('actions.signInChatGpt');
    expect(dialogs).toContain('actions.signOutChatGpt');
    expect(dialogs).not.toMatch(/accessToken|refreshToken/);
    expect(app).toContain("api.invoke('chatgpt:sign-in')");
    expect(app).toContain("api.invoke('chatgpt:sign-out')");
    expect(main).toContain("handle('chatgpt:sign-in'");
    expect(main).toContain("handle('chatgpt:sign-out'");
  });
});

describe('ChatGPT Codex request', () => {
  let dir: string;
  let responses: MockApiServer;
  let codexUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-codex-request-'));
    responses = new MockApiServer();
    codexUrl = await responses.start();
    vi.stubEnv('PATCH_TEST_CODEX_URL', codexUrl);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await responses.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends an official turn with the session bearer and stops doing so after sign-out', async () => {
    const accessToken = 'codex-access-request-aa11';
    const accountId = 'acct-request-1';
    const settings = new SettingsStore(join(dir, 'settings.json'), reversingCipher);
    settings.setChatGptSession({
      accessToken,
      refreshToken: 'codex-refresh-request-bb22',
      accountId,
      accountLabel: 'ada@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    responses.queueSse(textEvents('Hello from Codex'));
    const llm = new LlmService(settings);
    const conversation = llm.createConversation('gpt-6-sol');
    conversation.addUserMessage({ text: 'hi' });
    const first = turn();
    const result = await conversation.runTurn(first);

    expect(result.text).toBe('Hello from Codex');
    expect(first.text.join('')).toBe('Hello from Codex');
    expect(codexResponsesBaseUrl()).toBe(codexUrl);
    expect(CODEX_RESPONSES_BASE_URL).toBe('https://chatgpt.com/backend-api/codex');
    expect(responses.requests).toHaveLength(1);
    const request = responses.requests[0]!;
    expect(request.path).toBe('/responses');
    expect(request.headers.authorization).toBe(`Bearer ${accessToken}`);
    expect(request.headers['chatgpt-account-id']).toBe(accountId);
    expect(request.headers.authorization).not.toContain('codex-session');
    expect(request.body).not.toHaveProperty('truncation');
    expect(request.body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });

    // Restore uses the current credential route, not a backend persisted with the history.
    responses.queueSse(textEvents('Hello again from Codex'));
    const restored = llm.restoreConversation(conversation.serialize());
    restored.addUserMessage({ text: 'again' });
    expect((await restored.runTurn(turn())).text).toBe('Hello again from Codex');
    expect(responses.requests[1]!.body).not.toHaveProperty('truncation');
    expect(responses.requests[1]!.headers.authorization).toBe(`Bearer ${accessToken}`);

    signOutChatGpt(settings);
    conversation.addUserMessage({ text: 'again' });
    await expect(conversation.runTurn(turn())).rejects.toThrow(/ChatGPT|API key/);
    expect(responses.requests).toHaveLength(2);
    // createConversation throws the missing-credential error before any request.
    expect(() => llm.createConversation('gpt-6-sol')).toThrow(/ChatGPT|API key/);
    expect(responses.requests).toHaveLength(2);
  });
});

describe('ChatGPT Codex refresh', () => {
  let dir: string;
  let responses: MockApiServer;
  let tokens: MockApiServer;
  let logFile: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-codex-refresh-'));
    responses = new MockApiServer();
    tokens = new MockApiServer();
    logFile = join(dir, 'app.log.jsonl');
    vi.stubEnv('PATCH_TEST_CODEX_URL', await responses.start());
    vi.stubEnv('PATCH_TEST_CODEX_TOKEN_URL', await tokens.start());
    appLog.setFile(logFile);
  });

  afterEach(async () => {
    appLog.setFile(null);
    vi.unstubAllEnvs();
    await Promise.all([responses.stop(), tokens.stop()]);
    rmSync(dir, { recursive: true, force: true });
  });

  function logged(): string {
    return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  }

  it('refreshes an expired access token once and rotates the refresh token', async () => {
    const access1 = 'codex-access-old-1111';
    const refresh1 = 'codex-refresh-old-2222';
    const access2 = 'codex-access-new-3333';
    const refresh2 = 'codex-refresh-new-4444';
    const access3 = 'codex-access-newer-5555';
    const refresh3 = 'codex-refresh-newer-6666';
    const settings = new SettingsStore(join(dir, 'settings.json'), reversingCipher);
    settings.setChatGptSession({
      accessToken: access1,
      refreshToken: refresh1,
      accountId: 'acct-refresh-1',
      accountLabel: 'ada@example.com',
      expiresAt: Date.now() - 1_000,
    });
    tokens.queueJson(200, { access_token: access2, refresh_token: refresh2, expires_in: 0, token_type: 'Bearer' });
    tokens.queueJson(200, { access_token: access3, refresh_token: refresh3, expires_in: 3600, token_type: 'Bearer' });
    responses.queueSse(textEvents('after refresh'));
    responses.queueSse(textEvents('after second refresh'));
    const conversation = new LlmService(settings).createConversation('gpt-6-sol');
    conversation.addUserMessage({ text: 'one' });
    const first = await conversation.runTurn(turn());
    expect(first.text).toBe('after refresh');
    expect(form(tokens.requests[0]?.body).get('refresh_token')).toBe(refresh1);
    expect(responses.requests[0]?.headers.authorization).toBe(`Bearer ${access2}`);
    expect(settings.getChatGptSession()?.refreshToken).toBe(refresh2);

    conversation.addUserMessage({ text: 'two' });
    const second = await conversation.runTurn(turn());
    expect(second.text).toBe('after second refresh');
    expect(tokens.requests).toHaveLength(2);
    expect(form(tokens.requests[1]?.body).get('refresh_token')).toBe(refresh2);
    expect(responses.requests[1]?.headers.authorization).toBe(`Bearer ${access3}`);
    expect(settings.getChatGptSession()?.refreshToken).toBe(refresh3);
    const lines = logged();
    for (const secret of [access1, refresh1, access2, refresh2, access3, refresh3]) {
      expect(lines).not.toContain(secret);
    }
    expect(JSON.stringify(settings.view())).not.toContain(access3);
    expect(JSON.stringify(settings.view())).not.toContain(refresh3);
    expect(settings.view().chatgpt.signedIn).toBe(true);
  });

  it('fails a revoked refresh as sign-in required and does not refresh again', async () => {
    const accessToken = 'codex-access-revoked-aaaa';
    const refreshToken = 'codex-refresh-revoked-bbbb';
    const settings = new SettingsStore(join(dir, 'settings.json'), reversingCipher);
    settings.setChatGptSession({
      accessToken,
      refreshToken,
      accountId: 'acct-revoked',
      accountLabel: null,
      expiresAt: Date.now() - 5_000,
    });
    tokens.queueJson(400, { error: 'invalid_grant', error_description: 'refresh token has been revoked' });
    const conversation = new LlmService(settings).createConversation('gpt-6-sol');
    conversation.addUserMessage({ text: 'hi' });
    const attempt = turn();
    await expect(conversation.runTurn(attempt)).rejects.toBeInstanceOf(ChatGptSignInRequiredError);
    expect(attempt.text).toEqual([]);
    expect(responses.requests).toHaveLength(0);
    expect(tokens.requests).toHaveLength(1);
    expect(retryDecision(new ChatGptSignInRequiredError(), 0)).toBeNull();
    expect(settings.view().chatgpt.signedIn).toBe(false);
    expect(JSON.stringify(settings.view())).not.toContain(accessToken);
    expect(JSON.stringify(settings.view())).not.toContain(refreshToken);

    conversation.addUserMessage({ text: 'again' });
    await expect(conversation.runTurn(turn())).rejects.toThrow(/Sign in with ChatGPT|API key/);
    expect(tokens.requests).toHaveLength(1);
    expect(responses.requests).toHaveLength(0);
    const lines = logged();
    expect(lines).toContain('no longer valid');
    expect(lines).not.toContain(accessToken);
    expect(lines).not.toContain(refreshToken);
  });

  it('refreshes once when two turns ask together', async () => {
    const refresh1 = 'codex-refresh-shared-1111';
    const access2 = 'codex-access-shared-2222';
    const refresh2 = 'codex-refresh-shared-3333';
    const settings = new SettingsStore(join(dir, 'shared.json'), reversingCipher);
    settings.setChatGptSession({
      accessToken: 'codex-access-shared-0000',
      refreshToken: refresh1,
      accountId: 'acct-shared',
      accountLabel: null,
      expiresAt: Date.now() - 1_000,
    });
    tokens.queueJson(200, {
      access_token: access2,
      refresh_token: refresh2,
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: jwt({ chatgpt_account_id: 'acct-shared' }),
    });
    const tokenUrl = process.env.PATCH_TEST_CODEX_TOKEN_URL ?? '';
    const [first, second] = await Promise.all([
      ensureFreshCodexSession(settings, tokenUrl),
      ensureFreshCodexSession(settings, tokenUrl),
    ]);
    expect(tokens.requests).toHaveLength(1);
    expect(form(tokens.requests[0]?.body).get('refresh_token')).toBe(refresh1);
    expect(first.accessToken).toBe(access2);
    expect(second.accessToken).toBe(access2);
    expect(settings.getChatGptSession()?.refreshToken).toBe(refresh2);
  });

  it('does not restore a session signed out during refresh, or replace a newer sign-in', async () => {
    const settings = new SettingsStore(join(dir, 'late.json'), reversingCipher);
    const stale = {
      accessToken: 'codex-access-stale-aaaa',
      refreshToken: 'codex-refresh-stale-bbbb',
      accountId: 'acct-stale',
      accountLabel: null,
      expiresAt: Date.now() - 1_000,
    };
    settings.setChatGptSession(stale);
    let releaseRefresh: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    tokens.queueJsonWhen(gate, 200, {
      access_token: 'codex-access-late-cccc',
      refresh_token: 'codex-refresh-late-dddd',
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: jwt({ chatgpt_account_id: 'acct-stale' }),
    });
    const tokenUrl = process.env.PATCH_TEST_CODEX_TOKEN_URL ?? '';
    const refreshing = ensureFreshCodexSession(settings, tokenUrl);
    await waitFor(() => tokens.requests.length === 1);
    signOutChatGpt(settings);
    releaseRefresh();
    await expect(refreshing).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(settings.getChatGptSession()).toBeNull();

    settings.setChatGptSession(stale);
    let releaseFailure: () => void = () => undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    tokens.queueJsonWhen(failureGate, 400, {
      error: 'invalid_grant',
      error_description: 'refresh_token_reused',
    });
    const failing = ensureFreshCodexSession(settings, tokenUrl);
    await waitFor(() => tokens.requests.length === 2);
    const newer = {
      accessToken: 'codex-access-newer-login',
      refreshToken: 'codex-refresh-newer-login',
      accountId: 'acct-newer',
      accountLabel: 'new@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    settings.setChatGptSession(newer);
    releaseFailure();
    await expect(failing).resolves.toMatchObject({ accessToken: newer.accessToken, refreshToken: newer.refreshToken });
    expect(settings.getChatGptSession()).toMatchObject(newer);

    let releaseSuccess: () => void = () => undefined;
    const successGate = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    settings.setChatGptSession({ ...stale, expiresAt: Date.now() - 1_000 });
    tokens.queueJsonWhen(successGate, 200, {
      access_token: 'codex-access-should-not-stick',
      refresh_token: 'codex-refresh-should-not-stick',
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: jwt({ chatgpt_account_id: 'acct-stale' }),
    });
    const overwriting = ensureFreshCodexSession(settings, tokenUrl);
    await waitFor(() => tokens.requests.length === 3);
    settings.setChatGptSession(newer);
    releaseSuccess();
    await expect(overwriting).resolves.toMatchObject({ refreshToken: newer.refreshToken });
    expect(settings.getChatGptSession()?.refreshToken).toBe(newer.refreshToken);
    expect(settings.getChatGptSession()?.accessToken).toBe(newer.accessToken);
  });
});

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 2_000) throw new Error('timed out waiting for the token request');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ChatGPT Codex precedence', () => {
  let platform: MockApiServer;
  let custom: MockApiServer;
  let codex: MockApiServer;
  let platformUrl: string;
  let customUrl: string;
  let codexUrl: string;
  let dir: string;
  let Service: typeof LlmService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-codex-route-'));
    platform = new MockApiServer();
    custom = new MockApiServer();
    codex = new MockApiServer();
    platformUrl = await platform.start();
    customUrl = await custom.start();
    codexUrl = await codex.start();
    vi.stubEnv('PATCH_TEST_OPENAI_URL', platformUrl);
    vi.stubEnv('PATCH_TEST_CODEX_URL', codexUrl);
    vi.resetModules();
    // The PATCH_TEST_* hooks work only in a development build (#64); the fresh modules start as a packaged one.
    (await import('./endpoints')).setPackagedBuild(false);
    Service = (await import('./index')).LlmService;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await Promise.all([platform.stop(), custom.stop(), codex.stop()]);
    rmSync(dir, { recursive: true, force: true });
  });

  function settings(name: string): SettingsStore {
    return new SettingsStore(join(dir, `${name}.json`), reversingCipher);
  }

  async function answer(server: MockApiServer, text: string): Promise<void> {
    server.queueSse(textEvents(text));
  }

  it('keeps the API key on the Responses API and the custom base URL ahead of a ChatGPT session', async () => {
    const keyOnly = settings('key-only');
    keyOnly.setSecret('openaiApiKey', 'sk-platform-key');
    await answer(platform, 'from platform');
    const platformChat = new Service(keyOnly).createConversation('gpt-6-sol');
    platformChat.addUserMessage({ text: 'hi' });
    expect((await platformChat.runTurn(turn())).text).toBe('from platform');
    expect(platform.requests[0]?.path).toBe('/responses');
    expect(platform.requests[0]?.headers.authorization).toBe('Bearer sk-platform-key');
    expect(codex.requests).toHaveLength(0);
    expect(String(platform.requests[0]?.headers.host)).not.toContain('chatgpt.com');

    const both = settings('custom');
    both.setSecret('openaiApiKey', 'sk-custom-key');
    both.update({ openaiBaseUrl: customUrl });
    both.setChatGptSession({
      accessToken: 'codex-access-custom-zzzz',
      refreshToken: 'codex-refresh-custom-yyyy',
      accountId: 'acct-custom',
      accountLabel: null,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    custom.queueSse([
      {
        data: {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'gpt-6-sol',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'from custom' }, finish_reason: null }],
        },
      },
      {
        data: {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'gpt-6-sol',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      },
      { data: '[DONE]' },
    ]);
    const customChat = new Service(both).createConversation('gpt-6-sol');
    customChat.addUserMessage({ text: 'hi' });
    expect((await customChat.runTurn(turn())).text).toBe('from custom');
    expect(custom.requests).toHaveLength(1);
    expect(custom.requests[0]?.path).toContain('/chat/completions');
    expect(custom.requests[0]?.headers.authorization).toBe('Bearer sk-custom-key');
    expect(custom.requests[0]?.headers.authorization).not.toContain('codex-access-custom-zzzz');
    expect(codex.requests).toHaveLength(0);
    expect(platform.requests).toHaveLength(1);

    const neither = settings('neither');
    expect(() => new Service(neither).createConversation('gpt-6-sol')).toThrow(/API key or sign in with ChatGPT/);
    expect(() => new Service(neither).createConversation('claude-opus-5-5')).toThrow(/Anthropic API key/);
    const sessionOnly = settings('session-only');
    sessionOnly.setChatGptSession({
      accessToken: 'codex-access-gate-qqqq',
      refreshToken: 'codex-refresh-gate-rrrr',
      accountId: 'acct-gate',
      accountLabel: null,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    expect(new Service(sessionOnly).createConversation('gpt-6-sol').provider).toBe('openai');
    expect(() => new Service(sessionOnly).createConversation('claude-opus-5-5')).toThrow(/Anthropic API key/);

    expect(
      chooseOpenAIRoute({
        openaiBaseUrl: '',
        apiKey: '',
        session: { accessToken: 'codex-access-gate-qqqq', accountId: 'acct-gate' },
      }),
    ).toEqual({
      kind: 'codex',
      baseUrl: CODEX_RESPONSES_BASE_URL,
      accessToken: 'codex-access-gate-qqqq',
      accountId: 'acct-gate',
    });
    expect(chooseOpenAIRoute({ openaiBaseUrl: '', apiKey: 'sk-platform-key', session: null })).toEqual({
      kind: 'platform',
      apiKey: 'sk-platform-key',
    });
  });
});
