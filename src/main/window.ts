import { app, BrowserWindow, screen, session, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { AGENT_BROWSER_PARTITION, allowsWebviewAttach, BROWSER_PARTITIONS } from '@shared/panels';
import { appLog } from './app_log';
import { devRendererUrl } from './renderer_url';

// Set by the end-to-end tests: the window is fully transparent, has no taskbar entry and never takes focus. It is still
// shown, so the page renders and animation frames run as they do for a user. On Linux a fully transparent X11 window
// stops being painted, which stalls animation frames and with them the transcript; tests there run under Xvfb, where
// nobody sees the window anyway, so it stays opaque.
const quietTestRun = process.env.PATCH_E2E_QUIET === '1';
const transparentTestWindow = quietTestRun && process.platform !== 'linux';

// `onAgentBrowserAttached` receives the guest of the Browser panel's agent session; the user's own guest is never
// handed to the agent.
export function createMainWindow(onAgentBrowserAttached: (guest: WebContents) => void): BrowserWindow {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const window = new BrowserWindow({
    show: false,
    width: Math.min(1400, Math.floor(screenWidth * 0.8)),
    height: Math.min(1000, Math.floor(screenHeight * 0.85)),
    minWidth: 800,
    minHeight: 500,
    title: 'Patch',
    icon: join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build'), 'icon.png'),
    ...(quietTestRun ? { skipTaskbar: true } : {}),
    ...(transparentTestWindow ? { opacity: 0 } : {}),
    webPreferences: {
      // A test window may sit behind others; it must not be slowed down for it.
      backgroundThrottling: !quietTestRun,
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Needed for the built-in browser panel. Guests are locked down in hardenWebContents.
      webviewTag: true,
    },
  });

  hardenWebContents(window, onAgentBrowserAttached);
  logWindowProblems(window);
  // Electron grants every permission request (camera, microphone, location, notifications) unless told otherwise.
  // Neither the app page nor pages in the browser panel (the user's session and the agent's) need any.
  for (const target of [session.defaultSession, ...BROWSER_PARTITIONS.map((name) => session.fromPartition(name))]) {
    target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
  }
  window.once('ready-to-show', () => (quietTestRun ? window.showInactive() : window.show()));

  const devUrl = devRendererUrl(app.isPackaged, process.env);
  if (devUrl) {
    window.loadURL(devUrl);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

// A window that hangs, or an app page that fails to load, is otherwise invisible to anyone but the person looking at it.
function logWindowProblems(window: BrowserWindow): void {
  window.on('unresponsive', () => appLog.warn('window', 'The window stopped responding.'));
  window.on('responsive', () => appLog.info('window', 'The window is responding again.'));
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3 is a navigation that was cancelled on purpose.
    if (isMainFrame && code !== -3) appLog.error('window', `The app page failed to load: ${description}`, { code });
  });
  window.webContents.on('preload-error', (_event, path, error) => appLog.error('preload', error, { path }));
}

// The app page is the only content the main window may show. Links open in the system browser, and pages
// loaded in the built-in browser (<webview>) never get a preload script or Node access.
function hardenWebContents(window: BrowserWindow, onAgentBrowserAttached: (guest: WebContents) => void): void {
  const openExternally = ({ url }: { url: string }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' as const };
  };

  window.webContents.setWindowOpenHandler(openExternally);

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      openExternally({ url });
    }
  });

  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // Only the panel's two sessions, starting on about:blank (the app navigates them itself).
    if (!allowsWebviewAttach(params.partition, params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // A present allowpopups attribute turns popups on whatever its value.
    delete params.allowpopups;
  });

  window.webContents.on('did-attach-webview', (_event, guest) => {
    // Programmatic loadURL bypasses will-navigate. Deny popups rather than letting a page escape the
    // browser tool's approved-host policy through window.open or a target=_blank link.
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (guest.session === session.fromPartition(AGENT_BROWSER_PARTITION)) onAgentBrowserAttached(guest);
  });
}
