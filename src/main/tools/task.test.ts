import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TurnResult, TurnRequest, UserInput } from '../llm/types';
import type { Conversation, ToolResult } from '../llm/types';
import { SUBAGENT_MAX_TURNS } from '../agent/agent';
import { AnthropicConversation, createAnthropicClient } from '../llm/anthropic';
import { editFileTool } from './files';
import { defineTool, type ToolContext } from './types';
import { createFinderTool, createOracleTool, createTaskTool, subagentConversation } from './task';
import { Workspace } from './workspace';

type Step = Partial<TurnResult> | ((request: TurnRequest) => Promise<Partial<TurnResult>>);

// Same idea as the agent loop tests: a conversation that replays scripted turns.
class ScriptedConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly users: UserInput[] = [];
  readonly requests: TurnRequest[] = [];
  turns = 0;

  constructor(
    private readonly steps: Step[],
    readonly model: string = 'test-model',
  ) {}

  addUserMessage(input: UserInput): void {
    this.users.push(input);
  }

  addToolResults(results: ToolResult[]): void {
    this.toolResults.push(results);
  }

  toolResults: ToolResult[][] = [];

  discardLastUserMessage(): void {}

  hasPendingToolCalls(): boolean {
    return false;
  }

  planCompaction() {
    return null;
  }

  applyCompaction(): void {}

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    this.requests.push(request);
    const step = this.steps[this.turns++];
    if (!step) throw new Error('unexpected extra turn');
    const partial = typeof step === 'function' ? await step(request) : step;
    return {
      text: '',
      toolCalls: [],
      contextTokens: 0,
      stopReason: partial.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...partial,
    };
  }

  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }
}

const readTool = defineTool({
  name: 'read_file',
  description: 'read',
  schema: z.object({ path: z.string() }),
  requiresApproval: false,
  async run({ path }, context) {
    context.readFiles.set(context.workspace.resolve(path), 'hash');
    return { content: 'file contents', summary: `Read ${path}` };
  },
});

function context(signal = new AbortController().signal, readFiles = new Map<string, string | null>()): ToolContext {
  return {
    workspace: null as never,
    signal,
    readFiles,
    shell: null as never,
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
}

describe('task tool (subagent)', () => {
  it('runs a read-only subagent and returns its answer with usage', async () => {
    const ran: string[] = [];
    const reading = defineTool({
      name: 'read_file',
      description: 'read',
      schema: z.object({ path: z.string() }),
      requiresApproval: false,
      async run({ path }) {
        ran.push(`read:${path}`);
        return { content: 'file contents', summary: `Read ${path}` };
      },
    });
    // Must never run: the subagent only gets the read-only subset.
    const writeTool = defineTool({
      name: 'write_file',
      description: 'write',
      schema: z.object({ path: z.string(), content: z.string() }),
      requiresApproval: true,
      async run() {
        ran.push('write');
        return { content: 'written' };
      },
    });
    const conversation = new ScriptedConversation([
      { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
      { text: 'The answer is 42.' },
    ]);
    const taskTool = createTaskTool({
      createConversation: () => conversation,
      system: 'system prompt',
      tools: () => [reading, writeTool],
    });

    const progress: string[] = [];
    const output = await taskTool.run(
      { task: 'Find the answer in a.ts' },
      {
        ...context(),
        onProgress: (text: string) => progress.push(text),
      },
    );

    expect(ran).toEqual(['read:a.ts']);
    expect(output.content).toContain('The answer is 42.');
    expect(output.content).toContain('Subagent token usage: 4 in / 2 out');
    expect(output.isError).toBeUndefined();
    expect(output.summary).toContain('Find the answer in a.ts');
    // Progress lines end with a newline, so the card does not run them together.
    expect(progress).toContain('[done] Read a.ts\n');
    expect(progress).toContain('The answer is 42.\n');
    // The subagent is told it is read-only, instead of inheriting the parent's "edit files" instructions alone.
    expect(conversation.requests[0]?.system).toContain('read-only research subagent');
    expect(conversation.requests[0]?.tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('does not offer write, network, plan or nested task tools', async () => {
    const names = [
      'write_file',
      'edit_file',
      'run_command',
      'fetch_url',
      'browser',
      'propose_plan',
      'task',
      'mcp_docs_search',
      'load_skill',
    ];
    const tools = names.map((name) =>
      defineTool({
        name,
        description: name,
        schema: z.object({}),
        requiresApproval: false,
        async run() {
          return { content: 'ran' };
        },
      }),
    );
    const conversation = new ScriptedConversation([{ text: 'Nothing to see.' }]);
    const taskTool = createTaskTool({
      createConversation: () => conversation,
      system: 'system prompt',
      tools: () => [readTool, ...tools],
    });
    await taskTool.run({ task: 'Look around' }, context());
    // load_skill only reads project skill files, so it is the one extra tool the subagent keeps.
    expect(conversation.requests[0]?.tools.map((tool) => tool.name)).toEqual(['read_file', 'load_skill']);
  });

  it("on the chat's model, sends the chat's exact prompt and tools so the cached prefix is reused, and runs only read-only tools", async () => {
    const ran: string[] = [];
    const writeTool = defineTool({
      name: 'write_file',
      description: 'write a file',
      strictInput: true,
      schema: z.object({ path: z.string(), content: z.string() }),
      requiresApproval: true,
      async run() {
        ran.push('write');
        return { content: 'written' };
      },
    });
    const parentTools = [readTool, writeTool];
    const conversation = new ScriptedConversation([
      { toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'a.ts', content: 'x' } }] },
      { text: 'I could not write, so here is what I read.' },
    ]);
    const taskTool = createTaskTool({
      createConversation: () => conversation,
      system: 'system prompt',
      tools: () => parentTools,
      chatModel: conversation.model,
    });

    const output = await taskTool.run({ task: 'Fix a.ts' }, context());

    const request = conversation.requests[0]!;
    // Byte-identical start of the request: the chat's system prompt and every tool with the same name, description
    // and schema, in the same order.
    expect(request.system).toBe('system prompt');
    expect(request.tools.map((tool) => [tool.name, tool.description, tool.schema])).toEqual(
      parentTools.map((tool) => [tool.name, tool.description, tool.schema]),
    );
    expect(request.tools[1]?.strictInput).toBe(true);
    // The role moves into the first message instead.
    expect(conversation.users[0]?.text).toContain('read-only research subagent');
    expect(conversation.users[0]?.text).toContain('# Delegated question\nFix a.ts');
    // The write tool is a stand-in: the real one never runs, and the model is told why.
    expect(ran).toEqual([]);
    expect(conversation.toolResults[0]?.[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(conversation.toolResults[0])).toContain('not available to a read-only subagent');
    expect(output.content).toContain('I could not write');
  });

  it('keeps the short read-only prompt on a model other than the chat', async () => {
    const conversation = new ScriptedConversation([{ text: 'Done.' }]);
    const taskTool = createTaskTool({
      createConversation: () => conversation,
      system: 'system prompt',
      tools: () => [readTool],
      chatModel: 'some-other-model',
    });
    await taskTool.run({ task: 'Look' }, context());
    expect(conversation.requests[0]?.system).toContain('read-only research subagent');
    expect(conversation.users[0]?.text).toBe('Look');
  });

  it('does not count a file the subagent read as read by the parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-task-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'original\n');
      const workspace = new Workspace(root);
      const parentReads = new Map<string, string | null>();
      const conversation = new ScriptedConversation([
        { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
        { text: 'It says original.' },
      ]);
      const taskTool = createTaskTool({
        createConversation: () => conversation,
        system: 'system prompt',
        tools: () => [readTool],
      });
      await taskTool.run({ task: 'Read a.ts' }, { ...context(), workspace, readFiles: parentReads });

      expect(parentReads.size).toBe(0);
      const preview = editFileTool.preview;
      expect(preview).toBeTypeOf('function');
      await expect(
        preview!(
          { path: 'a.ts', old_string: 'original', new_string: 'changed' },
          { ...context(), workspace, readFiles: parentReads },
        ),
      ).rejects.toThrow(/has not been read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an error result when the subagent returns no answer', async () => {
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation([{ text: '' }]),
      system: 'system prompt',
      tools: () => [],
    });
    const output = await taskTool.run({ task: 'Look around' }, context());
    expect(output.isError).toBe(true);
    expect(output.content).toContain('did not finish');
  });

  it('does not treat interim text as the answer when the turn cap is hit', async () => {
    const steps = Array.from({ length: SUBAGENT_MAX_TURNS }, () => ({
      text: 'Let me check the callers…',
      toolCalls: [{ id: 't', name: 'read_file', input: { path: 'a.ts' } }],
    }));
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation(steps),
      system: 'system prompt',
      tools: () => [readTool],
    });
    const output = await taskTool.run({ task: 'Find every caller' }, context());
    expect(output.isError).toBe(true);
    expect(output.content).toContain(`${SUBAGENT_MAX_TURNS}-step limit`);
    expect(output.content).toContain('Let me check the callers');
    expect(output.summary).toContain('stopped');
  });

  it('does not treat a turn the model kept pausing as the answer', async () => {
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation([{ text: 'Searching the web…', stopReason: 'paused' }]),
      system: 'system prompt',
      tools: () => [],
    });
    const output = await taskTool.run({ task: 'Look it up' }, context());
    expect(output.isError).toBe(true);
    expect(output.content).toContain('the model paused its turn too many times');
    expect(output.content).toContain('Searching the web');
  });

  it('stops the subagent when the parent task is stopped', async () => {
    const controller = new AbortController();
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          (request) =>
            new Promise((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
              controller.abort();
            }),
        ]),
      system: 'system prompt',
      tools: () => [],
    });
    await expect(taskTool.run({ task: 'Look around' }, context(controller.signal))).rejects.toThrow(/stopped/);
  });

  it('reports a stop between turns as an unfinished run, not as the interim text', async () => {
    const controller = new AbortController();
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          () => {
            controller.abort();
            return Promise.resolve({
              text: 'Let me check the callers…',
              toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
            });
          },
        ]),
      system: 'system prompt',
      tools: () => [readTool],
    });
    const output = await taskTool.run({ task: 'Find every caller' }, context(controller.signal));
    expect(output.isError).toBe(true);
    expect(output.content).toContain('it was stopped');
    expect(output.content).toContain('Let me check the callers');
  });

  it('adds the subagent usage to the chat totals', async () => {
    const recorded: string[] = [];
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation([{ text: 'Done.' }]),
      system: 'system prompt',
      tools: () => [],
      recordUsage: (usage, model) => recorded.push(`${usage.inputTokens} on ${model}`),
    });
    await taskTool.run({ task: 'Look around' }, context());
    expect(recorded).toEqual(['2 on test-model']);
  });

  it('counts the usage of the turns that ran when the subagent fails', async () => {
    const recorded: number[] = [];
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
          () => Promise.reject(new Error('provider exploded')),
        ]),
      system: 'system prompt',
      tools: () => [readTool],
      recordUsage: (usage) => recorded.push(usage.inputTokens),
    });
    await expect(taskTool.run({ task: 'Look around' }, context())).rejects.toThrow(/provider exploded/);
    expect(recorded).toEqual([2]);
  });

  it('does not answer with an earlier turn when the final turn has no text', async () => {
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          { text: 'Let me check the callers…', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
          { text: '' },
        ]),
      system: 'system prompt',
      tools: () => [readTool],
    });
    const output = await taskTool.run({ task: 'Find every caller' }, context());
    expect(output.isError).toBe(true);
    expect(output.content).toContain('did not finish');
    expect(output.content).not.toContain('Let me check the callers');
  });
});

describe('shared prompt cache', () => {
  it("renders the same Anthropic tools and system blocks as the chat, so the subagent reads the chat's cache", async () => {
    const writeTool = defineTool({
      name: 'write_file',
      description: 'write a file',
      schema: z.object({ path: z.string(), content: z.string() }),
      requiresApproval: true,
      async run() {
        return { content: 'written' };
      },
    });
    const parentTools = [readTool, writeTool];
    const scripted = new ScriptedConversation([{ text: 'Done.' }]);
    await createTaskTool({
      createConversation: () => scripted,
      system: 'system prompt',
      tools: () => parentTools,
      chatModel: scripted.model,
    }).run({ task: 'Look' }, context());

    const anthropic = new AnthropicConversation(createAnthropicClient('sk-test', 'http://127.0.0.1:1'), {
      model: 'claude-opus-5-5',
      effort: 'high',
      messages: [],
      compaction: null,
    });
    const prefix = (request: Pick<TurnRequest, 'system' | 'tools'>) => {
      const params = anthropic.buildParams(request);
      return JSON.stringify({ tools: params.tools, system: params.system });
    };
    expect(prefix(scripted.requests[0]!)).toBe(prefix({ system: 'system prompt', tools: parentTools }));
  });
});

describe('subagentConversation', () => {
  it("starts empty on the chat's model and does not inherit the parent's compaction", () => {
    const client = createAnthropicClient('sk-test', 'http://127.0.0.1:1');
    const parent = new AnthropicConversation(client, {
      model: 'claude-opus-5-5',
      effort: 'high',
      messages: [
        { role: 'user', content: 'Refactor the parser.' },
        { role: 'assistant', content: 'Working on it.' },
        { role: 'user', content: 'Also the lexer.' },
      ],
      compaction: { summary: 'PARENT SUMMARY', keepFrom: 2 },
    });

    const subagent = subagentConversation(
      parent,
      (saved) =>
        new AnthropicConversation(client, {
          model: saved.model,
          effort: 'high',
          messages: saved.messages as never,
          compaction: saved.compaction ?? null,
        }),
    );
    subagent.addUserMessage({ text: 'Where is the lexer defined?' });

    expect(subagent.model).toBe('claude-opus-5-5');
    const sent = JSON.stringify(
      (subagent as AnthropicConversation).buildParams({ system: 'system', tools: [] }).messages,
    );
    expect(sent).toContain('Where is the lexer defined?');
    expect(sent).not.toContain('PARENT SUMMARY');
    expect(sent).not.toContain('Refactor the parser');
  });
});

describe('finder and oracle', () => {
  const options = (conversations: { chat: Conversation; finder?: Conversation }) => ({
    createConversation: () => conversations.chat,
    createFinderConversation: conversations.finder ? () => conversations.finder! : undefined,
    system: 'system prompt',
    tools: () => [readTool],
  });

  it('finder runs on its own (cheaper) conversation with a search-focused prompt', async () => {
    const chat = new ScriptedConversation([]);
    const finder = new ScriptedConversation([{ text: 'src/lexer.ts:10' }]);
    const tool = createFinderTool(options({ chat, finder }));

    const output = await tool.run(tool.schema!.parse({ query: 'where is the lexer' }), context());

    expect(output.content).toContain('src/lexer.ts:10');
    expect(output.summary).toBe('Finder: where is the lexer');
    expect(finder.users[0]!.text).toBe('where is the lexer');
    expect(finder.requests[0]!.system).toContain('codebase-search subagent');
    expect(chat.turns).toBe(0);
    expect(tool.parallelSafe).toBe(true);
  });

  it('finder falls back to the chat conversation when no small model is set', async () => {
    const chat = new ScriptedConversation([{ text: 'found it' }]);
    const tool = createFinderTool(options({ chat }));
    expect((await tool.run(tool.schema!.parse({ query: 'x' }), context())).content).toContain('found it');
    expect(chat.turns).toBe(1);
  });

  it('records the finder usage under the small model it ran on', async () => {
    const recorded: { inputTokens: number; model: string }[] = [];
    const chat = new ScriptedConversation([], 'claude-opus-5-5');
    const finder = new ScriptedConversation([{ text: 'src/lexer.ts:10' }], 'claude-haiku-5-5');
    const tool = createFinderTool({
      ...options({ chat, finder }),
      chatModel: chat.model,
      recordUsage: (usage, model) => recorded.push({ inputTokens: usage.inputTokens, model }),
    });

    await tool.run(tool.schema!.parse({ query: 'where is the lexer' }), context());

    expect(recorded).toEqual([{ inputTokens: 2, model: 'claude-haiku-5-5' }]);
  });

  it('oracle advises on the chat conversation and stays read-only', async () => {
    const chat = new ScriptedConversation([{ text: 'Do B, because of the cache.' }]);
    const tool = createOracleTool(options({ chat }));

    const output = await tool.run(tool.schema!.parse({ question: 'A or B?' }), context());

    expect(output.content).toContain('Do B, because of the cache.');
    expect(output.summary).toBe('Oracle: A or B?');
    expect(chat.requests[0]!.system).toContain('senior advisor');
    expect(chat.requests[0]!.tools.map((spec) => spec.name)).toEqual(['read_file']);
  });

  it('oracle uses its own conversation when one is given', async () => {
    const chat = new ScriptedConversation([{ text: 'from the chat factory' }]);
    const oracle = new ScriptedConversation([{ text: 'Keep the index.' }]);
    const tool = createOracleTool({
      createConversation: () => chat,
      createOracleConversation: () => oracle,
      system: 'system prompt',
      tools: () => [readTool],
    });

    const output = await tool.run(tool.schema!.parse({ question: 'Which index?' }), context());

    expect(output.content).toContain('Keep the index.');
    expect(output.summary).toBe('Oracle: Which index?');
    expect(oracle.requests[0]!.system).toContain('senior advisor');
    expect(chat.turns).toBe(0);
  });
});
