import { testEndpoint } from './endpoints';

// Which credential and URL an official or compatible OpenAI request uses.
// A custom base URL wins, then a ChatGPT session, then an API key.

export const CODEX_RESPONSES_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export interface OpenAIRouteSession {
  accessToken: string;
  accountId: string;
}

export type OpenAIRoute =
  | { kind: 'missing' }
  | { kind: 'compatible'; baseUrl: string; apiKey: string }
  | { kind: 'platform'; apiKey: string }
  | { kind: 'codex'; baseUrl: string; accessToken: string; accountId: string };

export function chooseOpenAIRoute(input: {
  openaiBaseUrl: string;
  apiKey: string;
  session: OpenAIRouteSession | null;
  codexBaseUrl?: string;
}): OpenAIRoute {
  const custom = input.openaiBaseUrl.trim();
  const apiKey = input.apiKey.trim();
  if (custom) return apiKey ? { kind: 'compatible', baseUrl: custom, apiKey } : { kind: 'missing' };
  const session = input.session;
  if (session?.accessToken && session.accountId) {
    return {
      kind: 'codex',
      baseUrl: input.codexBaseUrl ?? CODEX_RESPONSES_BASE_URL,
      accessToken: session.accessToken,
      accountId: session.accountId,
    };
  }
  if (apiKey) return { kind: 'platform', apiKey };
  return { kind: 'missing' };
}

// Tests point this at a local stand-in; packaged builds ignore it (endpoints.ts, #64), so chats go to the Codex ChatGPT
// backend.
export function codexResponsesBaseUrl(): string {
  return testEndpoint('PATCH_TEST_CODEX_URL') || CODEX_RESPONSES_BASE_URL;
}
