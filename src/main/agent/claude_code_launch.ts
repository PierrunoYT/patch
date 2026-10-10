import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fixedSearchPath } from '../exec_search';
import { ANTHROPIC_API_URL } from '../llm/endpoints';

// Finding and starting the user's Claude Code. Patch does not ship Claude Code: the SDK's own copy is about 250 MB
// per platform, and the installed one already has the user's sign-in and settings.

export const CLAUDE_CODE_NOT_FOUND =
  'Claude Code was not found. Install it (https://code.claude.com) and run claude once to sign in, or set its path in Settings → Claude Code.';

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  isFile?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The Claude Code program to run: the path from Settings when one is set, else `claude` from PATH (fixed entries
// only, see exec_search.ts) or the folders its installers use. An app started from the desktop often has a shorter
// PATH than a terminal, hence the install folders. Null when there is none.
export function findClaudeCode(configured: string, options: FindOptions = {}): string | null {
  const exists = options.isFile ?? isFile;
  const platform = options.platform ?? process.platform;
  const { join, isAbsolute } = platform === 'win32' ? win32 : posix;
  if (configured.trim()) {
    const path = configured.trim();
    return isAbsolute(path) && fixedSearchPath(path, platform).path === path && exists(path) ? path : null;
  }
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  // npm's claude.cmd shim on Windows needs a shell to start; the native installer's claude.exe does not.
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  const folders = fixedSearchPath(env[pathKey] ?? '', platform)
    .path.split(separator)
    .filter(Boolean)
    .map((folder) => folder.replace(/^"(.*)"$/, '$1'));
  folders.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'));
  if (platform === 'darwin') folders.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const folder of folders) {
    const candidate = join(folder, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

// The environment Claude Code runs with: the app's own, with Claude Code's non-essential traffic (telemetry, error
// reports, update checks) turned off, as Patch has none. With an API key, Claude Code uses it instead of its own
// sign-in, and a Claude base URL set in Patch goes with it.
export function claudeCodeEnv(
  base: NodeJS.ProcessEnv,
  apiKey: { key: string; baseUrl: string } | null,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey.key;
    // A token or helper set up for Claude Code would win over the key.
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.ANTHROPIC_BASE_URL = apiKey.baseUrl || ANTHROPIC_API_URL;
  }
  return env;
}
