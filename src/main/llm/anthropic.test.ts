import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { retryDecision } from '../agent/retry';
import { appLog } from '../app_log';
import { editFileTool } from '../tools/files';
import { toToolSpecs } from '../tools/registry';
import { AnthropicCompletionClient, AnthropicConversation, createAnthropicClient } from './anthropic';
import { anthropicStream, MockApiServer } from './test_server';
import type { ToolSpec, TurnRequest } from './types';

const readFileTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  schema: z.object({ path: z.string() }),
};

function request(overrides: Partial<TurnRequest> = {}): TurnRequest & { streamed: string[] } {
  const streamed: string[] = [];
  return {
    system: 'You are a test.',
    tools: [readFileTool],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => streamed.push(delta) },
    streamed,
    ...overrides,
  };
}

describe('AnthropicConversation', () => {
  let server: MockApiServer;
  let baseURL: string;

  beforeEach(async () => {
    server = new MockApiServer();
    baseURL = await server.start();
  });

  afterEach(() => server.stop());

  it('streams text and returns tool calls', async () => {
    server.queueSse(
      anthropicStream(
        [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
        'tool_use',
      ),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });

    const req = request();
    const result = await conversation.runTurn(req);

    expect(req.streamed.join('')).toBe('Let me look.');
    expect(result.text).toBe('Let me look.');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 3 });
    expect(result.contextTokens).toBe(17);
  });

  it('sends no trace of a user message the API refused once it is discarded (#240)', async () => {
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    server.queueJson(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad image' } });
    conversation.addUserMessage({ text: 'look', images: [{ mediaType: 'image/png', base64: 'AAAA' }] });
    await expect(conversation.runTurn(request())).rejects.toMatchObject({ status: 400 });
    conversation.discardLastUserMessage();

    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    conversation.addUserMessage({ text: 'again' });
    await conversation.runTurn(request());

    const sent = JSON.stringify(server.requests.at(-1)?.body);
    expect(sent).not.toContain('"image"');
    expect(sent).toContain('again');
  });

  it('keeps the cache warm by re-sending the last request without output, ending with a placeholder', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'Here is the answer.' }], 'end_turn'));
    server.queueJson(200, {
      id: 'msg_keep',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 8466, cache_creation_input_tokens: 4 },
    });
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    const signal = new AbortController().signal;
    // Nothing to keep warm before the first request.
    expect(await conversation.keepCacheWarm(signal)).toBeNull();
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const usage = await conversation.keepCacheWarm(signal);
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 0, cacheReadTokens: 8466, cacheWriteTokens: 4 });

    const turn = server.requests[0]!.body;
    const keep = server.requests[1]!.body;
    // The same prefix as the real request (tools, system, thinking, effort, betas), so it reads the same entries.
    for (const field of ['model', 'tools', 'system', 'thinking', 'output_config', 'context_management', 'fallbacks']) {
      expect(keep[field]).toEqual(turn[field]);
    }
    // No output and no stream; the API rejects a request ending with the assistant reply, so a placeholder ends it,
    // and the breakpoint is on the reply instead of the top-level automatic one, which would key on the placeholder.
    expect(keep.max_tokens).toBe(0);
    expect(keep.stream).toBe(false);
    expect(keep.cache_control).toBeUndefined();
    const messages = keep.messages as Array<{ role: string; content: unknown }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'keep-alive' });
    const reply = messages.at(-2) as { role: string; content: Array<Record<string, unknown>> };
    expect(reply.role).toBe('assistant');
    expect(reply.content.at(-1)).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    // The stored history is unchanged: no placeholder and no breakpoint left behind.
    expect(JSON.stringify(conversation.serialize().messages)).not.toContain('keep-alive');
    expect(JSON.stringify(conversation.serialize().messages)).not.toContain('cache_control');
  });

  it('retains the Haiku long tier for idle cache reads', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'done' }], 'end_turn'));
    server.queueJson(200, {
      id: 'msg_keep',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 },
    });
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-haiku-5-5',
      effort: 'low',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());
    expect((await conversation.keepCacheWarm(new AbortController().signal))?.longContext).toEqual({
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
    });
  });

  it('does not keep the cache warm while tool calls are waiting for their results', async () => {
    server.queueSse(
      anthropicStream([{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }], 'tool_use'),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });
    await conversation.runTurn(request());
    expect(await conversation.keepCacheWarm(new AbortController().signal)).toBeNull();
    expect(server.requests).toHaveLength(1);
  });

  it('sends current-model features: adaptive thinking, effort, compaction, fallback, caching, eager tool input', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.context_management).toEqual({ edits: [{ type: 'compact_20260112' }] });
    expect(body.fallbacks).toBe('default');
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0]).toEqual({
      type: 'text',
      text: 'You are a test.',
      cache_control: { type: 'ephemeral' },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools[0]).toMatchObject({
      name: 'read_file',
      eager_input_streaming: true,
      input_schema: { type: 'object', required: ['path'] },
    });
    expect(body.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    const marked = conversation.buildParams({
      system: 'You are a test.',
      tools: [readFileTool, { name: 'grep', description: 'Search', schema: z.object({ pattern: z.string() }) }],
    });
    expect(marked.cache_control).toEqual({ type: 'ephemeral' });
    expect(marked.tools?.[0]).not.toHaveProperty('cache_control');
    expect(marked.tools?.at(-1)).toMatchObject({ name: 'grep', cache_control: { type: 'ephemeral' } });
    const noTools = conversation.buildParams({ system: 'You are a test.', tools: [] });
    expect(noTools.cache_control).toEqual({ type: 'ephemeral' });
    expect(noTools.system).toEqual([{ type: 'text', text: 'You are a test.', cache_control: { type: 'ephemeral' } }]);
    expect(noTools.tools).toEqual([]);
    expect(headers['anthropic-beta']).toContain('compact-2026-01-12');
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  });

  it.each([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
    'claude-opus-5',
    'claude-fable-5-1',
    'claude-fable-5',
  ])('enforces edit_file inputs on %s without forcing or serializing tool calls', async (model) => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model,
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'edit two files' });
    await conversation.runTurn(request({ tools: [readFileTool, ...toToolSpecs([editFileTool])] }));

    const body = server.requests[0]!.body;
    const edit = body.tools[1];
    expect(edit.strict).toBe(true);
    expect(edit.eager_input_streaming).toBeUndefined();
    expect(edit.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
    });
    const replaceAll = edit.input_schema.properties.replace_all;
    const replaceAllSchema = replaceAll.$ref ? edit.input_schema.$defs[replaceAll.$ref.split('/').at(-1)] : replaceAll;
    expect(replaceAllSchema).toMatchObject({ type: 'boolean' });
    // Unsupported constraints stay in local validation, rather than making the API reject the request.
    expect(edit.input_schema.properties.old_string.minLength).toBeUndefined();
    expect(edit.input_schema.properties.old_string.description).toContain('minLength');
    expect(editFileTool.schema!.safeParse({ path: 'a', old_string: '', new_string: '' }).success).toBe(false);
    expect(editFileTool.schema!.safeParse({ path: 'a', old_string: 'x', new_string: '' }).success).toBe(true);
    expect(body.tools[0].strict).toBeUndefined();
    expect(body.tools[0].eager_input_streaming).toBe(true);
    expect(edit.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tool_choice).toBeUndefined();
  });

  it('leaves custom models and server-provided schemas outside strict mode', () => {
    const tools = toToolSpecs([editFileTool]);
    const unknown = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-custom',
      effort: 'high',
    });
    expect(unknown.buildParams({ system: 'test', tools }).tools?.[0]).toMatchObject({
      eager_input_streaming: true,
      input_schema: { properties: { old_string: { minLength: 1 } } },
    });
    expect(unknown.buildParams({ system: 'test', tools }).tools?.[0]).not.toHaveProperty('strict');
    const known = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    const jsonSchema = { type: 'object' as const, additionalProperties: true };
    const mcp = known.buildParams({
      system: 'test',
      tools: [{ ...tools[0]!, jsonSchema }],
    }).tools?.[0];
    expect(mcp).toMatchObject({ input_schema: jsonSchema, eager_input_streaming: true });
    expect(mcp).not.toHaveProperty('strict');
  });

  it.each([100_000, 100_001])('tracks Haiku pricing at %i prompt tokens across continuations', async (tokens) => {
    const first = anthropicStream([{ type: 'text', text: 'continue' }], 'pause_turn');
    (first[0]!.data as any).message.usage = {
      input_tokens: tokens - 70_000,
      output_tokens: 0,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 30_000,
    };
    server.queueSse(first);
    server.queueSse(anthropicStream([{ type: 'text', text: 'done' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-haiku-5-5',
      effort: 'medium',
    });
    conversation.addUserMessage({ text: 'hi' });
    const result = await conversation.runTurn(request());
    expect(result.contextTokens).toBe(17);
    expect(result.usage.inputTokens).toBe(tokens - 70_000 + 10);
    expect(result.usage.longContext).toEqual(
      tokens > 100_000
        ? {
            inputTokens: tokens - 70_000,
            outputTokens: 7,
            cacheReadTokens: 40_000,
            cacheWriteTokens: 30_000,
          }
        : undefined,
    );
    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(headers['anthropic-beta']).toContain('compact-2026-01-12');
    expect(body.fallbacks).toBeUndefined();
  });

  it('omits thinking, compaction and fallback for legacy Haiku', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-haiku-4-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('keeps history append-only and sends all tool results in one user message', async () => {
    server.queueSse(
      anthropicStream(
        [
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'b' } },
        ],
        'tool_use',
      ),
    );
    server.queueSse(anthropicStream([{ type: 'text', text: 'done' }], 'end_turn'));

    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read both' });
    await conversation.runTurn(request());
    conversation.addToolResults([
      { id: 'toolu_1', content: 'A' },
      { id: 'toolu_2', content: 'missing', isError: true },
    ]);
    await conversation.runTurn(request());

    const second = server.requests[1]!.body.messages;
    expect(second).toHaveLength(3);
    // The assistant turn is sent back exactly as it was returned.
    expect(second[1].role).toBe('assistant');
    expect(second[1].content.map((block: any) => [block.type, block.id])).toEqual([
      ['tool_use', 'toolu_1'],
      ['tool_use', 'toolu_2'],
    ]);
    expect(second[2].role).toBe('user');
    expect(second[2].content.map((block: any) => [block.type, block.tool_use_id, block.is_error])).toEqual([
      ['tool_result', 'toolu_1', undefined],
      ['tool_result', 'toolu_2', true],
    ]);
    expect(conversation.serialize().messages).toHaveLength(4);
  });

  it('reports a turn that is still paused after the last continuation as paused, not as an answer', async () => {
    for (let i = 0; i < 6; i++) server.queueSse(anthropicStream([{ type: 'text', text: `part ${i}` }], 'pause_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Keep going' });
    const result = await conversation.runTurn(request());

    expect(server.requests).toHaveLength(6);
    expect(result.stopReason).toBe('paused');
    expect(result.toolCalls).toEqual([]);
    // Everything the model produced is still committed, so the next message continues from it.
    expect(conversation.serialize().messages).toHaveLength(7);
  });

  it('commits pause and compaction continuations together, preserving their blocks and usage', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'First part' }], 'pause_turn'));
    const compacted = anthropicStream([], 'compaction');
    const block = { type: 'compaction', content: 'Server summary' };
    compacted.splice(
      1,
      0,
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: block } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    );
    server.queueSse(compacted);
    server.queueSse(
      anthropicStream(
        [
          { type: 'text', text: 'Final part' },
          { type: 'tool_use', id: 'toolu_final', name: 'read_file', input: { path: 'final.ts' } },
        ],
        'tool_use',
      ),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Continue the task' });
    const before = structuredClone(conversation.serialize().messages);
    const result = await conversation.runTurn(
      request({
        callbacks: { onText: () => expect(conversation.serialize().messages).toEqual(before) },
      }),
    );

    // Compare to the actual response blocks sent back, without relying on SDK-added optional fields.
    expect(server.requests[1]!.body.messages).toMatchObject([
      ...before,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First part' }],
      },
    ]);
    expect(server.requests[2]!.body.messages).toEqual([
      ...server.requests[1]!.body.messages,
      { role: 'assistant', content: [block] },
    ]);
    const saved = conversation.serialize().messages;
    expect(saved.slice(0, 3)).toEqual(server.requests[2]!.body.messages);
    expect(saved).toHaveLength(4);
    expect(result.text).toBe('First part\n\nFinal part');
    expect(result.toolCalls).toEqual([{ id: 'toolu_final', name: 'read_file', input: { path: 'final.ts' } }]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 21, cacheReadTokens: 12, cacheWriteTokens: 9 });
  });

  it.each(['pause_turn', 'compaction'])(
    'discards a %s prefix when its continuation fails, then retries cleanly',
    async (reason) => {
      server.queueSse(anthropicStream([{ type: 'text', text: 'Discard this prefix' }], reason));
      server.queueJson(529, { type: 'error', error: { type: 'overloaded_error', message: 'Try again' } });
      server.queueSse(anthropicStream([{ type: 'text', text: 'Fresh answer' }], 'end_turn'));
      const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      conversation.addUserMessage({ text: 'Keep this request' });
      const before = structuredClone(conversation.serialize());

      await expect(conversation.runTurn(request())).rejects.toThrow(/Try again/);
      expect(conversation.serialize()).toEqual(before);
      expect(server.requests[1]!.body.messages).toHaveLength(2);
      const result = await conversation.runTurn(request());
      expect(server.requests[2]!.body.messages).toEqual(server.requests[0]!.body.messages);
      expect(result.text).toBe('Fresh answer');
      expect(conversation.serialize().messages).toHaveLength(2);
      expect(JSON.stringify(conversation.serialize())).not.toContain('Discard this prefix');
    },
  );

  it.each(['pause_turn', 'compaction'])(
    'does not save a %s prefix when the continuation is aborted',
    async (reason) => {
      server.queueSse(anthropicStream([{ type: 'text', text: 'Unsaved prefix' }], reason));
      server.queueSse(anthropicStream([{ type: 'text', text: 'Cancel here' }], 'end_turn'));
      const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      conversation.addUserMessage({ text: 'Keep this request' });
      const before = structuredClone(conversation.serialize());
      const controller = new AbortController();
      await expect(
        conversation.runTurn(
          request({
            signal: controller.signal,
            callbacks: {
              onText: (text) => {
                if (text === 'Cancel here') controller.abort();
              },
            },
          }),
        ),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(2);
      expect(conversation.serialize()).toEqual(before);
    },
  );

  it('reports refusals with their explanation', async () => {
    const events = anthropicStream([{ type: 'text', text: '' }], 'refusal');
    const delta = events.find((event) => event.event === 'message_delta')!.data as any;
    delta.delta.stop_details = { type: 'refusal', category: 'cyber', explanation: 'Declined.' };
    server.queueSse(events);

    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'something' });
    const result = await conversation.runTurn(request());

    expect(result.stopReason).toBe('refusal');
    expect(result.refusal).toBeTruthy();
  });

  it('logs cache numbers once per completed turn and only flags a changed prefix', async () => {
    server.queueJson(529, { type: 'error', error: { type: 'overloaded_error', message: 'Try again' } });
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    server.queueSse(anthropicStream([{ type: 'text', text: 'part' }], 'pause_turn'));
    server.queueSse(anthropicStream([{ type: 'text', text: 'done' }], 'end_turn'));
    const info = vi.spyOn(appLog, 'info');
    try {
      const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      const system = 'secret system prompt';
      conversation.addUserMessage({ text: 'secret user text' });
      await expect(conversation.runTurn(request({ system }))).rejects.toThrow(/Try again/);
      await conversation.runTurn(request({ system }));
      conversation.addUserMessage({ text: 'next' });
      await conversation.runTurn(request({ system }));
      conversation.addUserMessage({ text: 'third' });
      await conversation.runTurn(request({ system: `${system}!` }));

      const logs = info.mock.calls.filter((call) => call[1] === 'anthropic request');
      expect(logs).toHaveLength(3);
      expect(logs[0]).toEqual([
        'llm',
        'anthropic request',
        {
          cacheRead: 4,
          cacheWrite: 3,
          input: 10,
          output: 7,
          tools: 1,
          systemChars: system.length,
          toolsChanged: 1,
          systemChanged: 1,
        },
      ]);
      expect(logs[1]?.[2]).toEqual({
        cacheRead: 4,
        cacheWrite: 3,
        input: 10,
        output: 7,
        tools: 1,
        systemChars: system.length,
        toolsChanged: 0,
        systemChanged: 0,
      });
      expect(logs[2]?.[2]).toEqual({
        cacheRead: 8,
        cacheWrite: 6,
        input: 20,
        output: 14,
        tools: 1,
        systemChars: system.length + 1,
        toolsChanged: 0,
        systemChanged: 1,
      });
      expect(JSON.stringify(logs)).not.toContain('secret');
    } finally {
      info.mockRestore();
    }
  });

  it('propagates API errors', async () => {
    server.queueJson(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'hi' });
    await expect(conversation.runTurn(request())).rejects.toThrow(/invalid x-api-key/);
  });

  it('re-asks at once when a streamed tool input is not valid JSON', async () => {
    const broken = anthropicStream(
      [{ type: 'tool_use', id: 'toolu_bad', name: 'read_file', input: { path: 'a.ts' } }],
      'tool_use',
    ).map((event) =>
      (event.data as { delta?: { type?: string } }).delta?.type === 'input_json_delta'
        ? {
            ...event,
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"path": "a.ts",,}' },
            },
          }
        : event,
    );
    server.queueSse(broken);
    server.queueSse(
      anthropicStream([{ type: 'tool_use', id: 'toolu_ok', name: 'read_file', input: { path: 'a.ts' } }], 'tool_use'),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });
    const onRestart = vi.fn();
    const req = request();
    req.callbacks.onRestart = onRestart;

    const result = await conversation.runTurn(req);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(2);
    expect(result.toolCalls).toEqual([{ id: 'toolu_ok', name: 'read_file', input: { path: 'a.ts' } }]);
  });

  it('leaves a connection dropped mid-stream to the agent loop instead of re-asking at once', async () => {
    // The socket closes after part of the stream, which the SDK reports as an AnthropicError caused by UND_ERR_SOCKET.
    let requests = 0;
    const dropping = createServer((req, res) => {
      requests++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const { event, data } of anthropicStream([{ type: 'text', text: 'Partial' }], 'end_turn').slice(0, 3)) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        setTimeout(() => res.socket?.destroy(), 20);
      });
    });
    await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(dropping.address() as AddressInfo).port}`;
      const conversation = new AnthropicConversation(createAnthropicClient('sk-test', url), {
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      conversation.addUserMessage({ text: 'hi' });
      const before = structuredClone(conversation.serialize());
      const onRestart = vi.fn();
      const req = request();
      req.callbacks.onRestart = onRestart;

      const error = await conversation.runTurn(req).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: { cause?: { code?: string } } }).cause?.cause?.code).toBe('UND_ERR_SOCKET');
      expect(retryDecision(error, 0)).not.toBeNull();
      expect(onRestart).not.toHaveBeenCalled();
      expect(requests).toBe(1);
      expect(conversation.serialize()).toEqual(before);
    } finally {
      dropping.closeAllConnections();
      await new Promise((resolve) => dropping.close(resolve));
    }
  });

  it('closes tool calls left pending by an interrupted task when the next message is added', async () => {
    server.queueSse(
      anthropicStream([{ type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'a.ts' } }], 'tool_use'),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });
    await conversation.runTurn(request());
    expect(conversation.hasPendingToolCalls()).toBe(true);

    conversation.addUserMessage({ text: 'Continue.' });
    expect(conversation.hasPendingToolCalls()).toBe(false);
    const messages = conversation.serialize().messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    const repaired = messages.at(-2)!;
    expect(repaired.role).toBe('user');
    expect(repaired.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true });
    expect(JSON.stringify(repaired)).toContain('may or may not have run');
  });

  it('stays settled after a tool result that carries images', async () => {
    server.queueSse(
      anthropicStream(
        [{ type: 'tool_use', id: 'toolu_img', name: 'browser', input: { url: 'https://x' } }],
        'tool_use',
      ),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Look' });
    await conversation.runTurn(request());
    conversation.addToolResults([
      { id: 'toolu_img', content: 'screenshot', images: [{ mediaType: 'image/png', base64: 'AAAA' }] },
    ]);
    expect(conversation.hasPendingToolCalls()).toBe(false);
    const messages = conversation.serialize().messages as Array<{ content: Array<Record<string, unknown>> }>;
    const results = messages.flatMap((message) => message.content.filter((block) => block.type === 'tool_result'));
    expect(results).toHaveLength(1);
  });
});

describe('AnthropicCompletionClient', () => {
  it.each(['claude-haiku-4-5', 'claude-haiku-5-5'])(
    'returns structured output without forcing a tool on %s',
    async (model) => {
      const server = new MockApiServer();
      const baseURL = await server.start();
      server.queueJson(200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: '{"title":"Fix login bug"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      });
      const client = new AnthropicCompletionClient(createAnthropicClient('sk-test', baseURL), model);
      const result = await client.complete('Title?', z.object({ title: z.string() }));
      await server.stop();

      expect(result).toEqual({ title: 'Fix login bug' });
      const body = server.requests[0]!.body;
      expect(body.output_config.format.type).toBe('json_schema');
      expect(body.tool_choice).toBeUndefined();
      expect(body.thinking).toEqual(model === 'claude-haiku-5-5' ? { type: 'adaptive' } : undefined);
      expect(body.output_config.effort).toBe(model === 'claude-haiku-5-5' ? 'low' : undefined);
    },
  );
});
