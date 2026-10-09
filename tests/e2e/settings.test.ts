import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionRule } from '../../src/shared/settings';
import { launchApp, type RunningApp } from './app';

describe('settings over IPC', () => {
  let running: RunningApp;

  beforeAll(async () => {
    running = await launchApp();
  });

  afterAll(async () => {
    await running?.close();
  });

  it('returns defaults with no secrets set', async () => {
    const view = await running.page.evaluate(() => window.api.invoke('settings:get'));
    expect(view.approvalMode).toBe('ask');
    expect(view.allowedNetworkHosts).toBe('');
    expect(Object.values(view.secrets).every((set) => set === false)).toBe(true);
  });

  it('offers the new models in Settings and persists their selection', async () => {
    const original = await running.page.evaluate(() => window.api.invoke('settings:get'));
    for (const model of ['claude-haiku-5-5', 'claude-fable-5-1', 'gpt-6.1-sol']) {
      await running.page.getByTitle('Settings (Ctrl+,)').click();
      const dialog = running.page.locator('.app-dialog');
      await dialog.getByLabel('Model', { exact: true }).selectOption(model);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      expect((await running.page.evaluate(() => window.api.invoke('settings:get'))).model).toBe(model);
    }
    await running.page.evaluate((model) => window.api.invoke('settings:update', { model }), original.model);
  });

  it('updates settings and pushes a change event', async () => {
    const theme = await running.page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const off = window.api.on('settings:changed', (view) => {
            off();
            resolve(view.theme);
          });
          window.api.invoke('settings:update', { theme: 'light' });
        }),
    );
    expect(theme).toBe('light');
  });

  it('keeps secrets out of the renderer and off disk in plain text', async () => {
    const view = await running.page.evaluate(() =>
      window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e-secret'),
    );
    expect(view.secrets.anthropicApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-ant-e2e-secret');

    const onDisk = readFileSync(join(running.userData, 'settings.json'), 'utf8');
    if (view.secretsEncrypted) {
      expect(onDisk).not.toContain('sk-ant-e2e-secret');
    }
  });

  it('rejects unknown secret names', async () => {
    const message = await running.page.evaluate(() =>
      (window.api.invoke as any)('settings:set-secret', 'nope', 'x').catch((error: Error) => error.message),
    );
    expect(message).toContain('Invalid arguments for settings:set-secret');
  });

  it('confirms removal of protective permission rules and leaves settings intact when cancelled', async () => {
    const rules: PermissionRule[] = [
      { tool: 'run_command', matches: { command: 'git push*' }, action: 'ask' },
      { tool: 'write_file', action: 'reject' },
    ];
    await running.app.evaluate(() => {
      (globalThis as any).__patchConfirmations = [];
    });
    await running.page.evaluate((permissionRules) => window.api.invoke('settings:update', { permissionRules }), rules);
    expect(await running.app.evaluate(() => (globalThis as any).__patchConfirmations)).toEqual([]);
    const before = await running.page.evaluate(() => window.api.invoke('settings:get'));
    const onDisk = readFileSync(join(running.userData, 'settings.json'), 'utf8');

    await running.app.evaluate(() => {
      (globalThis as any).__patchConfirmResponse = 1;
    });
    const rejected = await running.page.evaluate(() =>
      window.api
        .invoke('settings:update', { permissionRules: [], theme: 'dark' })
        .catch((error: Error) => error.message),
    );
    expect(rejected).toContain('cancelled');
    expect(await running.page.evaluate(() => window.api.invoke('settings:get'))).toEqual(before);
    expect(readFileSync(join(running.userData, 'settings.json'), 'utf8')).toBe(onDisk);
    const confirmations = await running.app.evaluate(() => (globalThis as any).__patchConfirmations as string[]);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain('ask protection for run_command matching {"command":"git push*"}');
    expect(confirmations[0]).toContain('reject protection for write_file');

    await running.app.evaluate(() => {
      (globalThis as any).__patchConfirmResponse = 0;
    });
    const updated = await running.page.evaluate(() => window.api.invoke('settings:update', { permissionRules: [] }));
    expect(updated.permissionRules).toEqual([]);
    expect(JSON.parse(readFileSync(join(running.userData, 'settings.json'), 'utf8')).settings.permissionRules).toEqual(
      [],
    );
  });

  it('saves native sandbox environment grants and PATH through Settings', async () => {
    await running.app.evaluate(() => {
      (globalThis as any).__patchConfirmResponse = 1;
    });
    const rejected = await running.page.evaluate(() =>
      window.api
        .invoke('settings:update', {
          sandboxEnvAllowList: 'REJECTED_PRIVATE_VALUE',
          sandboxPath: '/rejected/toolchain',
        })
        .catch((error: Error) => error.message),
    );
    expect(rejected).toContain('cancelled');
    const unchanged = await running.page.evaluate(() => window.api.invoke('settings:get'));
    expect(unchanged.sandboxEnvAllowList).toBe('');
    expect(unchanged.sandboxPath).toBe('');
    await running.app.evaluate(() => {
      (globalThis as any).__patchConfirmResponse = 0;
    });
    await running.page.getByTitle('Settings (Ctrl+,)').click();
    const dialog = running.page.locator('.app-dialog');
    await dialog.getByLabel('Extra native sandbox environment variables').fill('CC\nCUSTOM_BUILD_VALUE');
    await dialog.getByLabel('Native sandbox PATH').fill('/trusted/toolchain/bin');
    expect(await dialog.textContent()).toContain('Their values become visible to commands');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const settings = await running.page.evaluate(() => window.api.invoke('settings:get'));
    expect(settings.sandboxEnvAllowList).toBe('CC\nCUSTOM_BUILD_VALUE');
    expect(settings.sandboxPath).toBe('/trusted/toolchain/bin');
    const confirmations = await running.app.evaluate(() => (globalThis as any).__patchConfirmations as string[]);
    expect(
      confirmations.some((text) => text.includes('CUSTOM_BUILD_VALUE') && text.includes('/trusted/toolchain/bin')),
    ).toBe(true);
    await running.page.getByTitle('Settings (Ctrl+,)').click();
    expect(await running.page.getByLabel('Extra native sandbox environment variables').inputValue()).toBe(
      'CC\nCUSTOM_BUILD_VALUE',
    );
    expect(await running.page.getByLabel('Native sandbox PATH').inputValue()).toBe('/trusted/toolchain/bin');
    await running.page.getByRole('button', { name: 'Cancel' }).click();
  });
});
