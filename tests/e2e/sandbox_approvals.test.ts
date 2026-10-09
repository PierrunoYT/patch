import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detectSandboxSupport, probeSandboxSupport } from '../../src/main/tools/sandbox';
import { GIT_RESERVATION } from '../../src/main/tools/sandbox_git';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const support = detectSandboxSupport();
// Where the allow-list is enforced by the filtering proxy (#97), a command that names an allowed URL runs without a
// card: it gets network only to the allowed hosts, not the unrestricted network the card would grant.
const probed = await probeSandboxSupport();
const filtered = process.platform === 'linux' && probed.bwrap && Boolean(probed.netBridge);

describe('sandbox escalation approvals', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  const captureDir = process.env.E2E_SCREENSHOTS;

  beforeAll(async () => {
    project = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'patch-sandbox-approval-'));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    await running.page.evaluate(
      (sandboxPath) =>
        window.api.invoke('settings:update', {
          approvalMode: 'auto',
          sandboxMode: 'auto',
          sandboxNetwork: 'allow-list',
          allowedNetworkHosts: 'allowed.test',
          allowedCommands: 'echo',
          permissionRules: [{ tool: 'run_command', action: 'allow' }],
          // These commands use PowerShell built-ins, not the runner's installed toolchains.
          sandboxPath,
        }),
      process.platform === 'win32' ? project : '',
    );
    if (captureDir) mkdirSync(resolve(captureDir), { recursive: true });
  });

  afterEach(async () => {
    // A timed-out command must not leave the shared chat busy and invalidate later approval checks.
    if (running && (await running.page.evaluate(() => window.api.invoke('chat:snapshot'))).busy) {
      await running.page.evaluate(() => window.api.invoke('chat:stop'));
      await expect
        .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy))
        .toBe(false);
    }
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  it('explains fail-closed behavior and unrestricted network requests in Settings', async () => {
    await running.page.getByTitle('Settings (Ctrl+,)').click();
    const dialog = running.page.locator('.app-dialog');
    await running.page.getByLabel('Run commands in a sandbox').scrollIntoViewIfNeeded();
    expect(await dialog.textContent()).toContain('Commands do not run when the selected sandbox is unavailable');
    expect(await dialog.textContent()).toContain('matching command URLs request unrestricted network access');
    expect(await dialog.textContent()).toContain('Allow-list on Linux (Automatic mode)');
    expect(await running.page.getByLabel('Network in the sandbox').inputValue()).toBe('allow-list');
    if (captureDir) await dialog.screenshot({ path: join(captureDir, 'sandbox-settings.png') });
    await running.page.getByRole('button', { name: 'Cancel' }).click();
  });

  it.skipIf(!support.bwrap && !support.seatbelt && !support.appcontainer)(
    'runs in a non-Git project without an unsandboxed approval and keeps Git uninitialized',
    async () => {
      expect(existsSync(join(project, '.git'))).toBe(false);
      await running.page.evaluate(() => window.api.invoke('chat:new'));
      claude.script(
        {
          blocks: [{ type: 'tool_use', id: 'sandboxed', name: 'run_command', input: { command: 'echo sandboxed' } }],
          stopReason: 'tool_use',
        },
        { blocks: [{ type: 'text', text: 'The sandboxed command finished.' }], stopReason: 'end_turn' },
      );
      await running.page.evaluate(() =>
        window.api.invoke('chat:send', { text: 'Run a sandboxed command without Git' }),
      );
      await expect
        // Allow cold AppContainer startup, but do not prepare unrelated runner PATH toolchains.
        .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy), {
          timeout: 75_000,
        })
        .toBe(false);
      const tools = await running.page.evaluate(async () =>
        (await window.api.invoke('chat:snapshot')).transcript.filter((item) => item.kind === 'tool'),
      );
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ status: 'done', output: expect.stringContaining('Exit code: 0') });
      expect(tools[0]?.output).toContain('sandboxed');
      expect(tools[0]?.preview?.note).toContain('Sandboxed');
      expect(readFileSync(join(project, '.git'), 'utf8')).toBe(GIT_RESERVATION);
      expect(await running.page.evaluate(async () => (await window.api.invoke('git:status')).isRepo)).toBe(false);
    },
    90_000,
  );

  it.skipIf(!support.bwrap && !support.seatbelt && !support.appcontainer)(
    'refuses commands when application data is opened as a project (#145)',
    async () => {
      await running.page.evaluate((path) => window.api.invoke('project:open', path), running.userData);
      try {
        claude.script(
          {
            blocks: [{ type: 'tool_use', id: 'unsafe-root', name: 'run_command', input: { command: 'echo unsafe' } }],
            stopReason: 'tool_use',
          },
          { blocks: [{ type: 'text', text: 'The unsafe root was refused.' }], stopReason: 'end_turn' },
        );
        await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Try a sandboxed command' }));
        await expect
          .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy))
          .toBe(false);
        const tools = await running.page.evaluate(async () =>
          (await window.api.invoke('chat:snapshot')).transcript.filter((item) => item.kind === 'tool'),
        );
        expect(tools).toHaveLength(1);
        expect(tools[0]?.output).toContain('Sandbox refused this project root');
        expect(tools[0]?.output).not.toContain('Exit code: 0');
        expect(existsSync(join(running.userData, '.git'))).toBe(false);
      } finally {
        await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
      }
    },
  );

  it.each([
    { network: true },
    { unsandboxed: true },
    { background: true, unsandboxed: true },
    {},
    { background: true },
  ])('does not let Auto or an allow rule bypass escalation: %j', async (access) => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    // A literal allow-listed URL must not authorize unrestricted network, arbitrary code or background work without
    // a card. Where the allow-list is enforced, the command runs, but with network only to the allowed hosts.
    const escalates = 'network' in access || 'unsandboxed' in access;
    const command = escalates ? 'echo denied > denied.txt' : 'echo https://allowed.test > denied.txt';
    claude.script({
      blocks: [{ type: 'tool_use', id: 'request', name: 'run_command', input: { command, ...access } }],
      stopReason: 'tool_use',
    });
    if (filtered && !escalates)
      claude.script({ blocks: [{ type: 'text', text: 'Ran filtered.' }], stopReason: 'end_turn' });
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Run the test command' }));
    if (filtered && !escalates) {
      await expect
        .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy), {
          timeout: 30_000,
        })
        .toBe(false);
      const tool = (await running.page.evaluate(() => window.api.invoke('chat:snapshot'))).transcript.find(
        (item) => item.kind === 'tool',
      );
      expect(tool?.preview?.note).toContain('network only to the allowed hosts');
      expect(await running.page.locator('.tool-card.awaiting').count()).toBe(0);
      rmSync(join(project, 'denied.txt'), { force: true });
      return;
    }
    const card = running.page.locator('.tool-card.awaiting');
    await card.waitFor();
    expect(existsSync(join(project, 'denied.txt'))).toBe(false);
    if (captureDir && Object.keys(access).length === 0)
      await card.screenshot({ path: join(captureDir, 'sandbox-network-approval.png') });
    await card.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect
      .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy))
      .toBe(false);
    expect(existsSync(join(project, 'denied.txt'))).toBe(false);
  });

  it('approves only one unsandboxed run, then asks again for the same command', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    const command = 'echo approved-once >> approved.txt';
    claude.script(
      ...['first', 'second'].map((id) => ({
        blocks: [{ type: 'tool_use' as const, id, name: 'run_command', input: { command, unsandboxed: true } }],
        stopReason: 'tool_use' as const,
      })),
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Run twice' }));
    const card = running.page.locator('.tool-card.awaiting');
    await card.waitFor();
    expect(await card.textContent()).toContain('Allowed to run without a sandbox');
    expect(await card.textContent()).toContain('no filesystem confinement and unrestricted network access');
    expect(existsSync(join(project, 'approved.txt'))).toBe(false);
    await card.getByRole('button', { name: 'Approve & Run', exact: true }).click();
    await expect.poll(() => running.page.locator('.tool-card').count()).toBe(2);
    await card.waitFor();
    if (captureDir) await card.screenshot({ path: join(captureDir, 'sandbox-approval.png') });
    await card.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect
      .poll(() => running.page.evaluate(async () => (await window.api.invoke('chat:snapshot')).busy))
      .toBe(false);
    const output = readFileSync(join(project, 'approved.txt'));
    // Windows PowerShell redirects as UTF-16LE; POSIX shells use UTF-8.
    expect(output.toString(process.platform === 'win32' ? 'utf16le' : 'utf8').match(/approved-once/g)).toHaveLength(1);
    expect(await running.page.evaluate(async () => (await window.api.invoke('settings:get')).sandboxMode)).toBe('auto');
    expect(running.errors).toEqual([]);
  });
});
