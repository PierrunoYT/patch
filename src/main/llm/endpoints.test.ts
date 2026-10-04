import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicClient } from './anthropic';
import { CODEX_TOKEN_URL, codexTokenUrl } from './codex_auth';
import { ANTHROPIC_API_URL, OPENAI_API_URL, setPackagedBuild, testEndpoint } from './endpoints';
import { createOpenAIClient } from './openai';
import { CODEX_RESPONSES_BASE_URL, codexResponsesBaseUrl } from './openai_route';

// Keys must only reach the official endpoints or the base URL set in Settings, whatever the environment says (#64).
describe('API endpoints', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setPackagedBuild(true);
  });

  it('ignores the PATCH_TEST_* hooks in a packaged build, the default, and honors them in development', () => {
    vi.stubEnv('PATCH_TEST_ANTHROPIC_URL', 'http://evil.example');
    vi.stubEnv('PATCH_TEST_OPENAI_URL', 'http://evil.example');
    vi.stubEnv('PATCH_TEST_CODEX_URL', 'http://evil.example');
    vi.stubEnv('PATCH_TEST_CODEX_TOKEN_URL', 'http://evil.example/token');

    // Packaged until the main process says otherwise, so a missed setPackagedBuild call fails closed.
    expect(testEndpoint('PATCH_TEST_ANTHROPIC_URL')).toBeUndefined();
    expect(testEndpoint('PATCH_TEST_OPENAI_URL')).toBeUndefined();
    expect(codexResponsesBaseUrl()).toBe(CODEX_RESPONSES_BASE_URL);
    expect(codexTokenUrl()).toBe(CODEX_TOKEN_URL);

    setPackagedBuild(false);
    expect(testEndpoint('PATCH_TEST_ANTHROPIC_URL')).toBe('http://evil.example');
    expect(codexResponsesBaseUrl()).toBe('http://evil.example');
    expect(codexTokenUrl()).toBe('http://evil.example/token');
  });

  it('sends Claude requests to the official API, whatever ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN say', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://evil.example');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'someone-elses-token');
    const client = createAnthropicClient('sk-ant-user');
    expect(client.baseURL).toBe(ANTHROPIC_API_URL);
    expect(client.apiKey).toBe('sk-ant-user');
    expect(client.authToken).toBeNull();
    // A base URL the user set in Settings (or a test stand-in) is still used.
    expect(createAnthropicClient('sk-ant-user', 'http://localhost:1234').baseURL).toBe('http://localhost:1234');
  });

  it('sends OpenAI requests to the official API, whatever OPENAI_BASE_URL says', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://evil.example');
    expect(createOpenAIClient('sk-user').baseURL).toBe(OPENAI_API_URL);
    expect(createOpenAIClient('sk-user', '').baseURL).toBe(OPENAI_API_URL);
    expect(createOpenAIClient('sk-user', 'http://localhost:11434/v1').baseURL).toBe('http://localhost:11434/v1');
  });
});
