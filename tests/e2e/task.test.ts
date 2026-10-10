import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// The task tool delegates to a read-only subagent: the mock API sees the parent turn, the subagent's turns (a
// write_file attempt it may not make, a read_file call and its answer) and finally the parent finishing with the
// subagent's answer in its history.
describe('subagent task tool end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-task-e2e-'));
    writeFileSync(join(project, 'file.txt'), 'hello from the project\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));

    // 1. The parent asks the subagent to read the file.
    // 2. The subagent tries to write it, which a read-only subagent cannot do.
    // 3./4. The subagent reads it and answers.
    // 5. The parent reports the answer.
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'task-1', name: 'task', input: { task: 'What does file.txt say?' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          { type: 'tool_use', id: 'write-1', name: 'write_file', input: { path: 'file.txt', content: 'overwritten' } },
        ],
        stopReason: 'tool_use',
      },
      {
        blocks: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'file.txt' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The file says: hello from the project' }], stopReason: 'end_turn' },
      { blocks: [{ type: 'text', text: 'Delegated answer: hello from the project' }], stopReason: 'end_turn' },
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

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

  it('delegates to a read-only subagent and surfaces its answer', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'What does file.txt say?' }));
    const finished = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');

    const taskRow = finished.transcript.find(
      (item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool' && item.name === 'task',
    );
    expect(taskRow).toMatchObject({ status: 'done' });
    // On the chat's own model the card names only the effort (#79).
    expect(taskRow?.summary).toBe('Subagent (high effort): What does file.txt say?');

    // The parent's final request contains the subagent's answer as the task result.
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('The file says: hello from the project');
    // Five API turns: parent, subagent write attempt, subagent read, subagent answer, parent finish.
    expect(claude.agentRequests).toHaveLength(5);
    // The subagent runs on the chat's model, so it sends the chat's exact tools and system prompt and reads the
    // prefix the chat already cached; its role is in its first message instead.
    const [parent, subagent] = claude.agentRequests;
    expect(JSON.stringify(subagent.tools)).toBe(JSON.stringify(parent.tools));
    expect(JSON.stringify(subagent.system)).toBe(JSON.stringify(parent.system));
    expect(JSON.stringify(subagent.messages[0])).toContain('read-only research subagent');
    // Listing write_file does not let it run: the file is unchanged and the model is told why.
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('hello from the project\n');
    expect(JSON.stringify(claude.agentRequests[2].messages)).toContain('not available to a read-only subagent');
    expect(running.errors).toEqual([]);
  });
});
