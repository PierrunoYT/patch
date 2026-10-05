import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchApp, waitForDurableSecrets } from './app';
import { MockClaude } from './mock_claude';

describe('saved keys across an abrupt exit', () => {
  it('warns when a stored encrypted key is unreadable', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'patch-e2e-secrets-corrupt-'));
    // An invalid safeStorage payload models a profile whose ciphertext and OS-protected key no longer match without
    // depending on the platform-specific timing of Chromium persisting its encryption state.
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ settings: {}, secrets: { anthropicApiKey: 'AA==' } }),
    );
    const running = await launchApp({}, { userData });
    try {
      await running.page.getByText(/Your saved Anthropic API key could not be read/).waitFor({ timeout: 15_000 });
      expect(running.errors).toEqual([]);
    } finally {
      await running.kill({ keepSecrets: false });
      // taskkill can return before Chromium's database handles finish closing on Windows. Retry only teardown;
      // a persistent lock still throws, and no application assertion or launch is retried.
      rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('keeps a saved key usable once it has been written, even after an abrupt exit', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'patch-e2e-secrets-restart-'));
    const project = mkdtempSync(join(tmpdir(), 'patch-e2e-secrets-project-'));
    const claude = new MockClaude();
    const url = await claude.start();
    const first = await launchApp({ PATCH_TEST_ANTHROPIC_URL: url }, { userData });
    try {
      await first.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-kept'));
      await waitForDurableSecrets(userData);
      await first.kill();

      const second = await launchApp({ PATCH_TEST_ANTHROPIC_URL: url }, { userData });
      try {
        await second.page.evaluate((path) => window.api.invoke('project:open', path), project);
        claude.script({ blocks: [{ type: 'text', text: 'Secret works.' }], stopReason: 'end_turn' });
        await second.page.evaluate(() => window.api.invoke('chat:send', { text: 'Test the saved key.' }));
        await expect
          .poll(async () => (await second.page.evaluate(() => window.api.invoke('chat:snapshot'))).transcript.at(-1))
          .toMatchObject({ kind: 'assistant', text: 'Secret works.' });
        expect(claude.agentRequests).toHaveLength(1);
        expect(second.errors).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      await claude.stop();
      rmSync(project, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
