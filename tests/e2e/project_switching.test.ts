import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// More of switching between open projects, through the UI: instructions, drafts with images, the chat history, and
// switching while a task runs. tests/e2e/projects.test.ts covers the basics of separate chats and drafts.
describe('switching between open projects (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let root: string;
  let alpha: string;
  let beta: string;
  let betaChatId: string;

  beforeAll(async () => {
    // The app keeps projects by real path; on macOS the temp folder is under /var, a link to /private/var.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-switching-')));
    alpha = join(root, 'Alpha');
    beta = join(root, 'Beta');
    for (const path of [alpha, beta]) mkdirSync(path);
    writeFileSync(join(alpha, 'AGENTS.md'), 'ALPHA-AGENTS-RULES\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  const current = () => running.page.evaluate(() => window.api.invoke('project:current'));
  const tabs = () => running.page.getByRole('navigation', { name: 'Open projects' });
  const tab = (name: string) => tabs().getByRole('button', { name, exact: true });
  const message = () => running.page.getByLabel('Message', { exact: true });
  const attachments = () => running.page.locator('.composer-attachments .badge');

  async function waitFor(check: (chat: ChatSnapshot) => unknown, timeout = 20_000): Promise<ChatSnapshot> {
    const deadline = Date.now() + timeout;
    let chat = await snapshot();
    while (Date.now() < deadline) {
      chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out. project=${chat.projectPath} busy=${chat.busy} items=${chat.transcript.length} ${running.mainErrors.join(' ')}`,
    );
  }

  async function ask(text: string, answer: string): Promise<ChatSnapshot> {
    claude.script({ blocks: [{ type: 'text', text: answer }], stopReason: 'end_turn' });
    await message().fill(text);
    await message().press('Enter');
    return waitFor(
      (chat) => !chat.busy && chat.transcript.some((item) => item.kind === 'assistant' && item.text === answer),
    );
  }

  // Pastes a small PNG into the message box, the way the clipboard would.
  const pasteImage = (name: string) =>
    running.page.getByLabel('Message', { exact: true }).evaluate((input, fileName) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgo='), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, name);

  it("builds each project's chat from that project's own instructions", async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    await ask('Hello Alpha', 'Alpha answered.');
    const alphaSystem = claude.agentRequests.at(-1).system[0].text;
    expect(alphaSystem).toContain('ALPHA-AGENTS-RULES');
    expect(alphaSystem).not.toContain('BETA-PROJECT-INSTRUCTIONS');

    await running.page.evaluate((path) => window.api.invoke('project:open', path), beta);
    await tab('Beta').waitFor();
    await running.page.evaluate(
      (path) =>
        window.api.invoke('project:update-settings', path, {
          instructions: 'BETA-PROJECT-INSTRUCTIONS',
          allowedCommands: '',
          allowedNetworkHosts: '',
        }),
      beta,
    );
    betaChatId = (await ask('Hello Beta', 'Beta answered.')).id;
    const betaSystem = claude.agentRequests.at(-1).system[0].text;
    expect(betaSystem).toContain('BETA-PROJECT-INSTRUCTIONS');
    expect(betaSystem).not.toContain('ALPHA-AGENTS-RULES');
    // The status bar says which instruction file the chat on screen uses.
    expect(await running.page.locator('.app-footer').getByText('AGENTS.md').isVisible()).toBe(false);
  });

  it('keeps attached images with the draft of their own project', async () => {
    await message().fill('Beta draft with an image');
    await pasteImage('beta-shot.png');
    await attachments().filter({ hasText: 'beta-shot.png' }).waitFor();

    await tab('Alpha').click();
    await expect.poll(async () => (await current())?.path).toBe(alpha);
    await running.page.getByText('Alpha answered.', { exact: true }).waitFor();
    expect(await message().inputValue()).toBe('');
    expect(await attachments().count()).toBe(0);
    // The footer catches up with the switch on its own; wait for it rather than sampling it once.
    await running.page.locator('.app-footer').getByText('AGENTS.md').waitFor();
    await pasteImage('alpha-shot.png');
    await attachments().filter({ hasText: 'alpha-shot.png' }).waitFor();

    await tab('Beta').click();
    await expect.poll(async () => (await current())?.path).toBe(beta);
    expect(await message().inputValue()).toBe('Beta draft with an image');
    await expect.poll(() => attachments().allTextContents()).toEqual([expect.stringContaining('beta-shot.png')]);

    await tab('Alpha').click();
    await expect.poll(() => attachments().allTextContents()).toEqual([expect.stringContaining('alpha-shot.png')]);
  });

  it("switches to the other project when one of its chats is opened from the history, keeping this project's draft", async () => {
    await message().fill('Alpha draft kept while away');
    await running.page.getByTitle('Chat history').click();
    // Chats are titled by the small model; both are "Explore the project", so pick Beta's by its project path.
    const betaRow = running.page.locator('.history-list .list-group-item', { hasText: beta });
    await betaRow.waitFor();
    await betaRow.getByRole('button').first().click();

    const opened = await waitFor((chat) => chat.id === betaChatId);
    expect(opened.projectPath).toBe(beta);
    expect((await current())?.path).toBe(beta);
    expect(await tab('Beta').getAttribute('aria-pressed')).toBe('true');
    await running.page.getByText('Beta answered.', { exact: true }).waitFor();

    await tab('Alpha').click();
    await expect.poll(() => message().inputValue()).toBe('Alpha draft kept while away');
  });

  it('refuses to switch tabs while a task is running, says why, and switches once it is stopped', async () => {
    claude.script({ hang: { text: 'Working on it' } });
    await message().fill('A long task');
    await message().press('Enter');
    await running.page.getByText('Working on it').waitFor();

    await tab('Beta').click();
    await running.page.locator('.app-toast', { hasText: 'Stop the current task' }).first().waitFor();
    expect((await current())?.path).toBe(alpha);
    expect(await tab('Alpha').getAttribute('aria-pressed')).toBe('true');

    await running.page.getByRole('button', { name: /Stop/ }).click();
    await waitFor((chat) => !chat.busy);
    await tab('Beta').click();
    await expect.poll(async () => (await current())?.path).toBe(beta);
    expect((await waitFor((chat) => chat.id === betaChatId)).busy).toBe(false);
    expect(running.errors).toEqual([]);
  });

  it('keeps the terminal command, commit draft and expanded transcript when the project stays active', async () => {
    const gamma = join(root, 'Gamma');
    mkdirSync(gamma);
    await running.page.evaluate((path) => window.api.invoke('project:open', path), gamma);
    await tab('Alpha').click();
    await waitFor((chat) => chat.projectPath === alpha);
    const olderChat = (await snapshot()).id;
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    writeFileSync(join(alpha, 'state.txt'), 'old\n');
    await running.page.evaluate(() => window.api.invoke('settings:update', { approvalMode: 'auto' }));
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'read-alpha', name: 'read_file', input: { path: 'state.txt' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'edit-alpha',
            name: 'edit_file',
            input: { path: 'state.txt', old_string: 'old', new_string: 'new' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Alpha state preserved.' }], stopReason: 'end_turn' },
    );
    await message().fill('Read the Alpha instructions');
    await message().press('Enter');
    const active = await waitFor(
      (chat) =>
        !chat.busy &&
        chat.transcript.some((item) => item.kind === 'assistant' && item.text === 'Alpha state preserved.'),
    );
    await running.page.getByText('Alpha state preserved.', { exact: true }).waitFor();
    const disclosure = running.page.locator('.tool-card details').first();
    await disclosure.locator('summary').click();
    await expect.poll(() => disclosure.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
    await running.page.evaluate(() => window.api.invoke('git:init'));
    await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
    const commit = running.page.getByLabel('Commit message');
    await commit.fill('Keep this unfinished commit');
    await running.page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await running.page.evaluate(() => window.api.invoke('terminal:start', 80, 24));
    const heartbeat = join(alpha, 'terminal-heartbeat.txt');
    const command =
      process.platform === 'win32'
        ? `$i=0; while ($true) { [System.IO.File]::WriteAllText('${heartbeat.replaceAll("'", "''")}', [string](++$i)); Start-Sleep -Milliseconds 100 }\r`
        : `i=0; while :; do i=$((i+1)); printf '%s' "$i" > '${heartbeat.replaceAll("'", "'\\''")}'; sleep 0.1; done\r`;
    const readHeartbeat = () => {
      try {
        return Number(readFileSync(heartbeat, 'utf8'));
      } catch {
        return 0;
      }
    };
    const remainsRunning = async () => {
      const before = readHeartbeat();
      await expect.poll(readHeartbeat, { timeout: 15_000 }).toBeGreaterThan(before);
      expect(await commit.inputValue()).toBe('Keep this unfinished commit');
    };
    try {
      await running.page.evaluate((text) => window.api.invoke('terminal:write', text), command);
      await expect.poll(readHeartbeat, { timeout: 20_000 }).toBeGreaterThan(0);
      await tab('Alpha').click();
      await remainsRunning();
      expect(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      await running.page.locator('.sidebar-item.active').click();
      await remainsRunning();
      expect((await snapshot()).id).toBe(active.id);
      expect(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      await running.page.getByRole('button', { name: 'Close project Beta', exact: true }).click();
      await remainsRunning();
      expect(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      await running.page.evaluate((path) => window.api.invoke('project:remove', path), gamma);
      await remainsRunning();
      expect(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      await running.page.evaluate((id) => window.api.invoke('history:open', id), olderChat);
      await waitFor((chat) => chat.id === olderChat);
      await remainsRunning();
      expect((await current())?.path).toBe(alpha);
    } finally {
      await running.page.evaluate(() => window.api.invoke('terminal:write', '\u0003'));
    }
    expect(running.errors).toEqual([]);
  });

  it('keeps Alpha active after a missing-key history error and binds a successful restore to Beta', async () => {
    const before = await snapshot();
    const commitDraft = await running.page.getByLabel('Commit message').inputValue();
    await message().fill('Keep the Alpha draft');
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', ''));
    try {
      await running.page.locator('.sidebar-item').filter({ hasText: 'Beta' }).first().click();
      await running.page.locator('.app-toast', { hasText: 'Add your Anthropic API key' }).first().waitFor();
      expect((await current())?.path).toBe(alpha);
      expect((await snapshot()).id).toBe(before.id);
      expect(await tab('Alpha').getAttribute('aria-pressed')).toBe('true');
      expect(await tab('Beta').count()).toBe(0);
      expect(await message().inputValue()).toBe('Keep the Alpha draft');
      expect(await running.page.getByLabel('Commit message').inputValue()).toBe(commitDraft);
    } finally {
      await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    }
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'write-alpha',
            name: 'write_file',
            input: { path: 'after-failed-open.txt', content: 'still Alpha\n' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Continued in Alpha.' }], stopReason: 'end_turn' },
    );
    await message().fill('Continue in the current project');
    await message().press('Enter');
    await waitFor(
      (chat) =>
        !chat.busy && chat.transcript.some((item) => item.kind === 'assistant' && item.text === 'Continued in Alpha.'),
    );
    expect((await snapshot()).id).toBe(before.id);
    expect(readFileSync(join(alpha, 'after-failed-open.txt'), 'utf8')).toBe('still Alpha\n');
    expect(existsSync(join(beta, 'after-failed-open.txt'))).toBe(false);

    await running.page.evaluate((id) => window.api.invoke('history:open', id), betaChatId);
    await waitFor((chat) => chat.id === betaChatId);
    expect((await current())?.path).toBe(beta);
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'write-beta',
            name: 'write_file',
            input: { path: 'after-successful-open.txt', content: 'restored Beta\n' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Continued in Beta.' }], stopReason: 'end_turn' },
    );
    await message().fill('Continue the restored chat');
    await message().press('Enter');
    await waitFor(
      (chat) =>
        !chat.busy && chat.transcript.some((item) => item.kind === 'assistant' && item.text === 'Continued in Beta.'),
    );
    expect(readFileSync(join(beta, 'after-successful-open.txt'), 'utf8')).toBe('restored Beta\n');
    expect(existsSync(join(alpha, 'after-successful-open.txt'))).toBe(false);
    await tab('Alpha').click();
    await waitFor((chat) => chat.id === before.id);
    expect(running.errors).toEqual([]);
  });

  it('clears the chat and panel state when the last active project is closed', async () => {
    await running.page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    const opened = await running.page.evaluate(() => window.api.invoke('project:opened'));
    for (const project of opened) {
      if (project.path !== alpha)
        await running.page.evaluate((path) => window.api.invoke('project:close', path), project.path);
    }
    await running.page.getByRole('button', { name: 'Close project Alpha', exact: true }).click();
    await expect.poll(current).toBeNull();
    await expect.poll(async () => (await snapshot()).id).toBe('');
    await running.page.locator('.terminal-panel', { hasText: 'Open a project to use the terminal.' }).waitFor();
    expect(await running.page.getByLabel('Commit message').inputValue()).toBe('');
    expect(await running.page.locator('.tool-card').count()).toBe(0);
  });
});
