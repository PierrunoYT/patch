import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// A prompt-injected grep pattern that backtracks catastrophically must not freeze the app (#122): the regex runs in a
// worker thread inside the real main process, the app keeps answering, and the search stops with a note.
describe('catastrophic grep pattern (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-grep-redos-'));
    writeFileSync(join(project, 'aaa.txt'), `${'a'.repeat(10_000)}!`);
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

  it('keeps the app responsive and stops the search with a note', async () => {
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'grep-1', name: 'grep', input: { pattern: '(a+)+b', path: 'aaa.txt' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The pattern was too slow.' }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'search for it' }));

    // While the pattern runs, the main process still answers IPC quickly.
    const deadline = Date.now() + 20_000;
    let slowest = 0;
    let chat = await snapshot();
    while (chat.busy && Date.now() < deadline) {
      const started = Date.now();
      await running.page.evaluate(() => window.api.invoke('app:info'));
      slowest = Math.max(slowest, Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 100));
      chat = await snapshot();
    }
    expect(chat.busy).toBe(false);
    expect(slowest).toBeLessThan(1000);

    const card = chat.transcript.find((item) => item.kind === 'tool' && item.name === 'grep');
    expect(card).toMatchObject({ status: 'done' });
    // The note reached the model in the tool result.
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('catastrophic backtracking');
    expect(running.mainErrors.join('')).not.toMatch(/Error/);
  }, 40_000);
});
