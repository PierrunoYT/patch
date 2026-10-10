import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { appLogTail, delay, launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// The app is killed (SIGKILL) in the middle of a real run, and the profile is opened again. Nothing is seeded: the
// chat file is whatever the checkpoint and the debounced save had written by then, and Resume must work from it.
describe('kill the app mid-run and resume end to end', () => {
  let claude: MockClaude;
  let claudeUrl: string;
  let project: string;
  let userData: string;
  let running: RunningApp | undefined;

  beforeAll(async () => {
    claude = new MockClaude();
    claudeUrl = await claude.start();
  });

  afterAll(async () => {
    await claude?.stop();
  });

  afterEach(async () => {
    await running?.close();
    running = undefined;
    rmSync(project, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });

  async function start(): Promise<RunningApp> {
    running = await launchApp({ PATCH_USER_DATA: userData, PATCH_TEST_ANTHROPIC_URL: claudeUrl }, { userData });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    return running;
  }

  function setup(): void {
    project = mkdtempSync(join(tmpdir(), 'patch-kill-e2e-'));
    userData = mkdtempSync(join(tmpdir(), 'patch-kill-e2e-profile-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
  }

  async function waitFor(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    const app = running!;
    for (let index = 0; index < 100; index++) {
      const chat = await app.page.evaluate(() => window.api.invoke('chat:snapshot'));
      if (check(chat)) return chat;
      await delay(100);
    }
    const last = await app.page.evaluate(() => window.api.invoke('chat:snapshot'));
    throw new Error(`Timed out waiting for chat state: ${JSON.stringify(last)}; ${app.mainErrors.join(' ')}`);
  }

  // The chat file on disk, once `ready` accepts it; the debounced save writes it up to half a second after the event.
  async function savedChat(ready: (chat: any) => boolean): Promise<any> {
    const dir = join(userData, 'chats');
    let last = 'no chat file';
    for (let index = 0; index < 300; index++) {
      if (existsSync(dir)) {
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'index.json')) {
          try {
            const chat = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            if (chat.conversation && ready(chat)) return chat;
            last = JSON.stringify({ resumable: chat.resumable, transcript: chat.transcript });
          } catch {
            // Half written, or the index file; look again.
          }
        }
      }
      await delay(100);
    }
    throw new Error(
      `The chat file never reached the expected state on disk. Last seen: ${last.slice(0, 2000)}. App log: ${appLogTail(userData)}`,
    );
  }

  // Every tool call in the request has a result right after it, which the API requires.
  function expectPaired(messages: any[]): void {
    messages.forEach((message, index) => {
      const calls = (Array.isArray(message.content) ? message.content : []).filter(
        (block: any) => block.type === 'tool_use',
      );
      const results = (messages[index + 1]?.content ?? [])
        .filter((block: any) => block.type === 'tool_result')
        .map((block: any) => block.tool_use_id);
      for (const call of calls) expect(results).toContain(call.id);
    });
  }

  async function reopenOnlyChat(app: RunningApp): Promise<void> {
    const chats = await app.page.evaluate(() => window.api.invoke('history:list'));
    expect(chats).toHaveLength(1);
    await app.page.evaluate((id) => window.api.invoke('history:open', id), chats[0]!.id);
  }

  it('resumes a chat killed while a tool waited for approval', async () => {
    setup();
    let app = await start();
    claude.script({
      blocks: [
        {
          type: 'tool_use',
          id: 'toolu_provider_1',
          name: 'run_command',
          input: { command: 'printf changed > file.txt' },
        },
      ],
      stopReason: 'tool_use',
    });
    await app.page.evaluate(() => window.api.invoke('chat:send', { text: 'Change the file' }));
    await waitFor((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    // Wait for the debounced save to write the waiting row, then pull the plug.
    await savedChat((chat) =>
      chat.transcript.some((item: any) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    await app.kill();

    app = await start();
    await reopenOnlyChat(app);
    const paused = await waitFor((chat) => chat.resumable && !chat.busy);
    const row = paused.transcript.find((item) => item.kind === 'tool');
    expect(row).toMatchObject({ status: 'error', summary: 'run_command was interrupted' });
    // Row ids are made by the app, not taken from the provider's call id.
    expect(row!.id).not.toBe('toolu_provider_1');

    claude.script({ blocks: [{ type: 'text', text: 'Recovered after the kill.' }], stopReason: 'end_turn' });
    await app.page.getByRole('button', { name: /Resume/ }).click();
    const finished = await waitFor((chat) => !chat.busy && !chat.resumable);
    expect(finished.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Recovered after the kill.' });
    expect(finished.transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
    expectPaired(claude.agentRequests.at(-1).messages);
    // The command was never approved, so it never ran.
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('original\n');
    expect(app.errors).toEqual([]);
  });

  it('resumes a chat killed while an answer was streaming', async () => {
    setup();
    let app = await start();
    claude.script({ hang: { text: 'Half an answer that never' } });
    await app.page.evaluate(() => window.api.invoke('chat:send', { text: 'Explain the project' }));
    await waitFor((chat) =>
      chat.transcript.some((item) => item.kind === 'assistant' && item.text.includes('Half an answer')),
    );
    const saved = await savedChat((chat) => chat.resumable === true);
    expect(saved.transcript.some((item: any) => item.kind === 'user')).toBe(true);
    await app.kill();

    app = await start();
    await reopenOnlyChat(app);
    const paused = await waitFor((chat) => chat.resumable && !chat.busy);
    // Nothing is left streaming after the reload.
    expect(paused.transcript.some((item) => item.kind === 'assistant' && item.streaming)).toBe(false);

    claude.script({ blocks: [{ type: 'text', text: 'Finished after the kill.' }], stopReason: 'end_turn' });
    await app.page.getByRole('button', { name: /Resume/ }).click();
    const finished = await waitFor((chat) => !chat.busy && !chat.resumable);
    expect(finished.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Finished after the kill.' });
    expect(finished.transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
    expectPaired(claude.agentRequests.at(-1).messages);
    expect(app.errors).toEqual([]);
  });
});
