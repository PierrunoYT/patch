import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, TranscriptItem } from '../../src/shared/chat';
import type { McpServerConfig, McpStatus } from '../../src/shared/settings';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// MCP servers configured in Settings must have their tools offered to the model (namespaced and
// approval-gated), and a call must reach the server and return its output.
describe('MCP tools end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  const mockServerScript = join(__dirname, 'mock_mcp_server.mjs');

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-mcp-e2e-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    const servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    await running.page.evaluate(
      (configured) => window.api.invoke('settings:update', { mcpServers: configured }),
      servers,
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  async function mcpStatus(): Promise<McpStatus[]> {
    return running.page.evaluate(() => window.api.invoke('mcp:status'));
  }

  async function waitForStatus(): Promise<McpStatus[]> {
    for (let index = 0; index < 50; index++) {
      const status = await mcpStatus();
      if (status[0]?.state === 'connected') return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`MCP server never connected: ${JSON.stringify(await mcpStatus())}`);
  }

  async function snapshot(): Promise<ChatSnapshot> {
    return running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  }

  async function waitFor(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    for (let index = 0; index < 100; index++) {
      const chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for chat state: ${JSON.stringify(await snapshot())}; ${running.mainErrors.join(' ')}`,
    );
  }

  it('offers a namespaced tool and runs it after approval', async () => {
    const status = await waitForStatus();
    expect(status[0]!.tools).toEqual(['mcp_test_echo']);

    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp_test_echo', input: { text: 'hello' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The tool answered.' }], stopReason: 'end_turn' },
    );

    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Echo hello with the test tool' }));
    const isPendingTool = (item: TranscriptItem): item is Extract<TranscriptItem, { kind: 'tool' }> =>
      item.kind === 'tool' && item.status === 'awaiting-approval';
    await waitFor((chat) => chat.transcript.some(isPendingTool));

    // The MCP tool waits for approval like file edits do; approve it.
    const pending = (await snapshot()).transcript.find(isPendingTool);
    // The card shows what the server will be asked to do, not only the tool's name (#230).
    expect(pending!.preview).toMatchObject({ title: 'test: echo' });
    expect(JSON.parse(pending!.preview!.arguments!)).toEqual({ text: 'hello' });
    await expect
      .poll(() => running.page.locator('.tool-card.awaiting .tool-command').textContent())
      .toContain('"text": "hello"');
    await running.page.evaluate((id) => window.api.invoke('chat:decide', id, { approved: true }), pending!.id);

    const finished = await waitFor((chat) => !chat.busy);
    const toolRow = finished.transcript.find(
      (item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool',
    );
    expect(toolRow).toMatchObject({ status: 'done', summary: 'mcp_test_echo' });
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('echo:hello');
    expect(running.errors).toEqual([]);
  });
});

// A server that names ${project} must follow every switch of the current project, including the one that opening a
// chat from History makes (#241); before, it kept working on the previous project.
describe('MCP servers follow a project switch from History', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let alpha: string;
  let beta: string;

  beforeAll(async () => {
    alpha = mkdtempSync(join(tmpdir(), 'cc-mcp-alpha-'));
    beta = mkdtempSync(join(tmpdir(), 'cc-mcp-beta-'));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    const servers: McpServerConfig[] = [
      {
        name: 'test',
        transport: 'stdio',
        command: process.execPath,
        args: [join(__dirname, 'mock_mcp_server.mjs')],
        env: { MOCK_MCP_PROBE: '1', SERVED_PROJECT: '${project}' },
      },
    ];
    await running.page.evaluate(
      (configured) => window.api.invoke('settings:update', { mcpServers: configured }),
      servers,
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(alpha, { recursive: true, force: true });
    rmSync(beta, { recursive: true, force: true });
  });

  const snapshot = (): Promise<ChatSnapshot> => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
    for (let index = 0; index < 100; index++) {
      const value = await read();
      if (check(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(await read())}`);
  }

  // Asks the server which project it was started for, through the probe tool.
  async function servedProject(): Promise<string> {
    await until(
      () => running.page.evaluate(() => window.api.invoke('mcp:status')),
      (status: McpStatus[]) => status[0]?.state === 'connected',
      'the MCP server',
    );
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: `probe-${Date.now()}`,
            name: 'mcp_test_probe',
            input: { action: 'env', target: 'SERVED_PROJECT' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Probed.' }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Which project do you serve?' }));
    const pending = await until(
      snapshot,
      (chat) => chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
      'the approval card',
    );
    const card = pending.transcript.find((item) => item.kind === 'tool' && item.status === 'awaiting-approval')!;
    await running.page.evaluate((id) => window.api.invoke('chat:decide', id, { approved: true }), card.id);
    await until(snapshot, (chat) => !chat.busy, 'the run to end');
    // The tool's result as the model got it, in the request that followed the call.
    const blocks: Array<{ type: string; content?: unknown }> = claude.agentRequests
      .at(-1)
      .messages.flatMap((message: { content: unknown }) => (Array.isArray(message.content) ? message.content : []));
    const result = blocks.findLast((block) => block.type === 'tool_result')?.content;
    if (typeof result === 'string') return result;
    return Array.isArray(result) ? result.map((block: { text?: string }) => block.text ?? '').join('') : '';
  }

  it('reconnects the server for the project of the chat opened from History', async () => {
    const opened = await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    const alphaRoot = opened.path;
    expect(await servedProject()).toBe(`env:${alphaRoot}`);
    const alphaChat = (await snapshot()).id;

    const betaRoot = (await running.page.evaluate((path) => window.api.invoke('project:open', path), beta)).path;
    expect(await servedProject()).toBe(`env:${betaRoot}`);

    await running.page.evaluate((id) => window.api.invoke('history:open', id), alphaChat);
    expect((await running.page.evaluate(() => window.api.invoke('project:current')))?.path).toBe(alphaRoot);
    expect(await servedProject()).toBe(`env:${alphaRoot}`);
    expect(running.errors).toEqual([]);
  });
});
