import type { WebContents } from 'electron';
import type { BrowserController, PageLoadResult } from '../tools/browser';

const LOAD_TIMEOUT_MS = 20_000;
// Screenshots are scaled down so they stay within the image size models accept.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_CONSOLE_MESSAGES = 200;

// Controls the agent's page in the browser panel. The renderer owns two <webview> elements: the user's, in their
// persistent session, and the agent's, in a separate in-memory session. Only the agent's guest webContents is handed to
// this class when it attaches, so the agent can load pages, read console output and take screenshots without ever
// using the user's cookies or sign-ins.
export class BrowserService implements BrowserController {
  private guest: WebContents | null = null;
  private waiters: Array<() => void> = [];
  // No policy until the agent opens a page: the user browses freely until then.
  private isNavigationAllowed: ((url: string) => boolean) | null = null;
  private blockedNavigation: string | null = null;

  constructor(
    private readonly show: () => void,
    // Deletes the agent session's cookies, storage and cache.
    private readonly clearStorage: () => Promise<void> = async () => {},
  ) {}

  attach(guest: WebContents): void {
    this.guest = guest;
    const guard = (event: Electron.Event, url: string) => {
      if (this.isNavigationAllowed && !this.isNavigationAllowed(url)) {
        event.preventDefault();
        this.blockedNavigation = url;
      }
    };
    // These cancellable events cover page-initiated top-level navigations and HTTP redirects. Once the agent has
    // opened a page, the listeners stay attached after open() returns so later navigations cannot escape the policy
    // established by the tool call. Typing in the address bar uses loadURL, which these events do not cover.
    guest.on('will-navigate', guard);
    guest.on('will-redirect', guard);
    guest.once('destroyed', () => {
      if (this.guest === guest) this.guest = null;
    });
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  // Asked by both panel sessions' request filters for every request, frames and sub-resources included: those never
  // fire will-navigate, so a project page could otherwise show a file from outside the project in an <iframe> and a
  // screenshot would hand it to the model. Only file:// is checked; web pages cannot load file:// themselves.
  allowsRequest(url: string): boolean {
    if (!/^file:/i.test(url) || !this.isNavigationAllowed) return true;
    return this.isNavigationAllowed(url);
  }

  // A new chat or project starts the agent's browser afresh: no page, no history, no cookies or storage from before.
  async reset(): Promise<void> {
    this.isNavigationAllowed = null;
    this.blockedNavigation = null;
    const guest = this.available ? this.guest! : null;
    if (guest) {
      await guest.loadURL('about:blank').catch(() => {});
      guest.navigationHistory.clear();
    }
    await this.clearStorage();
  }

  get available(): boolean {
    return this.guest !== null && !this.guest.isDestroyed();
  }

  async open(
    url: string,
    signal: AbortSignal,
    isNavigationAllowed: (url: string) => boolean = (destination) => destination === url,
  ): Promise<PageLoadResult> {
    this.show();
    const guest = await this.waitForGuest();
    const console: string[] = [];
    let status: number | null = null;
    let error: string | undefined;
    this.isNavigationAllowed = isNavigationAllowed;
    this.blockedNavigation = null;

    const onConsole = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      if (console.length < MAX_CONSOLE_MESSAGES) console.push(`[${event.level}] ${event.message}`);
    };
    const onNavigate = (_event: Electron.Event, _url: string, code: number) => {
      status = code > 0 ? code : null;
    };
    const onFail = (_event: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean) => {
      // -3 is an aborted load, e.g. a redirect replacing it.
      if (isMainFrame && code !== -3) error = `${description} (${code})`;
    };
    guest.on('console-message', onConsole);
    guest.on('did-navigate', onNavigate);
    guest.on('did-fail-load', onFail);

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      // The chat may have been stopped while waiting for the panel, before the abort listener existed.
      if (signal.aborted) throw new Error('Stopped.');
      await Promise.race([
        guest.loadURL(url).catch((loadError: Error) => {
          error ??= loadError.message;
        }),
        new Promise((resolve) => (timer = setTimeout(resolve, LOAD_TIMEOUT_MS))),
        new Promise((_, reject) => {
          onAbort = () => reject(new Error('Stopped.'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      // Let scripts that run right after load log their errors.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.blockedNavigation) error = `Blocked navigation to unapproved URL: ${this.blockedNavigation}`;
      return { url: guest.getURL(), title: guest.getTitle(), status, console: [...console], error };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      guest.off('console-message', onConsole);
      guest.off('did-navigate', onNavigate);
      guest.off('did-fail-load', onFail);
    }
  }

  async screenshot(): Promise<string> {
    const guest = await this.waitForGuest();
    let image = await guest.capturePage();
    const { width } = image.getSize();
    if (width > MAX_SCREENSHOT_WIDTH) image = image.resize({ width: MAX_SCREENSHOT_WIDTH });
    return image.toPNG().toString('base64');
  }

  // The panel may not have been shown yet; opening it creates the webview.
  private waitForGuest(): Promise<WebContents> {
    if (this.available) return Promise.resolve(this.guest!);
    return new Promise((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.guest!);
      };
      const timer = setTimeout(() => {
        // Drop the waiter so a failed wait leaks no closure and a later attach has nothing stale to resolve.
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('The browser panel did not open.'));
      }, 5000);
      this.waiters.push(waiter);
    });
  }
}
