// Measures the agent's own machinery, not the model: how long the app takes per turn, per tool call, per approval,
// per crash-resume checkpoint save, per subagent run and per MCP call. Runs in Node without the app, with a scripted
// model that answers instantly, so every millisecond measured is Patch's own work. Not part of `npm test`; run
// `npm run perf`. Numbers vary by machine, so this prints them rather than asserting limits. Results are recorded in
// docs/PERFORMANCE.md ("The agent loop").
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, it } from 'vitest';
import { z } from 'zod';
import type { UsageTotals } from '../../src/shared/chat';
import { Agent } from '../../src/main/agent/agent';
import type { SavedChat } from '../../src/main/agent/session';
import { ChatStore } from '../../src/main/chat_store';
import type { Conversation, ToolCall, TurnRequest, TurnResult } from '../../src/main/llm/types';
import { readFileTool } from '../../src/main/tools/files';
import { McpHub } from '../../src/main/tools/mcp';
import { createTaskTool } from '../../src/main/tools/task';
import { defineTool, type AgentTool, type ToolContext } from '../../src/main/tools/types';
import { Workspace } from '../../src/main/tools/workspace';
import { transcript } from './long_transcript';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

// A model that answers instantly: `step(turn)` says what the turn returns (tool calls or a final answer).
class InstantConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'claude-opus-5-5';
  private turn = 0;
  constructor(private readonly step: (turn: number) => Partial<TurnResult>) {}
  addUserMessage(): void {}
  addToolResults(): void {}
  async runTurn(_request: TurnRequest): Promise<TurnResult> {
    const partial = this.step(this.turn++);
    return {
      text: '',
      toolCalls: [],
      contextTokens: 1,
      usage: USAGE,
      stopReason: partial.toolCalls?.length ? 'tool_use' : 'end_turn',
      ...partial,
    };
  }
  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }
  planCompaction() {
    return null;
  }
  applyCompaction(): void {}
  hasPendingToolCalls(): boolean {
    return false;
  }
}

const noop = defineTool({
  name: 'noop',
  description: 'Does nothing.',
  schema: z.object({ n: z.number() }),
  requiresApproval: false,
  async run() {
    return { content: 'ok' };
  },
});

const approved = defineTool({
  name: 'approved',
  description: 'Does nothing after approval.',
  schema: z.object({ n: z.number() }),
  requiresApproval: true,
  async run() {
    return { content: 'ok' };
  },
});

function calls(name: string, count: number, input: (index: number) => unknown): ToolCall[] {
  return Array.from({ length: count }, (_, index) => ({ id: `call-${index}`, name, input: input(index) }));
}

function context(workspace: Workspace | null = null): ToolContext {
  return {
    workspace: workspace as never,
    signal: new AbortController().signal,
    readFiles: new Map(),
    shell: null as never,
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
}

function agent(conversation: Conversation, tools: AgentTool[], workspace: Workspace | null = null): Agent {
  return new Agent({
    conversation,
    system: 'system prompt',
    tools: () => tools,
    approvalMode: () => 'ask',
    requestApproval: async () => ({ approved: true }),
    toolContext: (signal, onProgress) => ({ ...context(workspace), signal, onProgress }),
    emit: () => {},
  });
}

// The median of `runs` timings, after `warmups` untimed runs (so the JIT has compiled the code being measured).
async function median(runs: number, work: () => Promise<void> | void, warmups = 1): Promise<number> {
  for (let warmup = 0; warmup < warmups; warmup++) await work();
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

interface Row {
  scenario: string;
  ms: number;
  per: string;
  perUs: number;
}
const rows: Row[] = [];
const record = (scenario: string, ms: number, count: number, unit: string) =>
  rows.push({ scenario, ms: round(ms, 2), per: unit, perUs: Math.round((ms * 1000) / count) });

describe('agent loop: the app’s own work per turn, tool call and save', () => {
  let dir: string;

  afterAll(() => {
    console.log('\nAgent loop (instant scripted model; median of repeated runs)\n');
    console.table(rows);
    mkdirSync(join(__dirname, '../../out'), { recursive: true });
    writeFileSync(join(__dirname, '../../out/perf-agent-loop.json'), JSON.stringify({ rows }, null, 2));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('turns without tools', async () => {
    const turns = 200;
    const ms = await median(5, async () => {
      const loop = agent(new InstantConversation(() => ({ text: 'Done.' })), []);
      for (let turn = 0; turn < turns; turn++) await loop.send({ text: 'hi' }, new AbortController().signal);
    });
    record(`${turns} turns, no tools`, ms, turns, 'turn');
  });

  for (const batch of [1, 10, 50]) {
    it(`a batch of ${batch} tool calls`, async () => {
      const ms = await median(20, () =>
        agent(
          new InstantConversation((turn) => (turn === 0 ? { toolCalls: calls('noop', batch, (n) => ({ n })) } : {})),
          [noop],
        )
          .send({ text: 'go' }, new AbortController().signal)
          .then(() => {}),
      );
      record(`1 batch of ${batch} no-op tool calls (+ final turn)`, ms, batch, 'tool call');
    });
  }

  it('approvals', async () => {
    const batch = 20;
    const ms = await median(20, () =>
      agent(
        new InstantConversation((turn) => (turn === 0 ? { toolCalls: calls('approved', batch, (n) => ({ n })) } : {})),
        [approved],
      )
        .send({ text: 'go' }, new AbortController().signal)
        .then(() => {}),
    );
    record(`${batch} tool calls, each approved at once`, ms, batch, 'tool call');
  });

  it('real read_file calls', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-perf-agent-'));
    const files = 20;
    for (let index = 0; index < files; index++) {
      writeFileSync(join(dir, `file${index}.ts`), `// file ${index}\n${'const x = 1;\n'.repeat(300)}`);
    }
    const workspace = new Workspace(dir);
    const ms = await median(20, () =>
      agent(
        new InstantConversation((turn) =>
          turn === 0 ? { toolCalls: calls('read_file', files, (n) => ({ path: `file${n}.ts` })) } : {},
        ),
        [readFileTool as AgentTool],
        workspace,
      )
        .send({ text: 'read them' }, new AbortController().signal)
        .then(() => {}),
    );
    record(`${files} read_file calls (4 KB files)`, ms, files, 'tool call');
  });

  // What a crash-resume checkpoint costs: ChatStore.save writes the whole chat and the index, synchronously, on the
  // main process. A saved chat holds the transcript and the provider conversation, which repeats the same content in
  // the provider's format, plus any screenshots the browser tool returned.
  for (const { turns, screenshots } of [
    { turns: 250, screenshots: 0 },
    { turns: 1000, screenshots: 0 },
    { turns: 4000, screenshots: 0 },
    { turns: 1000, screenshots: 10 },
  ]) {
    it(`checkpoint save: ${turns * 5} items, ${screenshots} screenshots`, async () => {
      const store = new ChatStore(mkdtempSync(join(tmpdir(), 'patch-perf-chats-')));
      // A 1280x800 browser screenshot as PNG is roughly 150 KB, about 200 KB as base64.
      const image = 'A'.repeat(200_000);
      const items = transcript(turns);
      const chat: SavedChat = {
        version: 1,
        id: '00000000-0000-4000-8000-000000000000',
        title: 'Benchmark',
        projectPath: dir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        system: 'system prompt',
        transcript: items,
        usage: USAGE as UsageTotals,
        conversation: {
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          messages: [
            ...items.map((item) => ({
              role: item.kind === 'user' ? 'user' : 'assistant',
              content: JSON.stringify(item),
            })),
            ...Array.from({ length: screenshots }, () => ({
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }],
            })),
          ],
        },
        readFiles: [],
      };
      const mb = round(JSON.stringify(chat, null, 2).length / 1e6);
      const label = `${turns * 5} items + ${screenshots} screenshots (${mb} MB)`;
      const stringifyMs = await median(15, () => void JSON.stringify(chat, null, 2), 3);
      const saveMs = await median(15, () => void store.save(chat), 3);
      record(`checkpoint: JSON.stringify only, ${label}`, stringifyMs, 1, 'save');
      record(`checkpoint: ChatStore.save (stringify + write + index), ${label}`, saveMs, 1, 'save');

      // A checkpoint of a chat that is already listed: the chat is serialized in the call and the file is written in
      // the background. `busy` is the time the main thread worked from the call until the file was in place (the
      // rest of that time it was free for other events), measured with the event loop's own utilization counter.
      const call: number[] = [];
      const busy: number[] = [];
      const landed: number[] = [];
      for (let run = -3; run < 15; run++) {
        const idle = performance.eventLoopUtilization();
        const start = performance.now();
        store.save(chat, true);
        const returned = performance.now() - start;
        await store.flush();
        if (run < 0) continue;
        call.push(returned);
        busy.push(performance.eventLoopUtilization(idle).active);
        landed.push(performance.now() - start);
      }
      const middle = (times: number[]) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
      record(`checkpoint of a listed chat: the save call, ${label}`, middle(call), 1, 'save');
      record(`checkpoint of a listed chat: main thread busy until on disk, ${label}`, middle(busy), 1, 'save');
      record(`checkpoint of a listed chat: until on disk, ${label}`, middle(landed), 1, 'save');
    });
  }

  it('subagent (task tool)', async () => {
    const batch = 5;
    const task = createTaskTool({
      createConversation: () =>
        new InstantConversation((turn) =>
          turn === 0
            ? { toolCalls: calls('read_file', batch, (n) => ({ path: `file${n}.ts` })) }
            : { text: 'Found it.' },
        ),
      system: 'system prompt',
      tools: () => [readFileTool as AgentTool],
    });
    const workspace = new Workspace(dir);
    const ms = await median(20, () => task.run({ task: 'Find it' }, context(workspace)).then(() => {}));
    record(`subagent run: ${batch} read_file calls + answer`, ms, 1, 'run');
  });

  it('MCP over stdio', async () => {
    const server = join(__dirname, '../e2e/mock_mcp_server.mjs');
    const hub = new McpHub(
      () => [{ name: 'bench', transport: 'stdio', command: process.execPath, args: [server] }],
      () => {},
    );
    try {
      const connect = performance.now();
      await hub.refresh();
      record('MCP stdio server: start, connect, list tools', performance.now() - connect, 1, 'connect');
      const echo = hub.tools()[0]!;
      const callsPerRun = 50;
      const ms = await median(5, async () => {
        for (let index = 0; index < callsPerRun; index++) await echo.run({ text: `hi ${index}` }, context());
      });
      record(`${callsPerRun} MCP tool calls (echo), one after another`, ms, callsPerRun, 'call');
    } finally {
      await hub.stop();
    }
  });
});
