import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '@shared/chat';
import type { Conversation, TurnRequest, TurnResult } from '../llm/types';
import { ChatSession } from './session';

// A conversation that answers every turn at once and counts keep-alives.
class IdleConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'claude-opus-5-5';
  lastRequestStartedAt?: number;
  keepAlives = 0;
  keepAliveResult: TurnResult['usage'] | null | Error = {
    inputTokens: 11,
    outputTokens: 0,
    cacheReadTokens: 8000,
    cacheWriteTokens: 4,
  };

  addUserMessage(): void {}
  addToolResults(): void {}
  discardLastUserMessage(): void {}

  hasPendingToolCalls(): boolean {
    return false;
  }
  planCompaction() {
    return null;
  }
  applyCompaction(): void {}
  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }

  async runTurn(_request: TurnRequest): Promise<TurnResult> {
    this.lastRequestStartedAt = Date.now();
    return {
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      contextTokens: 100,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 50 },
    };
  }

  async keepCacheWarm(): Promise<TurnResult['usage'] | null> {
    this.keepAlives++;
    this.lastRequestStartedAt = Date.now();
    if (this.keepAliveResult instanceof Error) throw this.keepAliveResult;
    return this.keepAliveResult;
  }
}

const MINUTE = 60_000;

function session(conversation: Conversation, enabled: () => boolean) {
  const events: ChatEvent[] = [];
  const chat = new ChatSession({
    projectPath: null,
    conversation,
    system: 'system',
    agentFile: null,
    tools: () => [],
    approvalMode: () => 'ask',
    toolContext: (base) => ({
      ...base,
      workspace: null as never,
      shell: null as never,
      browser: null,
      codeSearch: null,
      webSearch: null,
    }),
    smallModel: () => null,
    onEvent: (event) => events.push(event),
    onChange: () => {},
    keepCacheWarm: enabled,
  });
  return { chat, events };
}

describe('prompt cache keep-alive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-sends the chat about every 4 minutes while idle and adds the usage to the chat', async () => {
    const conversation = new IdleConversation();
    const { chat } = session(conversation, () => true);
    await chat.send({ text: 'hi' });

    await vi.advanceTimersByTimeAsync(4 * MINUTE - 1_000);
    expect(conversation.keepAlives).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conversation.keepAlives).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(conversation.keepAlives).toBe(2);

    const usage = chat.snapshot().usage;
    expect(usage.cacheReadTokens).toBe(16_000);
    expect(usage.requests).toBe(3); // the turn and two keep-alives
    chat.dispose();
  });

  it('stops after about an hour of idle time', async () => {
    const conversation = new IdleConversation();
    const { chat } = session(conversation, () => true);
    await chat.send({ text: 'hi' });
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(conversation.keepAlives).toBe(14);
    chat.dispose();
  });

  it('starts over after the next answer, and stops when the chat is disposed', async () => {
    const conversation = new IdleConversation();
    const { chat } = session(conversation, () => true);
    await chat.send({ text: 'hi' });
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(conversation.keepAlives).toBe(1);
    await chat.send({ text: 'again' });
    // The new answer refreshed the cache itself; the next keep-alive is 4 minutes after it.
    await vi.advanceTimersByTimeAsync(4 * MINUTE - 1_000);
    expect(conversation.keepAlives).toBe(1);
    chat.dispose();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(conversation.keepAlives).toBe(1);
  });

  it('does nothing when the setting is off, and stops when it is turned off', async () => {
    let enabled = false;
    const conversation = new IdleConversation();
    const { chat } = session(conversation, () => enabled);
    await chat.send({ text: 'hi' });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(conversation.keepAlives).toBe(0);

    enabled = true;
    await chat.send({ text: 'again' });
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(conversation.keepAlives).toBe(1);
    enabled = false;
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(conversation.keepAlives).toBe(1);
    chat.dispose();
  });

  it('stops for good after a failed keep-alive instead of retrying', async () => {
    const conversation = new IdleConversation();
    conversation.keepAliveResult = new Error('overloaded');
    const { chat } = session(conversation, () => true);
    await chat.send({ text: 'hi' });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(conversation.keepAlives).toBe(1);
    chat.dispose();
  });

  it('does nothing for a provider without cache control', async () => {
    const conversation = new IdleConversation();
    const withoutKeepAlive = Object.assign(Object.create(Object.getPrototypeOf(conversation)), conversation, {
      keepCacheWarm: undefined,
    }) as Conversation;
    const { chat } = session(withoutKeepAlive, () => true);
    await chat.send({ text: 'hi' });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(conversation.keepAlives).toBe(0);
    chat.dispose();
  });
});
