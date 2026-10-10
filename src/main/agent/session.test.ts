import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDecision, ChatEvent } from '@shared/chat';
import type { Conversation, TurnRequest, TurnResult } from '../llm/types';
import { ChatSession, type ChatAgentHooks } from './session';

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

// A conversation whose turns are scripted: each step is a result, an error to throw, or 'hang' until the run is stopped.
class ScriptedTurns extends IdleConversation {
  readonly sent: string[] = [];
  steps: Array<'ok' | 'hang' | Error> = [];

  override addUserMessage(input?: { text: string }): void {
    this.sent.push(input?.text ?? '');
  }

  override async runTurn(request: TurnRequest): Promise<TurnResult> {
    const step = this.steps.shift() ?? 'ok';
    if (step === 'hang') {
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (step instanceof Error) throw step;
    return super.runTurn(request);
  }
}

describe('stopping and resuming a run', () => {
  const resumableOf = (chat: ChatSession) => chat.snapshot().resumable;

  it('offers Resume after a stop, and a resumed run that finishes clears it', async () => {
    const conversation = new ScriptedTurns();
    conversation.steps = ['hang'];
    const { chat, events } = session(conversation, () => false);
    const run = chat.send({ text: 'go' });
    await vi.waitFor(() => expect(chat.snapshot().busy).toBe(true));
    chat.stop();
    await run;

    expect(resumableOf(chat)).toBe(true);
    expect(events).toContainEqual({ type: 'resumable', resumable: true });
    expect(events.some((event) => event.type === 'notice' && event.text === 'Stopped.')).toBe(true);

    await chat.resume();
    expect(resumableOf(chat)).toBe(false);
    expect(chat.snapshot().busy).toBe(false);
    chat.dispose();
  });

  it('does not offer Resume for a run that finished on its own, and refuses to resume one', async () => {
    const { chat } = session(new ScriptedTurns(), () => false);
    await chat.send({ text: 'go' });
    expect(resumableOf(chat)).toBe(false);
    await expect(chat.resume()).rejects.toThrow('There is no stopped run to resume.');
    chat.dispose();
  });

  it('offers Resume after a provider error that outlasted the retries, but not after one that cannot pass', async () => {
    const waitLonger = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: new Headers({ 'retry-after': '99999' }),
    });
    const refused = Object.assign(new Error('bad request'), { status: 400 });
    for (const [error, resumable] of [
      [waitLonger, true],
      [refused, false],
    ] as const) {
      const conversation = new ScriptedTurns();
      conversation.steps = [error];
      const { chat, events } = session(conversation, () => false);
      await chat.send({ text: 'go' });
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(resumableOf(chat)).toBe(resumable);
      chat.dispose();
    }
  });

  it('refuses a second send while a run is going', async () => {
    const conversation = new ScriptedTurns();
    conversation.steps = ['hang'];
    const { chat } = session(conversation, () => false);
    const run = chat.send({ text: 'go' });
    await vi.waitFor(() => expect(chat.snapshot().busy).toBe(true));
    await expect(chat.send({ text: 'again' })).rejects.toThrow('still working');
    chat.stop();
    await run;
    chat.dispose();
  });

  it('tells the model about an undone edit with the next message, once', async () => {
    const conversation = new ScriptedTurns();
    const { chat, events } = session(conversation, () => false);
    await chat.send({ text: 'first' });
    chat.editUndone('tool-1', { path: 'a.ts', action: 'restored' }, '/project/a.ts');
    expect(events).toContainEqual({ type: 'tool-undone', id: 'tool-1' });

    await chat.send({ text: 'second' });
    await chat.send({ text: 'third' });
    expect(conversation.sent[1]).toContain('The user undid your edit to a.ts');
    expect(conversation.sent[1]).toContain('second');
    expect(conversation.sent[2]).toBe('third');
    chat.dispose();
  });
});

describe('approvals of an agent that runs its own loop (#261)', () => {
  function agentChat(run: (hooks: ChatAgentHooks, signal: AbortSignal) => Promise<boolean>) {
    const events: ChatEvent[] = [];
    const chat = new ChatSession({
      projectPath: null,
      conversation: new IdleConversation(),
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
      createAgent: (agentHooks) => ({
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        send: (_input, signal) => run(agentHooks, signal),
        resume: (signal) => run(agentHooks, signal),
        forgetContextSize() {},
      }),
    });
    return { chat, events };
  }

  it('resolves a pending approval as declined when the run is stopped, and ignores a late decision', async () => {
    const decisions: ApprovalDecision[] = [];
    const { chat, events } = agentChat(async (agent, signal) => {
      decisions.push(await agent.requestApproval('a1', signal));
      return false;
    });

    const pending = chat.send({ text: 'go' });
    chat.stop();
    await pending;
    const before = events.length;
    chat.decide('a1', { approved: true });

    expect(decisions).toEqual([{ approved: false }]);
    expect(events.length).toBe(before);
  });

  it('resolves a pending approval as declined when its own signal aborts, without a stop', async () => {
    const decisions: ApprovalDecision[] = [];
    const approval = new AbortController();
    const { chat } = agentChat(async (agent) => {
      decisions.push(await agent.requestApproval('a2', approval.signal));
      return false;
    });

    const pending = chat.send({ text: 'go' });
    approval.abort();
    await pending;

    expect(decisions).toEqual([{ approved: false }]);
  });

  it('answers at once when the approval signal was already aborted', async () => {
    const decisions: ApprovalDecision[] = [];
    const { chat } = agentChat(async (agent) => {
      decisions.push(await agent.requestApproval('a3', AbortSignal.abort()));
      return false;
    });

    await chat.send({ text: 'go' });

    expect(decisions).toEqual([{ approved: false }]);
  });
});
