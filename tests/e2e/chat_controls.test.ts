import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// The chat list, the model picker, the approval and Plan switches in the composer, and the status-bar branch
// (#62). Assertions read the screen, not the main process's state.

const DAY = 86_400_000;
const saved = (id: string, title: string, ageDays: number, project: string, text: string) => {
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  const transcript: TranscriptItem[] = [
    { kind: 'user', id: `${id}-u`, text, imageCount: 0 },
    { kind: 'assistant', id: `${id}-a`, text: `Answer in ${title}`, thinking: '', streaming: false },
  ];
  return {
    version: 1,
    id,
    title,
    projectPath: project,
    createdAt: at,
    updatedAt: at,
    system: 'system prompt',
    transcript,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    conversation: { provider: 'anthropic', model: 'claude-opus-5-5', messages: [] },
    readFiles: [],
  };
};
const TODAY = '33333333-3333-3333-3333-333333333331';
const WEEK = '33333333-3333-3333-3333-333333333332';
const OLD = '33333333-3333-3333-3333-333333333333';

describe('chat list, composer controls and status bar (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  let profile: string;

  const page = () => running.page;
  const sidebar = () => page().locator('.sidebar-list');
  const branch = () => page().locator('.status-branch');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Patch', '-c', 'user.email=patch@example.invalid', ...args], {
      cwd: project,
      windowsHide: true,
    });

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-controls-project-'));
    profile = mkdtempSync(join(tmpdir(), 'patch-controls-profile-'));
    writeFileSync(join(project, 'readme.md'), '# demo\n');
    git('init', '-q', '-b', 'trunk');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    mkdirSync(join(profile, 'chats'));
    for (const chat of [
      saved(TODAY, 'Today chat', 0, project, 'Where does the quokka live?'),
      saved(WEEK, 'This week chat', 3, project, 'Plain question'),
      saved(OLD, 'Ancient chat', 40, project, 'Another plain question'),
    ])
      writeFileSync(join(profile, 'chats', `${chat.id}.json`), JSON.stringify(chat));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() }, { userData: profile });
    await page().evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  it('shows no branch and asks for no Git status without a project', async () => {
    await page().getByText('Open a project to start').waitFor();
    expect(await branch().isHidden()).toBe(true);
    expect(running.mainErrors.join('')).not.toContain('git:status');
  });

  it('groups saved chats by day, newest first', async () => {
    await sidebar().getByText('Ancient chat').waitFor();
    const groups = await sidebar()
      .locator('.sidebar-group')
      .evaluateAll((elements) =>
        elements.map((group) => ({
          label: group.querySelector('.sidebar-group-label')?.textContent,
          titles: [...group.querySelectorAll('.sidebar-item-title')].map((title) => title.textContent),
        })),
      );
    expect(groups).toEqual([
      { label: 'TODAY', titles: ['Today chat'] },
      { label: 'PREVIOUS 7 DAYS', titles: ['This week chat'] },
      { label: 'OLDER', titles: ['Ancient chat'] },
    ]);
  });

  it('filters by title at once and by message text after the search', async () => {
    const filter = page().getByLabel('Filter chats');
    await filter.fill('ancient');
    await expect.poll(() => sidebar().locator('.sidebar-item-title').allTextContents()).toEqual(['Ancient chat']);
    // Only the message text matches; the list shows it once the history search has answered.
    await filter.fill('quokka');
    await expect.poll(() => sidebar().locator('.sidebar-item-title').allTextContents()).toEqual(['Today chat']);
    await filter.fill('no chat has this');
    await sidebar().getByText('No chats match.').waitFor();
    await filter.fill('');
    await expect.poll(() => sidebar().locator('.sidebar-item').count()).toBe(3);
  });

  it('opens a chat from the list, marks it, and locks its model', async () => {
    await page().evaluate((path) => window.api.invoke('project:open', path), project);
    await sidebar()
      .getByRole('button', { name: /This week chat/ })
      .click();
    await page().getByText('Answer in This week chat', { exact: true }).waitFor();
    const item = sidebar().getByRole('button', { name: /This week chat/ });
    await expect.poll(() => item.getAttribute('aria-current')).toBe('true');
    expect(
      await sidebar()
        .getByRole('button', { name: /Today chat/ })
        .getAttribute('aria-current'),
    ).toBe('false');
    const model = page().locator('.composer-controls').getByLabel('Model', { exact: true });
    expect(await model.isDisabled()).toBe(true);
    expect(await model.getAttribute('title')).toContain('A chat keeps its model');
  });

  it("uses the picker's model for a new chat, adds the chat to the list, then locks the picker", async () => {
    await page().evaluate(() => window.api.invoke('chat:new'));
    const model = page().locator('.composer-controls').getByLabel('Model', { exact: true });
    await expect.poll(() => model.isEnabled()).toBe(true);
    await model.selectOption('claude-sonnet-5-5');
    await expect
      .poll(() => page().evaluate(() => window.api.invoke('settings:get').then((settings) => settings.model)))
      .toBe('claude-sonnet-5-5');

    claude.script({ blocks: [{ type: 'text', text: 'Hello from the new chat.' }], stopReason: 'end_turn' });
    await page().getByLabel('Message').fill('Say hello');
    await page().getByLabel('Message').press('Enter');
    await page().getByText('Hello from the new chat.', { exact: true }).waitFor();
    expect(claude.agentRequests.at(-1).model).toBe('claude-sonnet-5-5');
    // The saved chat appears in the list through history:changed, under Today and marked as open.
    const created = sidebar().getByRole('button', { name: /Explore the project/ });
    await created.waitFor();
    expect(await created.getAttribute('aria-current')).toBe('true');
    expect(
      await sidebar()
        .locator('.sidebar-group', { has: page().getByText('TODAY', { exact: true }) })
        .getByText('Explore the project')
        .count(),
    ).toBe(1);
    await expect.poll(() => model.isDisabled()).toBe(true);
  });

  it('switches between Ask and Auto, and turns Plan Mode on and off', async () => {
    const ask = page().locator('.mode-toggle').getByRole('button', { name: 'Ask' });
    const auto = page().locator('.mode-toggle').getByRole('button', { name: 'Auto-Approve' });
    const plan = page().getByRole('switch', { name: 'Plan Mode' });
    const settings = () => page().evaluate(() => window.api.invoke('settings:get'));
    expect(await ask.getAttribute('aria-pressed')).toBe('true');

    await auto.click();
    await expect.poll(() => auto.getAttribute('aria-pressed')).toBe('true');
    expect(await ask.getAttribute('aria-pressed')).toBe('false');
    expect((await settings()).approvalMode).toBe('auto');
    await ask.click();
    await expect.poll(() => ask.getAttribute('aria-pressed')).toBe('true');
    expect((await settings()).approvalMode).toBe('ask');

    const before = (await settings()).planMode;
    await plan.click();
    await expect.poll(() => plan.getAttribute('aria-checked')).toBe(String(!before));
    expect((await settings()).planMode).toBe(!before);
    await plan.click();
    await expect.poll(() => plan.getAttribute('aria-checked')).toBe(String(before));
  });

  it('shows the branch in the status bar, with * once files change', async () => {
    await expect.poll(() => branch().textContent()).toContain('Git: trunk');
    expect(await branch().textContent()).not.toContain('*');
    writeFileSync(join(project, 'new.txt'), 'changed\n');
    // Opening the Git tab reads the status again, and the status bar follows it.
    await page().getByRole('tab', { name: 'Git', exact: true }).click();
    await expect.poll(() => branch().textContent()).toContain('Git: trunk*');
    expect(await branch().getAttribute('title')).toBe('1 uncommitted file(s)');
  });

  it('logs no IPC errors', () => {
    expect(running.mainErrors.join('')).not.toMatch(/Error occurred in handler/);
    expect(running.errors).toEqual([]);
  });
});
