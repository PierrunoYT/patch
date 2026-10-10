import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// Project memory: the model proposes a note with the remember tool, the approval card shows its exact text, an
// approved note is saved with the project and goes into the system prompt of the next chat. A declined one is not saved.
describe('project memory end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-memory-e2e-'));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  const snapshot = (): Promise<ChatSnapshot> => running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  const currentProject = () => running.page.evaluate(() => window.api.invoke('project:current'));

  async function waitFor(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    for (let index = 0; index < 100; index++) {
      const chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for chat state: ${JSON.stringify(await snapshot())}`);
  }

  async function proposeNote(note: string, approved: boolean): Promise<void> {
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: `mem-${note}`, name: 'remember', input: { note, why: 'It saves a retry' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Run the tests' }));
    const pending = await waitFor((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    const card = pending.transcript.find(
      (item): item is Extract<TranscriptItem, { kind: 'tool' }> =>
        item.kind === 'tool' && item.status === 'awaiting-approval',
    );
    expect(card).toMatchObject({ name: 'remember', preview: { title: 'Remember for this project' } });
    expect(card?.preview?.text).toContain(note);
    // Nothing is saved before the decision.
    expect((await currentProject())?.memory ?? '').not.toContain(note);
    await running.page.evaluate(({ id, ok }) => window.api.invoke('chat:decide', id, { approved: ok }), {
      id: card!.id,
      ok: approved,
    });
    await waitFor((chat) => !chat.busy);
  }

  it('saves an approved note and puts it into the next chat only', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await proposeNote('Run tests with pnpm test', true);
    expect((await currentProject())?.memory).toBe('Run tests with pnpm test');
    // The prompt of the chat that proposed it did not change.
    expect(claude.agentRequests.at(-1).system[0].text).not.toContain('Run tests with pnpm test');

    await running.page.evaluate(() => window.api.invoke('chat:new'));
    claude.script({ blocks: [{ type: 'text', text: 'Hello.' }], stopReason: 'end_turn' });
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Hi' }));
    await waitFor((chat) => !chat.busy && chat.transcript.some((item) => item.kind === 'assistant'));
    expect(claude.agentRequests.at(-1).system[0].text).toContain('# Project memory\n');
    expect(claude.agentRequests.at(-1).system[0].text).toContain('- Run tests with pnpm test');
  });

  it('does not save a declined note', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await proposeNote('Never touch the changelog', false);
    expect((await currentProject())?.memory).toBe('Run tests with pnpm test');
    expect(running.errors).toEqual([]);
  });
});
