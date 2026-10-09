import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const LONG_ID = '22222222-2222-2222-2222-222222222222';

// 200 tall items: a long answer with a code block, as in a real chat.
function longTranscript(): TranscriptItem[] {
  return Array.from({ length: 100 }, (_, turn): TranscriptItem[] => [
    { kind: 'user', id: `u${turn}`, text: `Question ${turn}`, imageCount: 0 },
    {
      kind: 'assistant',
      id: `a${turn}`,
      text: `Answer ${turn}\n\n\`\`\`ts\n${Array.from({ length: 12 }, (_, line) => `const v${line} = ${turn};`).join('\n')}\n\`\`\``,
      thinking: '',
      streaming: false,
    },
  ]).flat();
}

describe('the transcript view (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  let profile: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-view-project-'));
    profile = mkdtempSync(join(tmpdir(), 'patch-view-profile-'));
    writeFileSync(join(project, 'notes.txt'), 'hello\n');
    mkdirSync(join(profile, 'chats'));
    writeFileSync(
      join(profile, 'chats', `${LONG_ID}.json`),
      JSON.stringify({
        version: 1,
        id: LONG_ID,
        title: 'Long chat',
        projectPath: project,
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
        system: 'system prompt',
        transcript: longTranscript(),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        conversation: { provider: 'anthropic', model: 'claude-opus-5-5', messages: [] },
        readFiles: [],
      }),
    );
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() }, { userData: profile });
    running.page.on('dialog', (dialog) => void dialog.accept());
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  // How far the chat is scrolled from its bottom, in pixels.
  const distanceFromBottom = () =>
    running.page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('.chat-scroll-wrap')!;
      return Math.round(container.scrollHeight - container.scrollTop - container.clientHeight);
    });

  it('opens a long chat at its end', async () => {
    await running.page.evaluate((id) => window.api.invoke('history:open', id), LONG_ID);
    await running.page.getByText('Answer 99', { exact: true }).waitFor();
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
    // The 200 items are grouped 50 to a chunk (CHUNK_SIZE), in order.
    const layout = await running.page.evaluate(() => ({
      chunks: [...document.querySelectorAll('.transcript > .transcript-chunk')].map((chunk) => chunk.children.length),
      ids: [...document.querySelectorAll<HTMLElement>('.transcript-chunk > [data-id]')].map((node) => node.dataset.id),
    }));
    expect(layout.chunks).toEqual([50, 50, 50, 50]);
    expect(layout.ids).toEqual(longTranscript().map((item) => item.id));
  });

  it('keeps the scroll position when the theme changes', async () => {
    const box = (await running.page.locator('.chat-scroll-wrap').boundingBox())!;
    await running.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await running.page.mouse.wheel(0, -2000);
    await expect.poll(distanceFromBottom).toBeGreaterThan(1000);
    const before = await distanceFromBottom();
    await running.page.evaluate(() => window.api.invoke('settings:update', { theme: 'light' }));
    await expect.poll(() => running.page.evaluate(() => document.documentElement.dataset.bsTheme)).toBe('light');
    await running.page.waitForTimeout(300);
    expect(Math.abs((await distanceFromBottom()) - before)).toBeLessThan(5);
    await running.page.evaluate(() => window.api.invoke('settings:update', { theme: 'dark' }));
  });

  it('jumps to the bottom on send after the user scrolled up, so a quick approval card is in view', async () => {
    const box = (await running.page.locator('.chat-scroll-wrap').boundingBox())!;
    await running.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await running.page.mouse.wheel(0, -3000);
    await expect.poll(distanceFromBottom).toBeGreaterThan(1000);
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'list-files', name: 'run_command', input: { command: 'echo hi && dir' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Back at the bottom.' }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Hello again');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');
    const approve = running.page.locator('.tool-card.awaiting button', { hasText: 'Approve' });
    await approve.waitFor({ state: 'attached' });
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
    await approve.click();
    await running.page.getByText('Back at the bottom.', { exact: true }).waitFor();
  });

  it('keeps following the bottom when a tall approval card arrives, so Approve is in view', async () => {
    const newLines = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'read-notes', name: 'read_file', input: { path: 'notes.txt' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          { type: 'tool_use', id: 'tall-edit', name: 'write_file', input: { path: 'notes.txt', content: newLines } },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Written.' }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Rewrite the notes');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');

    const approve = running.page
      .getByRole('group', { name: /Approval needed/ })
      .getByRole('button', { name: 'Approve' });
    await approve.waitFor();
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
    expect(await approve.isVisible()).toBe(true);
    const box = await approve.boundingBox();
    const viewport = await running.page.evaluate(
      () => document.querySelector<HTMLElement>('.chat-scroll-wrap')!.getBoundingClientRect().bottom,
    );
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport + 1);

    await approve.click();
    await running.page.getByText('Written.', { exact: true }).waitFor();
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
  });

  it('moves keyboard focus to the result after Undo instead of losing it', async () => {
    const undo = running.page.getByRole('button', { name: /^Undo / });
    await undo.focus();
    await running.page.keyboard.press('Enter');

    await running.page.getByText('Undone', { exact: true }).waitFor();
    await expect
      .poll(() =>
        running.page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName),
      )
      .toBe('Undone');
  });
  it("does not let model text borrow the app's classes or ids to draw fake controls (#254)", async () => {
    const fake =
      '<div class="position-fixed top-0 w-100 bg-body z-3" id="app" hidden>OVERLAY-254</div>' +
      '<a class="btn btn-primary fake-approve-254" href="https://evil.example/">Approve</a>';
    claude.script({
      blocks: [{ type: 'text', text: `${fake}\n\nDone with the check.\n\n${'```'}ts\nconst x = 1;\n${'```'}` }],
      stopReason: 'end_turn',
    });
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Show the fake controls' }));
    await running.page.getByText('Done with the check.', { exact: true }).waitFor();
    const found = await running.page.evaluate(() => {
      const message = [...document.querySelectorAll('.markdown')].find((element) =>
        element.textContent?.includes('Done with the check.'),
      )!;
      return {
        classed: message.querySelectorAll('.btn, .position-fixed, .fake-approve-254').length,
        ids: message.querySelectorAll('[id]').length,
        hidden: message.querySelectorAll('[hidden]').length,
        highlighted: message.querySelectorAll('.hljs-keyword').length,
        apps: document.querySelectorAll('#app').length,
      };
    });
    expect(found).toEqual({ classed: 0, ids: 0, hidden: 0, highlighted: 1, apps: 1 });
  });
});
