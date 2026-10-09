import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// The built app page on disk, loaded when there is no dev server.
export const APP_PAGE_PATH = join(__dirname, '../renderer/index.html');

// The dev server URL to load the app page from, or null to load the built page from disk. electron-vite sets
// ELECTRON_RENDERER_URL during `npm run dev`. A packaged app ignores it: anyone who could set it when starting Patch
// would otherwise get a remote page loaded with the app's preload and its full IPC access.
export function devRendererUrl(isPackaged: boolean, env: NodeJS.ProcessEnv): string | null {
  if (isPackaged) return null;
  return env.ELECTRON_RENDERER_URL || null;
}

// Whether a frame URL is the app page: exactly the built page at `appPage` (query and hash aside), or the dev server
// in development. IPC handlers only answer calls from it, so a future iframe, second window or wrongly loaded page
// cannot use them, nor can another file named renderer/index.html.
export function isAppPageUrl(
  url: string,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv,
  appPage = APP_PAGE_PATH,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const dev = devRendererUrl(isPackaged, env);
  if (dev && url.startsWith(dev)) return true;
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
    parsed.search = '';
    parsed.hash = '';
    path = fileURLToPath(parsed, { windows: platform === 'win32' });
  } catch {
    return false;
  }
  const comparable = (value: string) => {
    const normalized = platform === 'win32' ? win32.normalize(value) : posix.normalize(value);
    return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
  };
  return comparable(path) === comparable(appPage);
}
