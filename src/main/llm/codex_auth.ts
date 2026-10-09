import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import OpenAI from 'openai';
import type { SettingsStore, ChatGptSession } from '../settings';
import { appLog } from '../app_log';
import { testEndpoint } from './endpoints';
import { OpenAIResponsesConversation } from './openai_responses';
import {
  ChatGptSignInRequiredError,
  MissingApiKeyError,
  type CompactionPlan,
  type Conversation,
  type SerializedConversation,
  type ToolResult,
  type TurnRequest,
  type TurnResult,
  type UserInput,
} from './types';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
// The redirect URI says localhost, which a browser may resolve to either loopback address, so listen on both.
export const CODEX_CALLBACK_HOSTS = ['127.0.0.1', '::1'] as const;
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = '/auth/callback';
export const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

// Refresh a little before the access token expires so a request does not leave with a token that is about to die.
export const CODEX_REFRESH_SKEW_MS = 60_000;

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class CodexAuthError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function codexAuthorizeUrl(input: { state: string; challenge: string; authUrl?: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'patch',
  });
  return `${input.authUrl ?? CODEX_AUTHORIZE_URL}?${params.toString()}`;
}

// Tests point this at a local stand-in; packaged builds ignore it (endpoints.ts, #64).
export function codexTokenUrl(): string {
  return testEndpoint('PATCH_TEST_CODEX_TOKEN_URL') || CODEX_TOKEN_URL;
}

export function accessTokenNeedsRefresh(expiresAt: number, now: number): boolean {
  return expiresAt - now <= CODEX_REFRESH_SKEW_MS;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function extractAccountId(idToken?: string, accessToken?: string): string | null {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    const top = usableAccountId(payload.chatgpt_account_id);
    if (top) return top;
    const namespaced = payload['https://api.openai.com/auth'];
    if (namespaced && typeof namespaced === 'object' && !Array.isArray(namespaced)) {
      const accountId = usableAccountId((namespaced as Record<string, unknown>).chatgpt_account_id);
      if (accountId) return accountId;
    }
  }
  return null;
}

export function extractEmail(idToken?: string, accessToken?: string): string | null {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    const email = payload?.email;
    if (typeof email === 'string' && email.trim()) return email.trim();
  }
  return null;
}

function usableAccountId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface CodexLoginOptions {
  openUrl: (url: string) => void | Promise<void>;
  tokenUrl?: string;
  timeoutMs?: number;
}

interface PendingLogin {
  cancel: (error: Error) => void;
  done: Promise<void>;
}

// The login whose callback server is bound to port 1455, if one is waiting.
let pendingLogin: PendingLogin | null = null;

// Browser login: open the Codex authorize URL, accept the loopback callback only for this login's state, and
// exchange the code with this login's PKCE verifier. Nothing is stored here; the caller stores a resolved session.
// A new attempt cancels a login that is still waiting, so closing the browser does not block the button.
export function runCodexBrowserLogin(options: CodexLoginOptions): Promise<ChatGptSession> {
  const previous = pendingLogin;
  if (previous) {
    pendingLogin = null;
    previous.cancel(new Error('Sign in with ChatGPT was replaced by a new attempt.'));
    return previous.done.then(() => runCodexBrowserLogin(options));
  }
  return listenForCodexCallback(options);
}

export async function signInWithChatGpt(
  settings: SettingsStore,
  options: CodexLoginOptions,
): Promise<ReturnType<SettingsStore['view']>> {
  const session = await runCodexBrowserLogin(options);
  return settings.setChatGptSession(session);
}

export function signOutChatGpt(settings: SettingsStore): ReturnType<SettingsStore['view']> {
  return settings.setChatGptSession(null);
}

function listenForCodexCallback(options: CodexLoginOptions): Promise<ChatGptSession> {
  const state = randomBytes(32).toString('base64url');
  const pkce = createPkce();
  const authorize = codexAuthorizeUrl({ state, challenge: pkce.challenge });
  const tokenUrl = options.tokenUrl ?? codexTokenUrl();
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let closeDone: () => void = () => undefined;
    const done = new Promise<void>((resolveDone) => {
      closeDone = resolveDone;
    });
    const servers = CODEX_CALLBACK_HOSTS.map(() =>
      createServer((request, response) => {
        void onRequest(request, response);
      }),
    );
    const timer = setTimeout(() => {
      settle(new Error('Sign in with ChatGPT was not finished. Try again.'));
    }, timeoutMs);

    const settle = (error: Error | null, session?: ChatGptSession) => {
      if (settled) return;
      settled = true;
      if (pendingLogin?.done === done) pendingLogin = null;
      clearTimeout(timer);
      void Promise.all(servers.map(closeServer)).then(() => {
        closeDone();
        if (error) reject(error);
        else if (session) resolve(session);
        else reject(new Error('Sign in with ChatGPT could not be completed.'));
      });
    };

    pendingLogin = { cancel: (error) => settle(error), done };

    const onRequest = async (request: IncomingMessage, response: ServerResponse) => {
      if (settled) {
        response.writeHead(409).end('Sign-in already finished.');
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url ?? '/', `http://127.0.0.1:${CODEX_CALLBACK_PORT}`);
      } catch {
        response.writeHead(400).end('Bad request');
        return;
      }
      if (url.pathname !== CODEX_CALLBACK_PATH) {
        response.writeHead(404).end('Not found');
        return;
      }
      const gotState = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const oauthError = url.searchParams.get('error') ?? '';
      // An old tab or another process can hit this port. Answer it and keep waiting for this login.
      if (!sameSecret(gotState, state)) {
        response
          .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          .end('This sign-in did not match the one Patch started.');
        return;
      }
      if (oauthError || !code) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Sign-in was not completed.');
        settle(new Error('Sign in with ChatGPT was not completed.'));
        return;
      }
      try {
        const session = await exchangeAuthorizationCode({ code, verifier: pkce.verifier, tokenUrl });
        response
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
          .end('<!doctype html><title>Signed in</title><p>Signed in with ChatGPT. You can close this window.</p>');
        settle(null, session);
      } catch (error) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('Sign-in could not be completed.');
        settle(error instanceof Error ? error : new Error('Sign in with ChatGPT could not be completed.'));
      }
    };

    // Every address is bound before the browser opens. A taken port fails the sign-in; a host without IPv6 skips ::1.
    let waiting = servers.length;
    const bound = () => {
      if (--waiting === 0 && !settled) {
        Promise.resolve(options.openUrl(authorize)).catch((error: unknown) => {
          settle(error instanceof Error ? error : new Error('Could not open the ChatGPT sign-in page.'));
        });
      }
    };
    servers.forEach((server, index) => {
      const host = CODEX_CALLBACK_HOSTS[index];
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          settle(new Error('Sign in with ChatGPT needs port 1455 on localhost, and that port is already in use.'));
          return;
        }
        if (host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) {
          bound();
          return;
        }
        settle(new Error('Sign in with ChatGPT could not listen for the browser.'));
      });
      server.listen(CODEX_CALLBACK_PORT, host, bound);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) resolve();
    else server.close(() => resolve());
  });
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  verifier: string;
  tokenUrl: string;
}): Promise<ChatGptSession> {
  return requestToken(
    input.tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: input.code,
      redirect_uri: CODEX_REDIRECT_URI,
      code_verifier: input.verifier,
    }),
    null,
  );
}

export async function refreshCodexSession(session: ChatGptSession, tokenUrl: string): Promise<ChatGptSession> {
  return requestToken(
    tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: session.refreshToken,
    }),
    session,
  );
}

// Callers that refresh the same token share one request. OpenAI accepts a refresh token once.
let refreshFlight: { token: string; promise: Promise<ChatGptSession> } | null = null;

// One refresh when the access token is expired or near expiry. A permanent failure clears the session only when
// it still holds the refresh token that failed. A result is saved only in that same case, so a sign-out or a
// newer sign-in that landed while the request was in flight is left as the user left it.
export async function ensureFreshCodexSession(
  settings: SettingsStore,
  tokenUrl = codexTokenUrl(),
  force = false,
): Promise<ChatGptSession> {
  const session = settings.getChatGptSession();
  if (!session) throw new MissingApiKeyError('openai');
  if (!force && !accessTokenNeedsRefresh(session.expiresAt, Date.now())) return session;
  if (refreshFlight?.token === session.refreshToken) return refreshFlight.promise;

  const flight = refreshAndStore(settings, session, tokenUrl);
  refreshFlight = { token: session.refreshToken, promise: flight };
  try {
    return await flight;
  } finally {
    if (refreshFlight?.promise === flight) refreshFlight = null;
  }
}

async function refreshAndStore(
  settings: SettingsStore,
  session: ChatGptSession,
  tokenUrl: string,
): Promise<ChatGptSession> {
  const usedRefresh = session.refreshToken;
  try {
    const next = await refreshCodexSession(session, tokenUrl);
    if (settings.getChatGptSession()?.refreshToken !== usedRefresh) return currentSession(settings);
    settings.setChatGptSession(next);
    return next;
  } catch (error) {
    if (error instanceof CodexAuthError && error.permanent) {
      if (settings.getChatGptSession()?.refreshToken === usedRefresh) {
        settings.setChatGptSession(null);
        appLog.error('chatgpt', 'ChatGPT sign-in is no longer valid. Sign in again in Settings.');
      }
      const current = settings.getChatGptSession();
      if (current && current.refreshToken !== usedRefresh) return current;
      throw new ChatGptSignInRequiredError();
    }
    throw error;
  }
}

function currentSession(settings: SettingsStore): ChatGptSession {
  const current = settings.getChatGptSession();
  if (!current) throw new MissingApiKeyError('openai');
  return current;
}

async function requestToken(
  tokenUrl: string,
  body: URLSearchParams,
  previous: ChatGptSession | null,
): Promise<ChatGptSession> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
  } catch {
    throw new CodexAuthError('ChatGPT sign-in could not reach the token service.', false, null);
  }
  const text = await response.text();
  if (!response.ok) {
    const permanent = isPermanentTokenFailure(response.status, tokenErrorBlob(text));
    throw new CodexAuthError(
      permanent ? 'ChatGPT sign-in was rejected.' : `ChatGPT token request failed (${response.status}).`,
      permanent,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexAuthError('ChatGPT token response was not valid.', false, response.status);
  }
  return sessionFromTokenResponse(parsed, previous);
}

function tokenErrorBlob(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const error = typeof parsed.error === 'string' ? parsed.error : '';
    const description = typeof parsed.error_description === 'string' ? parsed.error_description : '';
    return `${error} ${description}`;
  } catch {
    return '';
  }
}

const PERMANENT_TOKEN_ERROR = /invalid_grant|revoked|exhausted|refresh_token_reused|refresh_token_invalidated/i;

function isPermanentTokenFailure(status: number, blob: string): boolean {
  return status >= 400 && status < 500 && PERMANENT_TOKEN_ERROR.test(blob);
}

function sessionFromTokenResponse(parsed: unknown, previous: ChatGptSession | null): ChatGptSession {
  if (!parsed || typeof parsed !== 'object')
    throw new CodexAuthError('ChatGPT token response was not valid.', false, null);
  const data = parsed as Record<string, unknown>;
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const refreshFromBody = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  const refreshToken = refreshFromBody || previous?.refreshToken || '';
  if (!accessToken || !refreshToken) {
    throw new CodexAuthError('ChatGPT token response was missing credentials.', false, null);
  }
  const idToken = typeof data.id_token === 'string' ? data.id_token : undefined;
  const accountId = extractAccountId(idToken, accessToken) ?? previous?.accountId ?? '';
  if (!accountId) throw new CodexAuthError('ChatGPT sign-in did not include an account id.', false, null);
  const expiresIn =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in >= 0
      ? data.expires_in
      : 3600;
  const computed = Date.now() + expiresIn * 1000;
  const accountLabel = extractEmail(idToken, accessToken) ?? previous?.accountLabel ?? null;
  return {
    accessToken,
    refreshToken,
    accountId,
    accountLabel,
    expiresAt: Number.isFinite(computed) ? computed : Date.now() + 3600 * 1000,
  };
}

export function createCodexOpenAIClient(baseURL: string, auth: { accessToken(): string; accountId(): string }): OpenAI {
  return new OpenAI({
    // The real bearer is set per request. This placeholder is not a credential.
    apiKey: 'codex-session',
    baseURL,
    maxRetries: 0,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${auth.accessToken()}`);
      headers.set('ChatGPT-Account-ID', auth.accountId());
      return fetch(input, { ...init, headers });
    },
  });
}

// Refreshes the ChatGPT session once before each Responses request, then uses that access token. A 401 (a token
// revoked before it expired) refreshes it once more and repeats the request.
export class CodexAuthedConversation implements Conversation {
  readonly provider = 'openai' as const;

  constructor(
    private readonly inner: OpenAIResponsesConversation,
    private readonly prepare: (force?: boolean) => Promise<void>,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  addUserMessage(input: UserInput): void {
    this.inner.addUserMessage(input);
  }

  addToolResults(results: ToolResult[]): void {
    this.inner.addToolResults(results);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    await this.prepare();
    try {
      return await this.inner.runTurn(request);
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status !== 401 || request.signal.aborted) throw error;
      await this.prepare(true);
      return this.inner.runTurn(request);
    }
  }

  serialize(): SerializedConversation {
    return this.inner.serialize();
  }

  planCompaction(): CompactionPlan | null {
    return this.inner.planCompaction();
  }

  applyCompaction(summary: string, keepFrom: number): void {
    this.inner.applyCompaction(summary, keepFrom);
  }

  hasPendingToolCalls(): boolean {
    return this.inner.hasPendingToolCalls();
  }
}
