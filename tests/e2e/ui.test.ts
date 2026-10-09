import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// Screenshots are written here for manual review when E2E_SCREENSHOTS is set.
const screenshotDir = process.env.E2E_SCREENSHOTS;

describe('user interface', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-ui-project-'));
    writeFileSync(join(project, 'app.js'), 'console.log("hello");\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  const shot = async (name: string) => {
    if (screenshotDir) await running.page.screenshot({ path: join(screenshotDir, `${name}.png`) });
  };

  it('asks for a project first', async () => {
    await running.page.getByText('Open a project to start').waitFor();
    await shot('1-welcome');
  });

  it('keeps navigation and prompt controls usable at desktop sizes', async () => {
    for (const size of [
      { width: 1440, height: 900 },
      { width: 800, height: 500 },
    ]) {
      await running.page.setViewportSize(size);
      await running.page
        .locator('.composer-controls')
        .getByLabel('Model', { exact: true })
        .selectOption('claude-sonnet-5-5');
      expect(await running.page.getByLabel('Model', { exact: true }).inputValue()).toBe('claude-sonnet-5-5');
      // A new viewport size is laid out on the next frames.
      await running.page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const geometry = await running.page.evaluate(() => {
        const input = document.querySelector('.composer-input')!.getBoundingClientRect();
        const send = document.querySelector('.composer-send')!.getBoundingClientRect();
        const attach = document.querySelector('[aria-label="Attach images"]')!.getBoundingClientRect();
        const model = document.querySelector('.model-pill')!.getBoundingClientRect();
        const box = document.querySelector('.composer-box')!;
        const controls = document.querySelector('.header-controls')!.getBoundingClientRect();
        const actions = document.querySelector('.composer-right')!.getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          inputWidth: input.width,
          sendRight: send.right,
          sendBottom: send.bottom,
          overflow: document.querySelector('.app-main')!.scrollWidth,
          // Which part of the window is too wide, if anything is.
          widths: [...document.querySelector('.app-main')!.children].map(
            (child) => `${child.className}=${Math.round(child.getBoundingClientRect().width)}/${child.scrollWidth}`,
          ),
          composerOverflow: box.scrollWidth - box.clientWidth,
          attachCenter: attach.top + attach.height / 2,
          modelCenter: model.top + model.height / 2,
          sendCenter: send.top + send.height / 2,
          controlsOverlapActions:
            controls.left < actions.right &&
            controls.right > actions.left &&
            controls.top < actions.bottom &&
            controls.bottom > actions.top,
        };
      });
      expect(geometry.inputWidth).toBeGreaterThan(180);
      expect(geometry.sendRight).toBeLessThanOrEqual(geometry.width);
      expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.overflow, geometry.widths.join(' ')).toBeLessThanOrEqual(geometry.width);
      expect(geometry.composerOverflow).toBeLessThanOrEqual(1);
      expect(geometry.controlsOverlapActions).toBe(false);
      if (size.width === 1440) {
        expect(Math.abs(geometry.attachCenter - geometry.modelCenter)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.attachCenter - geometry.sendCenter)).toBeLessThanOrEqual(1);
      }
      await shot(`layout-${size.width}`);
    }
    await running.page.getByLabel('Model', { exact: true }).selectOption('claude-opus-5-5');
    const toggle = running.page.getByTitle('Show or hide the sidebar');
    await toggle.click();
    expect(await running.page.locator('.sidebar').isVisible()).toBe(false);
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await toggle.click();
    expect(await running.page.locator('.sidebar').isVisible()).toBe(true);
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    await running.page.setViewportSize({ width: 1440, height: 900 });
  });

  it('shows the project and a missing-key hint after opening it', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.getByText('Add your Anthropic API key').waitFor();
    await expect(running.page.locator('.project-button').textContent()).resolves.toContain(
      project.split(/[\\/]/).pop(),
    );
  });

  it('saves an API key through the settings dialog', async () => {
    await running.page.getByTitle('Settings (Ctrl+,)').click();
    await running.page.getByLabel('Anthropic API key').fill('sk-ant-ui-test');
    await running.page.getByText('Network hosts allowed without asking').scrollIntoViewIfNeeded();
    await shot('2-settings');
    await running.page.getByRole('button', { name: 'Save' }).click();
    await running.page.getByText('Add your Anthropic API key').waitFor({ state: 'detached' });
    const view = await running.page.evaluate(() => window.api.invoke('settings:get'));
    expect(view.secrets.anthropicApiKey).toBe(true);
  });

  it('sends a message with Enter and renders the streamed answer as markdown', async () => {
    claude.script({ blocks: [{ type: 'text', text: 'Here is **bold** and `code`.' }], stopReason: 'end_turn' });
    const input = running.page.getByLabel('Message', { exact: true });
    await input.fill('Say something');
    await input.press('Enter');

    await running.page.locator('.message.assistant strong', { hasText: 'bold' }).waitFor();
    await expect(input.inputValue()).resolves.toBe('');
    await expect(running.page.locator('.message.user .bubble').textContent()).resolves.toBe('Say something');
  });

  it('renders hostile model output inert', async () => {
    claude.script({
      blocks: [
        {
          type: 'text',
          text: 'Look <img src=x onerror="window.__pwned=1"> <a href="javascript:window.__pwned=2">link</a> <script>window.__pwned=3</script> done',
        },
      ],
      stopReason: 'end_turn',
    });
    const input = running.page.getByLabel('Message', { exact: true });
    await input.fill('Show me something');
    await input.press('Enter');
    await running.page.locator('.message.assistant', { hasText: 'done' }).waitFor();
    await running.page.waitForTimeout(300);

    const result = await running.page.evaluate(() => ({
      pwned: (window as any).__pwned ?? null,
      html: [...document.querySelectorAll('.message.assistant .markdown')].map((el) => el.innerHTML).join(''),
    }));
    expect(result.pwned).toBeNull();
    expect(result.html).not.toMatch(/onerror|<script|javascript:/i);
  });

  it('removes SVG images and MathML while preserving HTML markdown and literal code', async () => {
    claude.script({
      blocks: [
        {
          type: 'text',
          text: [
            '**HTML-only formatting** and [safe link](https://example.com/).',
            '',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" width="1" height="1" /></svg>',
            '',
            '<svg><filter id="model-filter"><feImage href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" /></filter></svg>',
            '',
            '<math><mrow><mi>x</mi><mo>=</mo><mn>7</mn></mrow></math>',
            '',
            '```html',
            '<svg><image href="example.png" /></svg>',
            '```',
            '',
            'Namespace payload complete.',
          ].join('\n'),
        },
      ],
      stopReason: 'end_turn',
    });
    const input = running.page.getByLabel('Message', { exact: true });
    await input.fill('Show HTML-only markdown');
    await input.press('Enter');
    const markdown = running.page.locator('.message.assistant .markdown', { hasText: 'Namespace payload complete.' });
    await markdown.waitFor();

    expect(await markdown.locator('svg, image, feImage, filter, math, mrow, mi, img').count()).toBe(0);
    expect(await markdown.locator('strong').textContent()).toBe('HTML-only formatting');
    expect(await markdown.locator('a', { hasText: 'safe link' }).getAttribute('href')).toBe('https://example.com/');
    expect(await markdown.locator('pre code.hljs.language-html').textContent()).toBe(
      '<svg><image href="example.png" /></svg>\n',
    );
    expect(await markdown.locator('pre code .hljs-tag').count()).toBeGreaterThan(0);
    if (screenshotDir) await markdown.screenshot({ path: join(screenshotDir, 'markdown-html-only.png') });
  });

  it('strips model CSS overlays while preserving markdown and syntax highlighting', async () => {
    claude.script({
      blocks: [
        {
          type: 'text',
          text: [
            '<style>.model-overlay { position: fixed; inset: 0; z-index: 2147483647; }</style>',
            '',
            '<span class="model-overlay" style="position:fixed;inset:0;z-index:2147483647">Overlay payload</span>',
            '',
            '**Safe formatting** and [safe link](https://example.com/).',
            '',
            '```javascript',
            'const safe = true;',
            '```',
            '',
            'CSS payload complete.',
          ].join('\n'),
        },
      ],
      stopReason: 'end_turn',
    });
    const input = running.page.getByLabel('Message', { exact: true });
    await input.fill('Show styled markdown');
    await input.press('Enter');
    const markdown = running.page.locator('.message.assistant .markdown', { hasText: 'CSS payload complete.' });
    await markdown.waitFor();

    expect(await markdown.locator('style, [style]').count()).toBe(0);
    // Its class is removed too (#254), so the span is found by its text.
    expect(await markdown.locator('.model-overlay').count()).toBe(0);
    const overlay = markdown.locator('span', { hasText: 'Overlay payload' });
    expect(await overlay.textContent()).toBe('Overlay payload');
    expect(await overlay.getAttribute('class')).toBeNull();
    expect(
      await overlay.evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, zIndex: style.zIndex };
      }),
    ).toEqual({ position: 'static', zIndex: 'auto' });
    expect(await markdown.locator('strong').textContent()).toBe('Safe formatting');
    expect(await markdown.locator('a', { hasText: 'safe link' }).getAttribute('href')).toBe('https://example.com/');
    expect(await markdown.locator('pre code.hljs.language-javascript').textContent()).toBe('const safe = true;\n');
    expect(await markdown.locator('pre code .hljs-keyword').textContent()).toBe('const');
  });

  it('shows a diff for approval and applies the edit when Approve is clicked', async () => {
    claude.script(
      {
        blocks: [
          { type: 'text', text: 'Reading first.' },
          { type: 'tool_use', id: 'toolu_r', name: 'read_file', input: { path: 'app.js' } },
        ],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_e',
            name: 'edit_file',
            input: { path: 'app.js', old_string: '"hello"', new_string: '"hello, world"' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Updated the greeting.' }], stopReason: 'end_turn' },
    );
    const input = running.page.getByLabel('Message', { exact: true });
    await input.fill('Change the greeting');
    await input.press('Enter');

    const card = running.page.locator('.tool-card.awaiting');
    await card.waitFor();
    await expect(card.locator('.tool-diff').textContent()).resolves.toContain('hello, world');
    await card.locator('.tool-diff .d2h-wrapper .d2h-code-line').first().waitFor();
    await expect(running.page.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await shot('3-approval');

    await card.getByRole('button', { name: 'Approve' }).click();
    await running.page.getByText('Updated the greeting.', { exact: true }).waitFor();
    expect(readFileSync(join(project, 'app.js'), 'utf8')).toContain('hello, world');
    await expect(running.page.locator('.tool-card.awaiting').count()).resolves.toBe(0);
    await expect(running.page.locator('.tool-card').count()).resolves.toBe(2);
    await shot('4-done');
  });

  it('lists the chat in history', async () => {
    await running.page.getByTitle('Chat history').click();
    await shot('5-history');
    const items = running.page.locator('.history-list .list-group-item');
    await items.first().waitFor();
    await expect(items.count()).resolves.toBe(1);

    // The search also looks inside the messages and shows where it matched.
    const search = running.page.getByLabel('Search chats');
    await search.fill('say something');
    await running.page.locator('.history-list .fst-italic', { hasText: 'Say something' }).waitFor();
    await search.fill('no-such-words-anywhere');
    await running.page.locator('.history-list', { hasText: 'No chats match your search.' }).waitFor();
    await search.fill('');
    await expect(items.count()).resolves.toBe(1);
    await running.page.keyboard.press('Escape');
  });

  it('starts a new chat', async () => {
    await running.page.getByRole('button', { name: 'New chat' }).click();
    await running.page.locator('.message').first().waitFor({ state: 'detached' });
  });

  it('runs without renderer errors', () => {
    expect(running.errors.join('\n')).toBe('');
  });
});
