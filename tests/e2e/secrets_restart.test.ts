import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, waitForDurableSecrets } from './app';

// Saved keys are encrypted with safeStorage, whose own key reaches the profile's `Local State` only about 10 s after it
// is created, or when the app quits. A crash before that loses it, and the saved key can never be decrypted (#54).
describe('saved keys across an abrupt exit', () => {
  let userData: string;

  beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'patch-e2e-secrets-'));
  });

  afterAll(() => rmSync(userData, { recursive: true, force: true }));

  it('says so when a key saved right before a crash can no longer be read', async () => {
    const first = await launchApp({}, { userData });
    await first.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-crash'));
    // Killed at once, before Chromium writes the encryption key, as a crash or power loss right after saving would.
    await first.kill({ keepSecrets: false });

    const second = await launchApp({}, { userData });
    try {
      await second.page.getByText(/Your saved Anthropic API key could not be read/).waitFor({ timeout: 15_000 });
      expect(second.errors).toEqual([]);
    } finally {
      await second.kill({ keepSecrets: false });
    }
  });

  it('keeps a saved key usable once it has been written, even after an abrupt exit', async () => {
    const first = await launchApp({}, { userData });
    await first.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-kept'));
    await waitForDurableSecrets(userData);
    await first.kill();

    const second = await launchApp({}, { userData });
    try {
      // No notice: the key decrypts. Give a notice the time it would need to appear.
      await second.page.waitForTimeout(1500);
      expect(await second.page.getByText(/could not be read/).count()).toBe(0);
    } finally {
      await second.close();
    }
  });
});
