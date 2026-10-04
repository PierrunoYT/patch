import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChatSession } from '../agent/session';
import type { SettingsStore } from '../settings';
import type { LlmService as LlmServiceClass } from './index';
import { anthropicStream, MockApiServer } from './test_server';
import type { SerializedConversation } from './types';

function completion(title: string) {
  return {
    id: 'chatcmpl-summary',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: title }) } },
    ],
  };
}

describe('LlmService summarizer selection', () => {
  let standard: MockApiServer;
  let custom: MockApiServer;
  let customURL: string;
  let LlmService: typeof LlmServiceClass;

  beforeEach(async () => {
    standard = new MockApiServer();
    custom = new MockApiServer();
    const standardURL = await standard.start();
    customURL = await custom.start();
    vi.stubEnv('PATCH_TEST_OPENAI_URL', standardURL);
    vi.stubEnv('PATCH_TEST_ANTHROPIC_URL', standardURL);
    vi.resetModules();
    // The PATCH_TEST_* hooks work only in a development build (#64); the fresh modules start as a packaged one.
    (await import('./endpoints')).setPackagedBuild(false);
    ({ LlmService } = await import('./index'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await Promise.all([standard.stop(), custom.stop()]);
  });

  it('sends Claude chats and Claude background requests to the Claude base URL from Settings', async () => {
    const llm = new LlmService({
      get: () => ({ model: 'claude-opus-5-5', effort: 'high', openaiBaseUrl: '', anthropicBaseUrl: customURL }),
      getSecret: (key: string) => (key === 'anthropicApiKey' ? 'sk-ant-test' : ''),
      getChatGptSession: () => null,
    } as unknown as SettingsStore);
    custom.queueSse(anthropicStream([{ type: 'text', text: 'From the gateway.' }], 'end_turn'));
    const conversation = llm.createConversation();
    conversation.addUserMessage({ text: 'hi' });
    const result = await conversation.runTurn({
      system: 'sys',
      tools: [],
      signal: new AbortController().signal,
      callbacks: { onText() {} },
    });
    expect(result.text).toBe('From the gateway.');
    expect(custom.requests[0]!.path).toContain('/v1/messages');
    expect(custom.requests[0]!.headers['x-api-key']).toBe('sk-ant-test');
    // Not the test stand-in set in PATCH_TEST_ANTHROPIC_URL: Settings wins.
    expect(standard.requests).toHaveLength(0);
    // The small model for titles and compaction goes there too.
    expect(llm.smallModel(conversation)).not.toBeNull();
  });

  it('compacts a saved custom-only chat with its pinned model after the global selection changes', async () => {
    let model = 'local-model';
    const llm = new LlmService({
      get: () => ({ model, effort: 'high', openaiBaseUrl: customURL, anthropicBaseUrl: '' }),
      getSecret: (key: string) => (key === 'openaiApiKey' ? 'local-key' : ''),
      getChatGptSession: () => null,
    } as unknown as SettingsStore);
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index}: ${'x'.repeat(12_000)}`,
    }));
    const conversation = llm.restoreConversation({ provider: 'openai', api: 'chat', model, messages });
    model = 'claude-opus-5-5';
    custom.queueJson(200, completion('The saved conversation summary'));
    const session = new ChatSession({
      conversation,
      projectPath: '/project',
      system: 'sys',
      agentFile: null,
      tools: () => [],
      approvalMode: () => 'auto',
      smallModel: (chat) => llm.smallModel(chat),
      toolContext: () => {
        throw new Error('Compaction must not execute a tool');
      },
      onEvent() {},
      onChange() {},
    });

    await session.compact();

    expect(custom.requests[0]!.body.model).toBe('local-model');
    expect(custom.requests[0]!.body.response_format.type).toBe('json_schema');
    expect(standard.requests).toEqual([]);
    expect(conversation.serialize().compaction?.summary).toBe('The saved conversation summary');
    expect(conversation.serialize().messages).toEqual(messages);
  });

  it.each([
    { provider: 'openai', api: 'responses', model: 'gpt-6-sol', customURL: true, expected: 'gpt-6-luna' },
    { provider: 'openai', api: 'chat', model: 'gpt-6-sol', customURL: false, expected: 'gpt-6-luna' },
    { provider: 'anthropic', model: 'claude-opus-5-5', customURL: true, expected: 'claude-haiku-4-5' },
  ] as const)('retains the standard small model for $provider/$api chats', async (testCase) => {
    const llm = new LlmService({
      get: () => ({
        model: 'different-global-model',
        effort: 'high',
        openaiBaseUrl: testCase.customURL ? customURL : '',
        anthropicBaseUrl: '',
      }),
      getSecret: () => 'sk-test',
      getChatGptSession: () => null,
    } as unknown as SettingsStore);
    const saved: SerializedConversation = { ...testCase, messages: [] };
    const conversation = llm.restoreConversation(saved);
    if (testCase.provider === 'anthropic') {
      standard.queueJson(200, {
        id: 'msg-summary',
        type: 'message',
        role: 'assistant',
        model: testCase.expected,
        content: [{ type: 'text', text: JSON.stringify({ summary: 'Summary' }) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      });
    } else {
      standard.queueJson(200, completion('Summary'));
    }

    const result = await llm.smallModel(conversation)!.complete('Summarize', z.object({ summary: z.string() }));

    expect(result).toEqual({ summary: 'Summary' });
    expect(standard.requests[0]!.body.model).toBe(testCase.expected);
    expect(custom.requests).toEqual([]);
  });
});
