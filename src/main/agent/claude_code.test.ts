import { describe, expect, it, vi } from 'vitest';
import type {
  CanUseTool,
  HookInput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/core';
import { applyChatEvent, type ApprovalDecision, type ChatEvent, type TranscriptItem } from '@shared/chat';
import { ClaudeCodeAgent, ClaudeCodeConversation, type QueryFunction } from './claude_code';
import type { SessionUsage } from './claude_code';

type Params = { prompt: AsyncIterable<SDKUserMessage>; options?: Options };
type Details = Parameters<CanUseTool>[2];

const msg = (value: Record<string, unknown>) => value as unknown as SDKMessage;
const usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheCreationInputTokens,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 0,
  maxOutputTokens: 0,
});
const init = (sessionId: string) => msg({ type: 'system', subtype: 'init', session_id: sessionId });
const success = (modelUsage: Record<string, ReturnType<typeof usage>> = {}, extra: Record<string, unknown> = {}) =>
  msg({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1', modelUsage, ...extra });
const failed = (subtype: string, errors: string[], modelUsage: Record<string, ReturnType<typeof usage>> = {}) =>
  msg({ type: 'result', subtype, is_error: true, errors, session_id: 's1', modelUsage });
const assistant = (id: string, content: unknown[], parent: string | null = null) =>
  msg({ type: 'assistant', message: { id, content, usage: undefined }, parent_tool_use_id: parent });
const toolResult = (toolUseId: string, content: unknown, isError = false) =>
  msg({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    parent_tool_use_id: null,
  });
const streamEvent = (event: Record<string, unknown>) => msg({ type: 'stream_event', parent_tool_use_id: null, event });
const details = (toolUseID: string, extra: Partial<Details> = {}): Details =>
  ({ toolUseID, signal: new AbortController().signal, suggestions: [], ...extra }) as unknown as Details;

function fakeQuery(body: (params: Params) => AsyncGenerator<SDKMessage, void>) {
  const calls: Params[] = [];
  const close = vi.fn();
  const interrupt = vi.fn(async () => undefined);
  const query: QueryFunction = (params) => {
    calls.push(params as Params);
    return Object.assign(body(params as Params), { close, interrupt }) as unknown as Query;
  };
  return { query, calls, close, interrupt };
}

function queued(runs: SDKMessage[][]) {
  return fakeQuery(async function* () {
    yield* runs.shift() ?? [];
  });
}

async function promptOf(params: Params): Promise<SDKUserMessage[]> {
  const messages: SDKUserMessage[] = [];
  for await (const message of params.prompt) messages.push(message);
  return messages;
}

function harness(
  query: QueryFunction,
  options: {
    model?: string;
    sessionId?: string | null;
    sessionUsage?: SessionUsage | null;
    approvalMode?: 'ask' | 'auto';
    planMode?: boolean;
    requestApproval?: (id: string, signal: AbortSignal) => Promise<ApprovalDecision>;
  } = {},
) {
  const events: ChatEvent[] = [];
  const checkpoints = vi.fn();
  const requestApproval = vi.fn(options.requestApproval ?? (async () => ({ approved: true })));
  const conversation = new ClaudeCodeConversation(
    options.model ?? 'claude-code/claude-opus-5-5',
    options.sessionId ?? null,
    options.sessionUsage ?? null,
  );
  const agent = new ClaudeCodeAgent({
    conversation,
    cwd: '/work/project',
    appendSystemPrompt: 'Project rules',
    approvalMode: () => options.approvalMode ?? 'ask',
    planMode: () => options.planMode ?? false,
    effort: () => 'high',
    launch: () => ({ executable: '/opt/claude', env: { PATH: '/bin' } }),
    requestApproval,
    emit: (event) => events.push(event),
    onCheckpoint: checkpoints,
    query,
  });
  const transcript = () => events.reduce<TranscriptItem[]>((items, event) => applyChatEvent(items, event), []);
  const counts = () => {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = agent.totals;
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  };
  return { agent, conversation, events, transcript, checkpoints, requestApproval, counts };
}

const text = { text: 'Hello' };
const signalNow = () => new AbortController().signal;

describe('ClaudeCodeAgent: the query it starts', () => {
  it('starts Claude Code in the project with the chat settings and sends images with the text', async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield init('s1');
      yield success();
    });
    const { agent } = harness(query, { model: 'claude-code/claude-opus-5-5' });

    await agent.send({ ...text, images: [{ mediaType: 'image/png', base64: 'AAA' }] }, signalNow());

    const options = calls[0]!.options!;
    expect(options).toMatchObject({
      cwd: '/work/project',
      model: 'claude-opus-5-5',
      effort: 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
      permissionMode: 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Project rules' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      pathToClaudeCodeExecutable: '/opt/claude',
      env: { PATH: '/bin' },
      disallowedTools: ['AskUserQuestion'],
    });
    expect(options).not.toHaveProperty('resume');
    const [prompt] = await promptOf(calls[0]!);
    expect(prompt!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('leaves out adaptive thinking and the model for a model without it and for the default model', async () => {
    const plain = fakeQuery(async function* () {
      yield success();
    });
    await harness(plain.query, { model: 'claude-code/claude-sonnet-4-5' }).agent.send(text, signalNow());
    expect(plain.calls[0]!.options).toMatchObject({ model: 'claude-sonnet-4-5' });
    expect(plain.calls[0]!.options).not.toHaveProperty('thinking');

    const defaults = fakeQuery(async function* () {
      yield success();
    });
    await harness(defaults.query, { model: 'claude-code/default' }).agent.send(text, signalNow());
    expect(defaults.calls[0]!.options).not.toHaveProperty('model');
    expect(defaults.calls[0]!.options).toMatchObject({ thinking: { type: 'adaptive' } });
  });

  it('starts in plan mode when plan mode is on', async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });
    await harness(query, { planMode: true }).agent.send(text, signalNow());
    expect(calls[0]!.options).toMatchObject({ permissionMode: 'plan' });
  });

  it('resumes the saved session on the next message and checkpoints the session id', async () => {
    const { query, calls } = queued([
      [init('s1'), success({ 'claude-opus-5-5': usage(10, 2) })],
      [init('s1'), success({ 'claude-opus-5-5': usage(20, 4) })],
    ]);
    const { agent, conversation, checkpoints } = harness(query);

    await agent.send(text, signalNow());
    expect(conversation.sessionId).toBe('s1');
    expect(checkpoints).toHaveBeenCalled();
    await agent.send({ text: 'Again' }, signalNow());

    expect(calls[1]!.options).toMatchObject({ resume: 's1' });
    expect(conversation.serialize()).toMatchObject({ sessionId: 's1' });
  });

  it('closes the query when the run completes', async () => {
    const { query, close } = queued([[init('s1'), success()]]);
    await harness(query).agent.send(text, signalNow());
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeAgent: streamed and complete messages', () => {
  it('shows streamed text once, replaced by the complete answer, and a streamed thinking once', async () => {
    const { query } = queued([
      [
        init('s1'),
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } }),
        streamEvent({ type: 'content_block_stop', index: 0 }),
        streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
        streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
        assistant('m1', [
          { type: 'thinking', thinking: 'Hmm' },
          { type: 'text', text: 'Hello' },
        ]),
        streamEvent({ type: 'content_block_stop', index: 1 }),
        streamEvent({ type: 'message_stop' }),
        success(),
      ],
    ]);
    const { agent, transcript } = harness(query);

    await agent.send(text, signalNow());

    const replies = transcript().filter((item) => item.kind === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Hello', thinking: 'Hmm', streaming: false });
  });

  it('shows the thinking of a complete message that did not stream', async () => {
    const { query } = queued([
      [
        init('s1'),
        assistant('m1', [
          { type: 'thinking', thinking: 'Plan it' },
          { type: 'text', text: 'Ok' },
        ]),
        success(),
      ],
    ]);
    const { agent, transcript } = harness(query);

    await agent.send(text, signalNow());

    expect(transcript()).toMatchObject([{ kind: 'assistant', text: 'Ok', thinking: 'Plan it', streaming: false }]);
  });

  it('closes a streamed bubble when the message stops', async () => {
    const { query } = queued([
      [
        init('s1'),
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Only' } }),
        streamEvent({ type: 'message_stop' }),
        success(),
      ],
    ]);
    const { agent, transcript } = harness(query);

    await agent.send(text, signalNow());

    expect(transcript()).toMatchObject([{ kind: 'assistant', thinking: 'Only', streaming: false }]);
  });

  it('keeps unknown SDK messages out of the transcript', async () => {
    const { query } = queued([[init('s1'), msg({ type: 'future_event', payload: 1 }), success()]]);
    const { agent, transcript } = harness(query);

    await agent.send(text, signalNow());

    expect(transcript()).toEqual([]);
  });
});

describe('ClaudeCodeAgent: tool cards', () => {
  it('shows a tool call with its result and an error with its output', async () => {
    const { query } = queued([
      [
        init('s1'),
        assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/project/a.ts' } }]),
        toolResult('t1', 'contents'),
        assistant('m2', [
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
        ]),
        toolResult('t2', 'boom', true),
        success(),
      ],
    ]);
    const { agent, transcript } = harness(query);

    await agent.send(text, signalNow());

    const [read, bash] = transcript().filter((item) => item.kind === 'tool');
    expect(read).toMatchObject({ id: 't1', status: 'done', path: 'a.ts', summary: 'Read a.ts' });
    expect(bash).toMatchObject({ id: 't2', status: 'error', output: 'boom', preview: { command: 'npm test' } });
  });

  it('shows a declined call as declined when its error result comes back', async () => {
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      yield assistant('m1', [
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } },
      ]);
      const decision = await params.options!.canUseTool!('Write', { file_path: 'a.txt', content: 'x' }, details('t1'));
      expect(decision).toMatchObject({ behavior: 'deny' });
      yield toolResult('t1', 'declined', true);
      yield success();
    });
    const { agent, transcript } = harness(query, { requestApproval: async () => ({ approved: false }) });

    await agent.send(text, signalNow());

    expect(transcript()).toMatchObject([{ kind: 'tool', id: 't1', status: 'declined' }]);
  });

  it('shows a subagent step on its card, also after the card finished', async () => {
    const { query } = queued([
      [
        init('s1'),
        assistant('m1', [
          { type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'Survey', prompt: 'go' } },
        ]),
        assistant('sub1', [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'TODO' } }], 'agent1'),
        toolResult('agent1', 'finished'),
        assistant('sub2', [{ type: 'tool_use', id: 'g2', name: 'Glob', input: { pattern: '*.ts' } }], 'agent1'),
        success(),
      ],
    ]);
    const { agent, events, transcript } = harness(query);

    await agent.send(text, signalNow());

    const progress = events.filter((event) => event.type === 'tool-progress').map((event) => event.text);
    expect(progress).toEqual(['Search for TODO\n', 'Find files *.ts\n']);
    expect(transcript()).toMatchObject([{ kind: 'tool', id: 'agent1', status: 'done' }]);
  });

  it('closes a card whose result never came when the run fails', async () => {
    const { query, close } = fakeQuery(async function* () {
      yield init('s1');
      yield assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }]);
      throw new Error('network down');
    });
    const { agent, transcript } = harness(query);

    await expect(agent.send(text, signalNow())).rejects.toThrow('network down');

    expect(transcript()).toMatchObject([{ kind: 'tool', id: 't1', status: 'error', summary: 'Run command (stopped)' }]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeAgent: permission prompts', () => {
  it('asks in Ask mode and allows the call when approved', async () => {
    let decided: Awaited<ReturnType<CanUseTool>> | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!('Write', { file_path: 'a.txt', content: 'x' }, details('t1'));
      yield success();
    });
    const { agent, requestApproval, events } = harness(query, { approvalMode: 'ask' });

    await agent.send(text, signalNow());

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(decided).toEqual({ behavior: 'allow', updatedInput: { file_path: 'a.txt', content: 'x' } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-start', id: 't1', awaitingApproval: true }));
    expect(events).toContainEqual({ type: 'tool-running', id: 't1' });
  });

  it('denies with the feedback sent back to the model', async () => {
    let decided: PermissionResult | null | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!('Write', { file_path: 'a.txt' }, details('t1'));
      yield success();
    });
    const { agent } = harness(query, { requestApproval: async () => ({ approved: false, feedback: 'use b.txt' }) });

    await agent.send(text, signalNow());

    expect(decided).toEqual({ behavior: 'deny', message: 'The user declined this action and said: use b.txt' });
  });

  it('denies without feedback and interrupts the turn', async () => {
    let decided: PermissionResult | null | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!('Write', { file_path: 'a.txt' }, details('t1'));
      yield success();
    });
    const { agent } = harness(query, { requestApproval: async () => ({ approved: false }) });

    await agent.send(text, signalNow());

    expect(decided).toEqual({
      behavior: 'deny',
      message: 'The user declined this action. Wait for further instructions.',
      interrupt: true,
    });
  });

  it('allows an ordinary call in Auto mode without asking', async () => {
    let decided: PermissionResult | null | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!('Write', { file_path: 'a.txt' }, details('t1'));
      yield success();
    });
    const { agent, requestApproval, events } = harness(query, { approvalMode: 'auto' });

    await agent.send(text, signalNow());

    expect(decided).toMatchObject({ behavior: 'allow' });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-start', id: 't1', awaitingApproval: false }));
  });

  it('asks in Auto mode for MCP tools and for leaving plan mode', async () => {
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      await params.options!.canUseTool!('mcp__docs__search', { q: 'x' }, details('t1'));
      await params.options!.canUseTool!('ExitPlanMode', { plan: 'Do it' }, details('t2'));
      yield success();
    });
    const { agent, requestApproval } = harness(query, { approvalMode: 'auto' });

    await agent.send(text, signalNow());

    expect(requestApproval.mock.calls.map(([id]) => id)).toEqual(['t1', 't2']);
  });

  it('asks in Auto mode for a write while in plan mode until the plan is approved', async () => {
    const decisions: (PermissionResult | null)[] = [];
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      const can = params.options!.canUseTool!;
      decisions.push(await can('Write', { file_path: 'a.txt' }, details('w1')));
      decisions.push(
        await can(
          'ExitPlanMode',
          { plan: 'Plan' },
          details('p1', {
            suggestions: [
              { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
              { type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' },
              { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
            ],
          } as Partial<Details>),
        ),
      );
      decisions.push(await can('Write', { file_path: 'b.txt' }, details('w2')));
      yield success();
    });
    const { agent, requestApproval } = harness(query, {
      approvalMode: 'auto',
      planMode: true,
      requestApproval: async () => ({ approved: true }),
    });

    await agent.send(text, signalNow());

    expect(requestApproval.mock.calls.map(([id]) => id)).toEqual(['w1', 'p1']);
    expect(decisions[0]).toMatchObject({ behavior: 'allow' });
    expect(decisions[1]).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'Plan' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(decisions[2]).toMatchObject({ behavior: 'allow' });
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('keeps asking for writes when the plan was not approved', async () => {
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      await params.options!.canUseTool!('ExitPlanMode', { plan: 'Plan' }, details('p1'));
      await params.options!.canUseTool!('Write', { file_path: 'a.txt' }, details('w1'));
      yield success();
    });
    const { agent, requestApproval } = harness(query, {
      approvalMode: 'auto',
      planMode: true,
      requestApproval: async () => ({ approved: false }),
    });

    await agent.send(text, signalNow());

    expect(requestApproval.mock.calls.map(([id]) => id)).toEqual(['p1', 'w1']);
  });

  it('denies a pending call when the run is stopped, and does not allow it', async () => {
    let decided: PermissionResult | null | undefined;
    const controller = new AbortController();
    const { query, close, interrupt } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!('Write', { file_path: 'a.txt' }, details('t1'));
    });
    const { agent, requestApproval } = harness(query, {
      requestApproval: (_id, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve({ approved: false }))),
    });

    const run = agent.send(text, controller.signal);
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalled());
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(decided).toMatchObject({ behavior: 'deny' });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
  });
});

describe('ClaudeCodeAgent: how a run ends', () => {
  it('throws AbortError without starting a query when the signal is already aborted', async () => {
    const { query, calls } = queued([[init('s1'), success()]]);
    const controller = new AbortController();
    controller.abort();

    await expect(harness(query).agent.send(text, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('throws AbortError when the stopped run ends without a result', async () => {
    const controller = new AbortController();
    const { query, close } = fakeQuery(async function* () {
      yield init('s1');
      controller.abort();
    });

    await expect(harness(query).agent.send(text, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalled();
  });

  it('rethrows a query that throws synchronously without closing anything', async () => {
    const query: QueryFunction = () => {
      throw new Error('spawn failed');
    };

    await expect(harness(query).agent.send(text, signalNow())).rejects.toThrow('spawn failed');
  });

  it('rethrows the error of a run that throws while streaming', async () => {
    const { query, close } = fakeQuery(async function* () {
      yield init('s1');
      throw new Error('stream broke');
    });

    await expect(harness(query).agent.send(text, signalNow())).rejects.toThrow('stream broke');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a run that ends without any result as incomplete', async () => {
    const { query, close } = queued([[init('s1')]]);

    await expect(harness(query).agent.send(text, signalNow())).rejects.toThrow('ended before it finished');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a result that is an error', async () => {
    const { query } = queued([[init('s1'), failed('error_during_execution', ['Something broke'])]]);

    await expect(harness(query).agent.send(text, signalNow())).rejects.toThrow('Something broke');
  });

  it.each([
    ['a thrown error', (missing: string) => Promise.reject(new Error(missing))],
    ['an error result', null],
  ])('clears the saved session on a missing session from %s and does not retry', async (_label, thrown) => {
    const missing = 'No conversation found with session ID: old';
    const runs = vi.fn();
    const { query } = fakeQuery(async function* () {
      runs();
      if (thrown) await thrown(missing);
      yield failed('error_during_execution', [missing]);
    });
    const { agent, conversation, checkpoints } = harness(query, {
      sessionId: 'old',
      sessionUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    });

    await expect(agent.send(text, signalNow())).rejects.toThrow('no longer has this chat’s session');

    expect(conversation.sessionId).toBeNull();
    expect(conversation.sessionUsage).toBeNull();
    expect(checkpoints).toHaveBeenCalled();
    expect(runs).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeAgent: cancelled calls', () => {
  it('does not show, ask about or allow a call whose own signal is already aborted, even in Auto mode', async () => {
    let decided: PermissionResult | null | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!(
        'Write',
        { file_path: 'a.txt' },
        details('t1', { signal: AbortSignal.abort() }),
      );
      yield success();
    });
    const { agent, requestApproval, events } = harness(query, { approvalMode: 'auto' });

    await agent.send(text, signalNow());

    expect(decided).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'tool-start')).toBe(false);
  });

  it('does not allow a call approved after its signal aborted', async () => {
    let decided: PermissionResult | null | undefined;
    const controller = new AbortController();
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!(
        'Write',
        { file_path: 'a.txt' },
        details('t1', { signal: controller.signal }),
      );
      yield success();
    });
    const { agent, events } = harness(query, {
      requestApproval: async () => {
        controller.abort();
        return { approved: true };
      },
    });

    await agent.send(text, signalNow());

    expect(decided).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool-running' }));
  });
});

describe('ClaudeCodeAgent: how a run ends, continued', () => {
  it('reports a success result that says it is an error with its text', async () => {
    const { query } = queued([[init('s1'), success({}, { is_error: true, result: 'Model refused' })]]);

    await expect(harness(query).agent.send(text, signalNow())).rejects.toThrow('Model refused');
  });

  it('keeps the original outcome when closing the query throws', async () => {
    const complete = fakeQuery(async function* () {
      yield init('s1');
      yield success();
    });
    complete.close.mockImplementation(() => {
      throw new Error('close broke');
    });
    await expect(harness(complete.query).agent.send(text, signalNow())).resolves.toBe(false);

    const failing = fakeQuery(async function* () {
      yield init('s1');
      throw new Error('stream broke');
    });
    failing.close.mockImplementation(() => {
      throw new Error('close broke');
    });
    await expect(harness(failing.query).agent.send(text, signalNow())).rejects.toThrow('stream broke');
  });
});

describe('ClaudeCodeAgent: per-block streaming, retries and usage in one query', () => {
  it('shows each block as it completes, in the order the SDK sends them', async () => {
    const { query } = queued([
      [
        init('s1'),
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } }),
        assistant('m1', [{ type: 'thinking', thinking: 'Hmm' }]),
        streamEvent({ type: 'content_block_stop', index: 0 }),
        streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
        streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
        assistant('m1', [{ type: 'text', text: 'Hello' }]),
        streamEvent({ type: 'content_block_stop', index: 1 }),
        streamEvent({ type: 'message_stop' }),
        success(),
      ],
    ]);
    const { agent, transcript } = harness(query);

    await agent.send(text, signalNow());

    expect(transcript()).toMatchObject([{ kind: 'assistant', text: 'Hello', thinking: 'Hmm', streaming: false }]);
  });

  it('shows an API retry as a notice with its status, delay and attempt', async () => {
    const { query } = queued([
      [
        init('s1'),
        msg({
          type: 'system',
          subtype: 'api_retry',
          error_status: 529,
          retry_delay_ms: 2000,
          attempt: 2,
          max_retries: 10,
        }),
        success(),
      ],
    ]);
    const { agent, events } = harness(query);

    await agent.send(text, signalNow());

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        text: 'Claude Code request failed (529). Retrying in 2 s (retry 2 of 10)…',
      }),
    );
  });

  it('counts each request once and the cumulative totals once across results of one query', async () => {
    const a = { in: 100, out: 20, read: 30, write: 40 };
    const b = { in: 150, out: 25, read: 45, write: 60 };
    const model = 'claude-opus-5-5';
    const one = (totals: { in: number; out: number; read: number; write: number }) => ({
      [model]: usage(totals.in, totals.out, totals.read, totals.write),
    });
    const { query } = queued([
      [
        init('s1'),
        assistant('msg1', [{ type: 'text', text: 'first' }]),
        success(one(a)),
        assistant('msg2', [{ type: 'text', text: 'second' }]),
        success(one(b)),
        assistant('msg2', [{ type: 'text', text: 'second' }]),
        success(one(b)),
      ],
    ]);
    const { agent, counts } = harness(query);

    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 45, cacheWriteTokens: 60 });
    expect(agent.totals.requests).toBe(2);
  });
});

describe('ClaudeCodeAgent: the PreToolUse hook', () => {
  function hook(params: Params) {
    const [matcher] = params.options!.hooks!.PreToolUse!;
    const run = (tool_name: string, tool_input: Record<string, unknown>) =>
      matcher!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name, tool_input } as unknown as HookInput, 'id', {
        signal: signalNow(),
      });
    return { matcher: matcher!.matcher!, run };
  }

  it('asks for MCP tools, ExitPlanMode and sandbox-disabled commands only', async () => {
    let hooked: ReturnType<typeof hook> | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      hooked = hook(params);
      yield success();
    });
    await harness(query).agent.send(text, signalNow());

    const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
    expect(new RegExp(hooked!.matcher).test('mcp__docs__search')).toBe(true);
    expect(new RegExp(hooked!.matcher).test('Write')).toBe(false);
    expect(await hooked!.run('mcp__docs__search', {})).toEqual(ask);
    expect(await hooked!.run('ExitPlanMode', { plan: 'x' })).toEqual(ask);
    expect(await hooked!.run('Bash', { command: 'npm test', dangerouslyDisableSandbox: true })).toEqual(ask);
    expect(await hooked!.run('Bash', { command: 'npm test' })).toEqual({});
    expect(await hooked!.run('Write', { file_path: 'a.txt' })).toEqual({});
  });

  it('asks for a sandbox-disabled command in Auto mode too', async () => {
    let decided: PermissionResult | null | undefined;
    const { query } = fakeQuery(async function* (params) {
      yield init('s1');
      decided = await params.options!.canUseTool!(
        'Bash',
        { command: 'ls', dangerouslyDisableSandbox: true },
        details('b1'),
      );
      yield success();
    });
    const { agent, requestApproval } = harness(query, { approvalMode: 'auto' });

    await agent.send(text, signalNow());

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(decided).toMatchObject({ behavior: 'allow' });
  });
});

describe('ClaudeCodeAgent: usage', () => {
  const A = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };
  const model = 'claude-opus-5-5';
  const one = (totals: Record<string, number>) => ({
    [model]: usage(totals.in!, totals.out!, totals.read!, totals.write!),
  });
  const a = { in: 100, out: 20, read: 30, write: 40 };
  const b = { in: 150, out: 25, read: 45, write: 60 };

  it('counts the first result, and not a repeat of it', async () => {
    const { query } = queued([[init('s1'), success(one(a))], [success(one(a))]]);
    const { agent, counts } = harness(query);

    await agent.send(text, signalNow());
    expect(counts()).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
    await agent.send(text, signalNow());
    expect(counts()).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
  });

  it('adds only the growth of a cumulative session total', async () => {
    const { query } = queued([[init('s1'), success(one(a))], [success(one(b))]]);
    const { agent, counts } = harness(query);

    await agent.send(text, signalNow());
    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 45, cacheWriteTokens: 60 });
  });

  it('continues from a restored baseline and totals without counting the earlier result again', async () => {
    const { query } = queued([[init('s1'), success(one(b))]]);
    const { agent, counts } = harness(query, { sessionId: 's1', sessionUsage: A });
    agent.totals = A;

    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 45, cacheWriteTokens: 60 });
  });

  it('sums the usage of every model in one result', async () => {
    const { query } = queued([
      [
        init('s1'),
        success({
          'claude-opus-5-5': usage(60, 10, 10, 15),
          'claude-haiku-5-5': usage(40, 10, 20, 25),
        }),
      ],
    ]);
    const { agent, counts } = harness(query);

    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
  });

  it('counts a request once per assistant message id, subagents included', async () => {
    const { query } = queued([
      [
        init('s1'),
        assistant('msg1', [{ type: 'text', text: 'a' }]),
        assistant('msg1', [{ type: 'text', text: 'a' }]),
        assistant('sub1', [], 'agent1'),
        assistant('msg2', [{ type: 'text', text: 'b' }]),
        success(one(a)),
      ],
    ]);
    const { agent } = harness(query);

    await agent.send(text, signalNow());

    expect(agent.totals.requests).toBe(3);
  });

  it('keeps the baseline when an error result has zero usage, so the next result is not counted twice', async () => {
    const zero = { [model]: usage(0, 0) };
    const { query } = queued([
      [init('s1'), success(one(a))],
      [failed('error_during_execution', ['crash'], zero)],
      [success(one(b))],
    ]);
    const { agent, conversation, counts } = harness(query);

    await agent.send(text, signalNow());
    await agent.send(text, signalNow()).catch(() => undefined);
    expect(conversation.sessionUsage).toEqual(A);
    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 45, cacheWriteTokens: 60 });
  });

  it('counts a new session in full after a reset, on top of the old session', async () => {
    const { query } = queued([
      [init('s1'), success(one(a))],
      [
        msg({ type: 'conversation_reset', new_conversation_id: 's2', reason: 'clear' }),
        success({ [model]: usage(200, 40, 60, 80) }),
      ],
    ]);
    const { agent, conversation, counts } = harness(query);

    await agent.send(text, signalNow());
    await agent.send(text, signalNow());

    expect(conversation.sessionId).toBe('s2');
    expect(counts()).toEqual({ inputTokens: 300, outputTokens: 60, cacheReadTokens: 90, cacheWriteTokens: 120 });
  });

  it('counts the totals of a session that went down as new usage', async () => {
    const { query } = queued([[init('s1'), success(one(a))], [success({ [model]: usage(10, 2, 3, 4) })]]);
    const { agent, counts } = harness(query);

    await agent.send(text, signalNow());
    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 110, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });

  it('clears the baseline when Claude Code starts a different session', async () => {
    const { query } = queued([[init('s2'), success({ [model]: usage(10, 2, 3, 4) })]]);
    const { agent, counts } = harness(query, { sessionId: 's1', sessionUsage: A });
    agent.totals = A;

    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 110, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });

  it('clears the baseline when the session is missing', async () => {
    const { query } = queued([
      [failed('error_during_execution', ['No conversation found with session ID: old'])],
      [init('s2'), success({ [model]: usage(10, 2, 3, 4) })],
    ]);
    const { agent, conversation, counts } = harness(query, { sessionId: 'old', sessionUsage: A });
    agent.totals = A;

    await expect(agent.send(text, signalNow())).rejects.toThrow();
    expect(conversation.sessionUsage).toBeNull();
    await agent.send(text, signalNow());

    expect(counts()).toEqual({ inputTokens: 110, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });
});

describe('ClaudeCodeAgent: compacting', () => {
  it('says there is nothing to compact without a session', async () => {
    const { query, calls } = queued([]);
    const { agent, events } = harness(query);

    await agent.compact(signalNow());

    expect(calls).toHaveLength(0);
    expect(events).toMatchObject([{ type: 'notice', text: 'There is nothing to compact yet.' }]);
  });

  it('runs /compact in the saved session', async () => {
    const { query, calls } = queued([[init('s1'), success()]]);
    const { agent } = harness(query, { sessionId: 's1' });

    await agent.compact(signalNow());

    expect(calls[0]!.options).toMatchObject({ resume: 's1' });
    expect((await promptOf(calls[0]!))[0]!.message.content).toEqual([{ type: 'text', text: '/compact' }]);
  });

  it('reports a compact-boundary notice from Claude Code', async () => {
    const { query } = queued([
      [
        init('s1'),
        msg({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { pre_tokens: 1000, post_tokens: 200 },
        }),
        success(),
      ],
    ]);
    const { agent, events } = harness(query, { sessionId: 's1' });

    await agent.compact(signalNow());

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        text: 'Claude Code compacted the conversation (1,000 tokens before).',
      }),
    );
  });
});
