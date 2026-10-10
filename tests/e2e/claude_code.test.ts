import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const CLAUDE_CODE = process.env.PATCH_E2E_CLAUDE_CODE_PATH;
const ARTIFACTS = process.env.E2E_SCREENSHOTS;
const ROUTING_VARS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
];

const writeTurn = (id: string, file: string, content: string, project: string) => ({
  blocks: [{ type: 'tool_use' as const, id, name: 'Write', input: { file_path: join(project, file), content } }],
  stopReason: 'tool_use' as const,
});
const textTurn = (text: string) => ({ blocks: [{ type: 'text' as const, text }], stopReason: 'end_turn' as const });

describe.skipIf(!CLAUDE_CODE)('Claude Code chats through the installed CLI', () => {
  let claude: MockClaude;
  let project: string | undefined;
  let configDir: string | undefined;
  let userData: string | undefined;
  let running: RunningApp;
  let removed: Array<[string, string]> = [];

  async function launch() {
    running = await launchApp({ CLAUDE_CONFIG_DIR: configDir! }, { userData });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project!);
  }

  function readAppLog(): string {
    const file = join(userData!, 'logs', 'app.log.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').slice(-3000) : '(none)';
  }

  function savedClaudeSession(chatId: string): string | null {
    const file = join(userData!, 'chats', `${chatId}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')).conversation?.sessionId ?? null;
  }

  async function snapshot(): Promise<ChatSnapshot> {
    return running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  }

  async function until(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    const deadline = Date.now() + 60_000;
    for (let chat = await snapshot(); !check(chat); chat = await snapshot()) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the chat (busy ${chat.busy}, resumable ${chat.resumable}): ${JSON.stringify(chat.transcript)}; model requests ${claude.agentRequests.length} (last: ${claude.agentRequests
            .slice(-4)
            .map((request) => JSON.stringify(request.messages.at(-1)?.content).slice(0, 160))
            .join(' | ')}); app log: ${readAppLog()}; main process: ${running.mainErrors.join('').slice(-2000)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return snapshot();
  }

  const hasOpenRow = (chat: ChatSnapshot) =>
    chat.transcript.some(
      (item) => item.kind === 'tool' && (item.status === 'awaiting-approval' || item.status === 'running'),
    );

  async function screenshot(name: string) {
    if (!ARTIFACTS) return;
    mkdirSync(ARTIFACTS, { recursive: true });
    await running.page.screenshot({ path: join(ARTIFACTS, `${name}.png`) });
  }

  beforeAll(async () => {
    removed = ROUTING_VARS.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]!]);
    for (const [name] of removed) delete process.env[name];
    project = mkdtempSync(join(tmpdir(), 'patch-claude-e2e-project-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
    configDir = mkdtempSync(join(tmpdir(), 'patch-claude-e2e-config-'));
    userData = mkdtempSync(join(tmpdir(), 'patch-claude-e2e-profile-'));
    claude = new MockClaude();
    const url = await claude.start();
    await launch();
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    await running.page.evaluate(
      ([path, base]) =>
        window.api.invoke('settings:update', {
          model: 'claude-code/claude-sonnet-5-5',
          claudeCodePath: path,
          claudeCodeUsesApiKey: true,
          anthropicBaseUrl: base,
        }),
      [CLAUDE_CODE!, url] as const,
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    for (const folder of [project, configDir, userData]) if (folder) rmSync(folder, { recursive: true });
    for (const [name, value] of removed) process.env[name] = value;
  });

  it('writes a file through Claude Code after approval, and streams the answer', async () => {
    claude.script(writeTurn('toolu_e2e_write_1', 'written.txt', 'first\n', project!), textTurn('E2E first answer.'));
    await running.page.evaluate(() => window.api.invoke('chat:new'));

    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Write written.txt' }));
    const awaiting = await until((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    expect(existsSync(join(project!, 'written.txt'))).toBe(false);
    const awaitingCard = running.page.locator('.tool-card.awaiting');
    await awaitingCard.waitFor();
    await expect(awaitingCard.locator('.tool-diff').textContent()).resolves.toContain('first');
    await running.page.getByRole('button', { name: 'Approve', exact: true }).click();

    await expect
      .poll(() =>
        existsSync(join(project!, 'written.txt')) ? readFileSync(join(project!, 'written.txt'), 'utf8') : null,
      )
      .toBe('first\n');
    const done = await until((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');
    expect(done.id).toBe(awaiting.id);
    expect(done.transcript.find((item) => item.kind === 'tool')).toMatchObject({ name: 'Write', status: 'done' });
    expect(done.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'E2E first answer.' });
    expect(hasOpenRow(done)).toBe(false);
    expect(running.errors).toEqual([]);
    await screenshot('claude-code-write');
  });

  it('stops at a pending write without changing the file, then resumes the same session after a restart', async () => {
    claude.script(
      writeTurn('toolu_e2e_write_2', 'stopped.txt', 'never\n', project!),
      writeTurn('toolu_e2e_write_3', 'resumed.txt', 'after resume\n', project!),
      textTurn('E2E resumed answer.'),
    );
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Write stopped.txt' }));
    const pending = await until((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    expect(existsSync(join(project!, 'stopped.txt'))).toBe(false);

    await running.page.getByRole('button', { name: /Stop/ }).click();
    const paused = await until((chat) => !chat.busy && chat.resumable);
    expect(paused.id).toBe(pending.id);
    expect(existsSync(join(project!, 'stopped.txt'))).toBe(false);
    expect(hasOpenRow(paused)).toBe(false);
    await expect.poll(() => savedClaudeSession(paused.id)).not.toBeNull();
    const stoppedSession = savedClaudeSession(paused.id);
    await running.close();

    await launch();
    await running.page.evaluate((id) => window.api.invoke('history:open', id), paused.id);
    expect(savedClaudeSession(paused.id)).toBe(stoppedSession);
    await running.page.getByRole('button', { name: /Resume/ }).click();
    await until((chat) => chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'));
    await running.page.getByRole('button', { name: 'Approve', exact: true }).click();

    await expect
      .poll(() =>
        existsSync(join(project!, 'resumed.txt')) ? readFileSync(join(project!, 'resumed.txt'), 'utf8') : null,
      )
      .toBe('after resume\n');
    const finished = await until((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');
    expect(finished.id).toBe(paused.id);
    expect(finished.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'E2E resumed answer.' });
    expect(hasOpenRow(finished)).toBe(false);
    expect(savedClaudeSession(finished.id)).toBe(stoppedSession);
    expect(existsSync(join(project!, 'stopped.txt'))).toBe(false);
    const resumeRequest = claude.agentRequests.at(-1);
    expect(JSON.stringify(resumeRequest.messages)).toContain('Write stopped.txt');
    expect(running.errors).toEqual([]);
    await screenshot('claude-code-resumed');
  }, 180_000);
});
