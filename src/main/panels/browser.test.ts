import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { BrowserService } from './browser';

class FakeGuest extends EventEmitter {
  destroyed = false;
  url = 'about:blank';
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
    this.emit('did-navigate', {}, url, 200);
    this.emit('console-message', { level: 'error', message: 'boom' });
  });
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getTitle = () => 'Title';
  capturePage = vi.fn();
  navigationHistory = { clear: vi.fn() };
  setWebRTCIPHandlingPolicy = vi.fn();
}

function attach(service: BrowserService, guest: FakeGuest): void {
  service.attach(guest as unknown as WebContents);
}

describe('BrowserService', () => {
  it('reports availability and forgets a destroyed guest', () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    expect(service.available).toBe(false);
    attach(service, guest);
    expect(service.available).toBe(true);
    guest.destroyed = true;
    guest.emit('destroyed');
    expect(service.available).toBe(false);
  });

  it('opens a page and returns its status, title and console output', async () => {
    const show = vi.fn();
    const service = new BrowserService(show);
    const guest = new FakeGuest();
    attach(service, guest);

    const result = await service.open('http://localhost/test', new AbortController().signal);
    expect(show).toHaveBeenCalled();
    expect(result).toEqual({
      url: 'http://localhost/test',
      title: 'Title',
      status: 200,
      console: ['[error] boom'],
      error: undefined,
    });
    // The listeners are removed again, so later page output is not collected.
    expect(guest.listenerCount('console-message')).toBe(0);
    expect(guest.listenerCount('did-navigate')).toBe(0);
    expect(guest.listenerCount('did-fail-load')).toBe(0);
  });

  it('reports load failures but ignores aborted loads', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.loadURL.mockImplementation(async () => {
      guest.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x', true);
      guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://x', true);
      guest.emit('did-fail-load', {}, -2, 'subframe error', 'http://x', false);
    });
    attach(service, guest);
    const result = await service.open('http://x', new AbortController().signal);
    expect(result.error).toBe('ERR_NAME_NOT_RESOLVED (-105)');
  });

  it('blocks redirects and later navigations outside the approved policy', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    attach(service, guest);
    const result = await service.open('https://allowed.test/start', new AbortController().signal, (url) =>
      url.startsWith('https://allowed.test/'),
    );
    const redirectEvent = { preventDefault: vi.fn() };
    guest.emit('will-redirect', redirectEvent, 'https://evil.test/redirect');
    expect(redirectEvent.preventDefault).toHaveBeenCalled();
    const laterEvent = { preventDefault: vi.fn() };
    guest.emit('will-navigate', laterEvent, 'https://evil.test/later');
    expect(laterEvent.preventDefault).toHaveBeenCalled();
    expect(result.error).toBeUndefined();
  });

  it('lets the user navigate before the agent has opened a page', () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    attach(service, guest);
    const event = { preventDefault: vi.fn() };
    guest.emit('will-navigate', event, 'https://anywhere.test/');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('reports the error when loadURL rejects', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.loadURL.mockRejectedValue(new Error('load failed'));
    attach(service, guest);
    const result = await service.open('http://x', new AbortController().signal);
    expect(result.error).toBe('load failed');
  });

  it('checks file:// requests against the policy of the page the agent opened', async () => {
    const service = new BrowserService(() => {});
    attach(service, new FakeGuest());
    // Before the agent opens a page, the user browses freely.
    expect(service.allowsRequest('file:///home/me/.ssh/id_rsa')).toBe(true);

    await service.open('file:///project/page.html', new AbortController().signal, (url) =>
      url.startsWith('file:///project/'),
    );
    expect(service.allowsRequest('file:///project/frame.html')).toBe(true);
    expect(service.allowsRequest('file:///home/me/.ssh/id_rsa')).toBe(false);
    expect(service.allowsRequest('FILE:///home/me/.ssh/id_rsa')).toBe(false);
    // A project file gets no network in the agent's session (#229); the user's own session is not limited.
    expect(service.allowsRequest('https://cdn.example/lib.js')).toBe(false);
    expect(service.allowsRequest('https://cdn.example/lib.js', false)).toBe(true);
  });

  it('takes the agent session off the network while it shows a project file (#229)', async () => {
    const calls: string[] = [];
    const setOffline = vi.fn(async (offline: boolean) => void calls.push(offline ? 'offline' : 'online'));
    const service = new BrowserService(
      () => {},
      async () => {},
      setOffline,
    );
    const guest = new FakeGuest();
    guest.loadURL.mockImplementation(async (url: string) => void calls.push(`load ${url}`));
    attach(service, guest);
    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');

    await service.open('file:///project/page.html', new AbortController().signal, (url) =>
      url.startsWith('file:///project/'),
    );
    // Offline before the page loads, so its scripts never see the network.
    expect(calls).toEqual(['offline', 'load file:///project/page.html']);
    expect(service.allowsRequest('https://attacker.example/?d=secret')).toBe(false);
    expect(service.allowsRequest('ws://127.0.0.1:9000/')).toBe(false);
    expect(service.allowsRequest('file:///project/.env')).toBe(true);
    // The user's own browser session keeps its network.
    expect(service.allowsRequest('https://example.com/', false)).toBe(true);

    // Opening a web page replaces the file page before the network comes back.
    calls.length = 0;
    await service.open('https://example.com/', new AbortController().signal);
    expect(calls).toEqual(['load about:blank', 'online', 'load https://example.com/']);
    expect(service.allowsRequest('https://example.com/app.js')).toBe(true);

    // A reset after a file page brings the network back too.
    await service.open('file:///project/page.html', new AbortController().signal, () => true);
    await service.reset();
    expect(setOffline).toHaveBeenLastCalledWith(false);
    expect(service.allowsRequest('https://example.com/')).toBe(true);
  });

  it('keeps a public page from reaching local addresses, but not a local page (#235)', async () => {
    const service = new BrowserService(() => {});
    attach(service, new FakeGuest());
    await service.open('https://example.com/', new AbortController().signal);
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://localhost:3000/api',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'ws://[::1]:9000/',
      'http://[64:ff9b::7f00:1]/',
    ]) {
      expect(service.allowsRequest(url)).toBe(false);
    }
    expect(service.allowsRequest('https://cdn.example/app.js')).toBe(true);
    // The user's own browser is not limited.
    expect(service.allowsRequest('http://127.0.0.1:8080/', false)).toBe(true);

    // A dev server the agent opened on purpose may load from local addresses.
    await service.open('http://localhost:5173/', new AbortController().signal);
    expect(service.allowsRequest('http://127.0.0.1:5173/@vite/client')).toBe(true);
    expect(service.allowsRequest('ws://localhost:5173/')).toBe(true);
  });

  it('also refuses public names that resolve to a local address, for a public page (#260)', async () => {
    const lookups: string[] = [];
    const resolve = async (host: string) => {
      lookups.push(host);
      if (host === 'gone.example') throw new Error('ENOTFOUND');
      return { local: host === 'rebind.example' ? '127.0.0.1' : null };
    };
    const service = new BrowserService(
      () => {},
      async () => {},
      async () => {},
      resolve,
    );
    attach(service, new FakeGuest());
    await service.open('https://example.com/', new AbortController().signal);
    expect(await service.checkRequest('http://rebind.example:8080/secret')).toBe(false);
    expect(await service.checkRequest('https://cdn.example/app.js')).toBe(true);
    expect(await service.checkRequest('https://cdn.example/other.js')).toBe(true);
    expect(await service.checkRequest('https://gone.example/x')).toBe(true);
    // Each name is resolved once per page; address literals and the user's own session are not resolved.
    expect(await service.checkRequest('http://127.0.0.1/')).toBe(false);
    expect(await service.checkRequest('http://rebind.example/', false)).toBe(true);
    expect(lookups).toEqual(['rebind.example', 'cdn.example', 'gone.example']);

    // A page the agent opened on a local address is not limited, and a new page resolves again.
    await service.open('http://localhost:3000/', new AbortController().signal);
    expect(await service.checkRequest('http://rebind.example/')).toBe(true);
    await service.open('https://example.com/', new AbortController().signal);
    expect(await service.checkRequest('http://rebind.example/')).toBe(false);
    expect(lookups.filter((host) => host === 'rebind.example')).toHaveLength(2);
  });

  it('stops when the chat is stopped', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.loadURL.mockImplementation(() => new Promise(() => {}));
    attach(service, guest);
    const controller = new AbortController();
    const pending = service.open('http://slow', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Stopped.');
    expect(guest.listenerCount('console-message')).toBe(0);
  });

  it('waits for the panel to attach a page', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.capturePage.mockResolvedValue({
      getSize: () => ({ width: 100, height: 50 }),
      toPNG: () => Buffer.from('png-bytes'),
    });
    const pending = service.screenshot();
    attach(service, guest);
    expect(await pending).toBe(Buffer.from('png-bytes').toString('base64'));
  });

  it('scales wide screenshots down', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    const resized = { getSize: () => ({ width: 1280, height: 720 }), toPNG: () => Buffer.from('small') };
    const resize = vi.fn(() => resized);
    guest.capturePage.mockResolvedValue({ getSize: () => ({ width: 2560, height: 1440 }), resize, toPNG: vi.fn() });
    attach(service, guest);
    expect(await service.screenshot()).toBe(Buffer.from('small').toString('base64'));
    expect(resize).toHaveBeenCalledWith({ width: 1280 });
  });

  it('empties the agent page, its history, policy and storage on reset', async () => {
    const clearStorage = vi.fn(async () => {});
    const service = new BrowserService(() => {}, clearStorage);
    const guest = new FakeGuest();
    attach(service, guest);
    await service.open('file:///project/page.html', new AbortController().signal, (url) =>
      url.startsWith('file:///project/'),
    );
    expect(service.allowsRequest('file:///home/me/.ssh/id_rsa')).toBe(false);

    await service.reset();
    expect(guest.loadURL).toHaveBeenLastCalledWith('about:blank');
    expect(guest.navigationHistory.clear).toHaveBeenCalled();
    expect(clearStorage).toHaveBeenCalledTimes(1);
    // The next chat's agent starts without the previous page's policy, on an empty page.
    expect(service.allowsRequest('file:///home/me/.ssh/id_rsa')).toBe(true);
  });

  it('clears the agent storage on reset even before the panel has opened', async () => {
    const clearStorage = vi.fn(async () => {});
    const service = new BrowserService(() => {}, clearStorage);
    await service.reset();
    expect(clearStorage).toHaveBeenCalledTimes(1);
  });

  it('fails when no page is attached in time', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService(() => {});
      const pending = service.screenshot();
      const assertion = expect(pending).rejects.toThrow('The browser panel did not open.');
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a timed-out waiter so a later attach has nothing stale to resolve (#188)', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService(() => {});
      const waiters = (service as unknown as { waiters: unknown[] }).waiters;
      const assertion = expect(service.screenshot()).rejects.toThrow('The browser panel did not open.');
      expect(waiters).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(waiters).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps other pending waiters when one times out', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService(() => {});
      const waiters = (service as unknown as { waiters: unknown[] }).waiters;
      const first = expect(service.screenshot()).rejects.toThrow('The browser panel did not open.');
      await vi.advanceTimersByTimeAsync(3000);
      const guest = new FakeGuest();
      guest.capturePage.mockResolvedValue({ getSize: () => ({ width: 10 }), toPNG: () => Buffer.from('png') });
      const second = service.screenshot();
      expect(waiters).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000);
      await first;
      expect(waiters).toHaveLength(1);
      attach(service, guest);
      expect(await second).toBe(Buffer.from('png').toString('base64'));
      expect(waiters).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
