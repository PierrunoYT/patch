import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../agent/agent';
import { estimateChars } from './compaction';
import { createOpenAIClient, OpenAIConversation, trimHistory } from './openai';
import { MockApiServer } from './test_server';
import type { TurnRequest } from './types';

function chunk(delta: object, finishReason: string | null = null, usage?: object) {
  return {
    data: {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-test',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    },
  };
}

function request(): TurnRequest & { streamed: string[] } {
  const streamed: string[] = [];
  return {
    system: 'sys',
    tools: [{ name: 'read_file', description: 'Read', schema: z.object({ path: z.string() }) }],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => streamed.push(delta) },
    streamed,
  };
}

describe('OpenAIConversation', () => {
  let server: MockApiServer;
  let baseURL: string;

  beforeEach(async () => {
    server = new MockApiServer();
    baseURL = await server.start();
  });

  afterEach(() => server.stop());

  it.each(['length', 'content_filter'])(
    'does not execute calls stopped by %s and keeps their history paired',
    async (reason) => {
      server.queueSse([
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'complete',
              type: 'function',
              function: { name: 'change', arguments: '{"value":"valid"}' },
            },
            { index: 1, id: 'incomplete', type: 'function', function: { name: 'change', arguments: '{"value":' } },
          ],
        }),
        chunk({}, reason),
        { data: '[DONE]' },
      ]);
      server.queueSse([chunk({ role: 'assistant', content: 'Done' }), chunk({}, 'stop'), { data: '[DONE]' }]);
      const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'custom');
      let executions = 0;
      const agent = new Agent({
        conversation,
        system: 'sys',
        tools: () => [
          {
            name: 'change',
            description: 'Change a value',
            schema: z.object({ value: z.string() }),
            requiresApproval: false,
            async run() {
              executions++;
              return { content: 'changed' };
            },
          },
        ],
        approvalMode: () => 'auto',
        requestApproval: async () => ({ approved: true }),
        toolContext: () => {
          throw new Error('Skipped tools must not get an execution context');
        },
        emit() {},
      });
      await agent.send({ text: 'Change it' }, new AbortController().signal);
      // A refusal ends the task; a truncated tool turn automatically asks the model to retry.
      if (reason === 'content_filter') await agent.send({ text: 'Try another approach' }, new AbortController().signal);

      expect(executions).toBe(0);
      const sent = server.requests[1]!.body.messages;
      expect(sent[2].tool_calls.map((call: { id: string }) => call.id)).toEqual(['complete', 'incomplete']);
      expect(sent.slice(3, 5)).toEqual([
        expect.objectContaining({ role: 'tool', tool_call_id: 'complete' }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'incomplete' }),
      ]);
      expect(conversation.serialize().messages.slice(2, 4)).toEqual(sent.slice(3, 5));
    },
  );

  it('streams text and parses tool calls', async () => {
    server.queueSse([
      chunk({ role: 'assistant', content: 'Checking' }),
      chunk({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      {
        data: {
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [],
          usage: {
            prompt_tokens: 272_000,
            completion_tokens: 3,
            total_tokens: 272_003,
            prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
          },
        },
      },
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addUserMessage({ text: 'read a.ts' });

    const req = request();
    const result = await conversation.runTurn(req);

    expect(req.streamed.join('')).toBe('Checking');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({
      inputTokens: 271_993,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      longContext: false,
    });
    expect(result.contextTokens).toBe(272_000);

    const body = server.requests[0]!.body;
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.tools[0].function.parameters).toMatchObject({ type: 'object', required: ['path'] });
  });

  it('selects the long-context tier only above 272K total per-request input', async () => {
    server.queueSse([
      chunk({ role: 'assistant', content: 'ok' }),
      chunk({}, 'stop'),
      {
        data: {
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [],
          usage: {
            prompt_tokens: 272_001,
            completion_tokens: 1,
            total_tokens: 272_002,
            prompt_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 50_000 },
          },
        },
      },
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-6-sol');
    conversation.addUserMessage({ text: 'large request' });

    const result = await conversation.runTurn(request());

    expect(result.usage).toEqual({
      inputTokens: 22_001,
      outputTokens: 1,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 50_000,
      longContext: true,
    });
    expect(result.contextTokens).toBe(272_001);
  });

  it('marks unparseable tool arguments instead of throwing', async () => {
    server.queueSse([
      chunk({
        role: 'assistant',
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addUserMessage({ text: 'x' });
    const result = await conversation.runTurn(request());
    expect(result.toolCalls[0]!.input).toEqual({ __invalidJson: '{"path":' });
  });

  it('sends tool screenshots as a follow-up user message', () => {
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addToolResults([
      { id: 'call_1', content: 'Loaded', images: [{ mediaType: 'image/png', base64: 'AAAA' }] },
    ]);
    const messages = conversation.serialize().messages as any[];
    expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Loaded' });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content[0].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('never sends a tool result without the call it answers, and keeps the step in progress whole', () => {
    const big = 'x'.repeat(150_000);
    const history: any[] = [
      { role: 'user', content: 'THE TASK' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: big },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(600_000)}` } }],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c2', content: big },
    ];
    const sent = trimHistory(history);

    // Every tool message still follows the assistant message whose call it answers.
    sent.forEach((message: any, index: number) => {
      if (message.role !== 'tool') return;
      const caller = sent
        .slice(0, index)
        .reverse()
        .find((candidate: any) => candidate.role !== 'tool') as any;
      expect(caller?.tool_calls?.map((call: any) => call.id)).toContain(message.tool_call_id);
    });
    expect(sent[0]).toEqual({ role: 'user', content: 'THE TASK' });
    // The last call and its result, the step the model is working on, are there.
    expect(sent.slice(-2).map((message: any) => message.role)).toEqual(['assistant', 'tool']);
  });

  it('counts an image as small when deciding what to drop', () => {
    const history: any[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(900_000)}` } },
          { type: 'text', text: 'THE TASK' },
        ],
      },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow-up' },
    ];
    // Well under the budget once the image is not counted by its base64 length.
    expect(trimHistory(history)).toBe(history);
  });

  it('keeps exactly what re-measuring the remaining history at every step would keep', () => {
    // The straightforward version: re-measure everything that is left after each dropped group.
    const reference = (messages: any[]): any[] => {
      const tokens = (list: any[]) => Math.ceil(estimateChars(list) / 4);
      if (tokens(messages) <= 100_000) return messages;
      const [first, ...rest] = messages;
      let lastGroup = rest.length - 1;
      while (lastGroup > 0 && rest[lastGroup]?.role === 'tool') lastGroup--;
      let start = 0;
      while (start < lastGroup && tokens([first, ...rest.slice(start)]) > 100_000) {
        start++;
        while (start < lastGroup && rest[start]?.role === 'tool') start++;
      }
      if (start === 0) return messages;
      return [
        first,
        { role: 'user', content: '(Earlier messages were removed to fit the context window.)' },
        ...rest.slice(start),
      ];
    };
    let seed = 7;
    const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    let trimmed = 0;
    for (let round = 0; round < 40; round++) {
      const history: any[] = [{ role: 'user', content: `THE TASK ${'t'.repeat(Math.floor(random() * 50_000))}` }];
      const count = 2 + Math.floor(random() * 40);
      for (let i = 0; i < count; i++) {
        const text = 'x'.repeat(Math.floor(random() * 40_000));
        const kind = random();
        if (kind < 0.3) {
          const calls = 1 + Math.floor(random() * 3);
          history.push({
            role: 'assistant',
            content: '',
            tool_calls: Array.from({ length: calls }, (_, c) => ({
              id: `c${i}_${c}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            })),
          });
          for (let c = 0; c < calls; c++) history.push({ role: 'tool', tool_call_id: `c${i}_${c}`, content: text });
        } else if (kind < 0.4) {
          history.push({
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(300_000)}` } }],
          });
        } else {
          history.push({ role: kind < 0.7 ? 'user' : 'assistant', content: `"quoted" ${text}` });
        }
      }
      const sent = trimHistory(history);
      expect(sent).toEqual(reference(history));
      if (sent !== history) trimmed++;
    }
    // Both outcomes are covered: histories under the budget and histories that had to be shortened.
    expect(trimmed).toBeGreaterThan(0);
    expect(trimmed).toBeLessThan(40);
  });

  it('trims a very long history quickly', () => {
    const history: any[] = [{ role: 'user', content: 'THE TASK' }];
    for (let i = 0; i < 3_000; i++) {
      history.push({ role: 'assistant', content: `answer ${i} ${'x'.repeat(1_500)}` });
      history.push({ role: 'user', content: `follow-up ${i}` });
    }
    const started = performance.now();
    const sent = trimHistory(history);
    // Re-measuring the remaining history at every step took many seconds here.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(sent[0]).toEqual({ role: 'user', content: 'THE TASK' });
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'follow-up 2999' });
    expect(Math.ceil(estimateChars(sent) / 4)).toBeLessThanOrEqual(100_100);
  });

  it('drops the oldest turns but keeps the task when history grows too large', async () => {
    server.queueSse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop'), { data: '[DONE]' }]);
    const big = 'x'.repeat(60_000);
    const history = [
      { role: 'user', content: 'THE TASK' },
      ...Array.from({ length: 10 }, (_, i) => [
        { role: 'assistant', content: `answer ${i} ${big}` },
        { role: 'user', content: `follow-up ${i}` },
      ]).flat(),
    ];
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test', history as any);
    await conversation.runTurn(request());

    const sent = server.requests[0]!.body.messages;
    expect(sent[1]).toEqual({ role: 'user', content: 'THE TASK' });
    expect(sent[2].content).toContain('removed to fit');
    expect(JSON.stringify(sent).length / 4).toBeLessThan(110_000);
    expect(sent.at(-1)!.content).toBe('follow-up 9');
  });

  it('closes tool calls left pending by an interrupted task when the next message is added', async () => {
    server.queueSse([
      chunk({ role: 'assistant' }),
      chunk({
        tool_calls: [
          { index: 0, id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addUserMessage({ text: 'read a.ts' });
    await conversation.runTurn(request());
    expect(conversation.hasPendingToolCalls()).toBe(true);

    conversation.addUserMessage({ text: 'Continue.' });
    expect(conversation.hasPendingToolCalls()).toBe(false);
    const messages = conversation.serialize().messages as Array<{ role: string; content: unknown }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Continue.' });
    expect(messages.at(-2)).toEqual({
      role: 'tool',
      tool_call_id: 'call_9',
      content: expect.stringContaining('may or may not have run'),
    });
  });

  it('stays settled after a tool result that carries images', async () => {
    server.queueSse([
      chunk({ role: 'assistant' }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_img', type: 'function', function: { name: 'browser', arguments: '{}' } }],
      }),
      chunk({}, 'tool_calls'),
      { data: '[DONE]' },
    ]);
    const conversation = new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test');
    conversation.addUserMessage({ text: 'Look' });
    await conversation.runTurn(request());
    conversation.addToolResults([
      { id: 'call_img', content: 'screenshot', images: [{ mediaType: 'image/png', base64: 'AAAA' }] },
    ]);
    expect(conversation.hasPendingToolCalls()).toBe(false);
    const messages = conversation.serialize().messages as Array<{ role: string; tool_call_id?: string }>;
    expect(messages.filter((message) => message.role === 'tool' && message.tool_call_id === 'call_img')).toHaveLength(
      1,
    );
  });
});
