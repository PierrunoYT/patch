import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { appLog } from '../app_log';
import { peDigest } from './pe_digest';

// Digests of the Windows helpers that run outside any sandbox (sandbox-helper.exe, file-helper.exe), taken by
// electron.vite.config.ts from the helpers `npm run build` compiles just before the bundle. Absent in development and
// tests.
declare const __PATCH_NATIVE_DIGESTS__: Record<string, string> | undefined;
const BUILT: Record<string, string> = typeof __PATCH_NATIVE_DIGESTS__ === 'undefined' ? {} : __PATCH_NATIVE_DIGESTS__;

// The last check of each path, reused while its size and times are unchanged: the helper is looked up for every
// command and sandbox probe.
const checked = new Map<string, { key: string; trusted: boolean }>();

// Whether a packaged Windows build may run this bundled helper: its digest must match the one taken when the app was
// built (#149), so a helper replaced in the install folder is refused, and with it every sandboxed command or file
// operation, rather than run them its own way. Signing does not change the digest (pe_digest.ts). This does not stop
// someone who can also replace the app's own code in the same folder; that needs a signed build (#26).
export function trustedHelper(path: string, digests: Record<string, string> = BUILT): boolean {
  const name = win32.basename(path).toLowerCase();
  const expected = digests[name];
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  const key = `${expected}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const known = checked.get(path);
  if (known?.key === key) return known.trusted;
  let actual: string | null = null;
  try {
    actual = peDigest(readFileSync(path));
  } catch {
    // Unreadable: refused below.
  }
  const trusted = Boolean(expected) && actual === expected;
  checked.set(path, { key, trusted });
  if (!trusted)
    appLog.warn('sandbox', 'A bundled helper failed its integrity check and was not run.', {
      name,
      pinned: Boolean(expected),
    });
  return trusted;
}
