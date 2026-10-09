import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// Initialize in the Git panel creates the .git that sandboxed commands may only read. A command started before it
// would be able to write the new folder's config and hooks, so Initialize stops the project's background commands
// first (#231).
describe('Git panel Initialize', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-git-init-'));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    await running.page.evaluate(() =>
      window.api.invoke('settings:update', {
        approvalMode: 'auto',
        // The heartbeat runs on the test's Node; stopping it does not depend on the sandbox backend.
        sandboxMode: 'off',
        permissionRules: [{ tool: 'run_command', action: 'allow' }],
      }),
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  it('stops the background commands still running in the project first (#231)', async () => {
    const heartbeat = join(project, 'beat.txt');
    const script = "setInterval(() => require('fs').writeFileSync('beat.txt', String(Date.now())), 50)";
    const node = process.execPath.replaceAll('\\', '/');
    const command = process.platform === 'win32' ? `& "${node}" -e "${script}"` : `"${node}" -e "${script}"`;
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'beat', name: 'run_command', input: { command, background: true } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Heartbeat started.' }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Start the heartbeat' }));
    await expect
      .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy), {
        timeout: 30_000,
      })
      .toBe(false);
    await expect.poll(() => existsSync(heartbeat), { timeout: 15_000 }).toBe(true);

    await running.page.evaluate(() => window.api.invoke('git:init'));
    expect(statSync(join(project, '.git')).isDirectory()).toBe(true);
    // The heartbeat no longer runs: the file stops changing.
    const after = readFileSync(heartbeat, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readFileSync(heartbeat, 'utf8')).toBe(after);
    expect(running.errors).toEqual([]);
  });
});
