import { describe, expect, it } from 'vitest';
import { devRendererUrl, isAppPageUrl } from './renderer_url';

describe('devRendererUrl', () => {
  it('uses the dev server URL only in development', () => {
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe('http://localhost:5173');
    expect(devRendererUrl(false, {})).toBeNull();
  });

  it('ignores it in a packaged app', () => {
    expect(devRendererUrl(true, { ELECTRON_RENDERER_URL: 'https://evil.example' })).toBeNull();
  });
});

describe('isAppPageUrl', () => {
  const winPage = 'C:\\Program Files\\Patch\\resources\\app.asar\\out\\renderer\\index.html';
  const winUrl = 'file:///C:/Program%20Files/Patch/resources/app.asar/out/renderer/index.html';
  const linuxPage = '/opt/Patch/resources/app.asar/out/renderer/index.html';
  const win = (url: string) => isAppPageUrl(url, true, {}, winPage, 'win32');
  const linux = (url: string) => isAppPageUrl(url, true, {}, linuxPage, 'linux');

  it('accepts exactly the built app page, with any query or hash', () => {
    expect(win(winUrl)).toBe(true);
    expect(win(`${winUrl}?x=1#top`)).toBe(true);
    expect(win(winUrl.replace('C:/Program%20Files', 'c:/program%20files'))).toBe(true);
    expect(linux(`file://${linuxPage}`)).toBe(true);
  });

  it('rejects another file named renderer/index.html', () => {
    expect(win('file:///C:/Users/me/Downloads/renderer/index.html')).toBe(false);
    expect(linux('file:///home/me/renderer/index.html')).toBe(false);
    expect(linux(`file://${linuxPage.toUpperCase()}`)).toBe(false);
    expect(win('file://server/share/out/renderer/index.html')).toBe(false);
  });

  it('accepts the dev server only in development', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173' };
    expect(isAppPageUrl('http://localhost:5173/', false, env)).toBe(true);
    expect(isAppPageUrl('http://localhost:5173/', true, env)).toBe(false);
  });

  it('rejects other pages, other files and garbage', () => {
    expect(win('https://evil.example/renderer/index.html')).toBe(false);
    expect(win('file:///C:/Users/me/Downloads/evil.html')).toBe(false);
    expect(win('about:blank')).toBe(false);
    expect(win('')).toBe(false);
  });
});
