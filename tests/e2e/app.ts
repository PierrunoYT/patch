import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

export interface RunningApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
  errors: string[];
  // Ends the app abruptly (SIGKILL), as a crash or power loss would: no quit handlers run and nothing more is saved.
  // On a profile the test reuses, it first waits until saved keys are decryptable after a restart (see
  // waitForDurableSecrets); `{ keepSecrets: false }` skips that, to test what a crash right after saving a key does.
  kill(options?: { keepSecrets?: boolean }): Promise<void>;
  // Output the main process wrote to stderr (e.g. errors from IPC handlers).
  mainErrors: string[];
  close(): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 20_000;
const SECRETS_TIMEOUT_MS = 15_000;

// On Windows, safeStorage uses a profile key protected by DPAPI. Chromium writes that key to `Local State` about 10 s
// after creating it, or when the app quits, so an abrupt restart must not race that write. macOS stores its key in the
// Keychain, while Linux may use a keyring or the `basic_text` backend; neither platform uses this Windows durability
// signal. Waits for it only when a Windows profile contains encrypted secrets, and returns at once otherwise.
export async function waitForDurableSecrets(userData: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(readFileSync(join(userData, file), 'utf8'));
    } catch {
      return null;
    }
  };
  const secrets = Object.values(read('settings.json')?.secrets ?? {});
  if (!secrets.some((value) => typeof value === 'string' && !value.startsWith('plain:'))) return;
  const deadline = Date.now() + SECRETS_TIMEOUT_MS;
  while (!read('Local State')?.os_crypt?.encrypted_key) {
    if (Date.now() > deadline) {
      throw new Error(`The saved keys' encryption key never reached ${join(userData, 'Local State')}.`);
    }
    await delay(200);
  }
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Ends a process and everything it started.
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Launches the built app (run `npm run build` first) with a throwaway profile. Pass `userData` to start again on the
// profile of an earlier launch, as after a restart; that folder is then left for the caller to remove.
export async function launchApp(
  env: Record<string, string> = {},
  options: { userData?: string } = {},
): Promise<RunningApp> {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'patch-e2e-'));
  const root = resolve(__dirname, '../..');
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...process.env,
      PATCH_USER_DATA: userData,
      // Test projects live in the temp folder; git must not treat them as part of a repository above it (say, an
      // accidental one in the home folder), whose `git status` would scan the whole profile on every refresh.
      GIT_CEILING_DIRECTORIES: tmpdir(),
      // Invisible windows that never take focus, so a test run does not flash windows over your work.
      // Set E2E_SHOW_WINDOW=1 to watch the tests.
      ...(process.env.E2E_SHOW_WINDOW ? {} : { PATCH_E2E_QUIET: '1' }),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  const mainErrors: string[] = [];
  app.process().stderr?.on('data', (data: Buffer) => mainErrors.push(data.toString()));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.waitForLoadState('domcontentloaded');
  // The window is sized from the screen, which differs between machines (Xvfb's default is 640x480), and macOS keeps
  // windows within the screen. Narrow windows hide parts of the footer, so give every run the same desktop layout.
  await page.setViewportSize({ width: 1400, height: 1000 });
  // Answer only Patch's native settings and terminal confirmations; browser confirms must remain under Playwright's
  // control. Each one is recorded; a test sets __patchConfirmResponse to 1 to press Cancel.
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { __patchConfirmations: string[]; __patchConfirmResponse: number };
    state.__patchConfirmations = [];
    state.__patchConfirmResponse = 0;
    const showMessageBox = dialog.showMessageBox;
    const answer = async (...args: unknown[]) => {
      const options = args.find((arg) => typeof arg === 'object' && arg !== null && 'message' in arg) as {
        detail?: string;
        title?: string;
      };
      if (options?.title !== 'Confirm settings' && options?.title !== 'Start terminal')
        return Reflect.apply(showMessageBox, dialog, args);
      state.__patchConfirmations.push(options?.detail ?? '');
      return { response: state.__patchConfirmResponse, checkboxChecked: false };
    };
    dialog.showMessageBox = answer as typeof dialog.showMessageBox;
  });

  let killed = false;
  return {
    app,
    page,
    userData,
    errors,
    mainErrors,
    async kill({ keepSecrets = true }: { keepSecrets?: boolean } = {}) {
      if (options.userData && keepSecrets && existsSync(userData)) await waitForDurableSecrets(userData);
      const child = app.process();
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      killed = true;
      // The whole tree: on Windows, renderer and GPU processes outlive a killed main process and keep holding the
      // profile's single-instance lock, so the next launch on the same profile would quit at once.
      killTree(child.pid);
      await exited;
    },
    async close() {
      if (killed) {
        if (!options.userData) rmSync(userData, { recursive: true, force: true });
        return;
      }
      // A profile the test reuses must keep its saved keys usable for the next launch.
      if (options.userData) await waitForDurableSecrets(userData);
      // A hang here would otherwise surface as an opaque 60-second hook timeout. After 20 seconds the app is killed, so
      // no processes are left behind, and the test fails with what the main process printed.
      const pid = app.process().pid;
      const closed = await Promise.race([app.close().then(() => true), delay(CLOSE_TIMEOUT_MS).then(() => false)]);
      if (!closed) {
        killTree(pid);
        throw new Error(
          `The app did not quit within ${CLOSE_TIMEOUT_MS / 1000} s of being closed (pid ${pid}); it was killed. Main process output: ${mainErrors.join('').slice(-2000) || '(none)'}`,
        );
      }
      if (!options.userData) rmSync(userData, { recursive: true, force: true });
    },
  };
}
