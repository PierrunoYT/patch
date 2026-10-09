import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@shared/settings';
import { sandboxEnv } from './env';
import {
  buildLaunch,
  detectSandboxSupport,
  launchEnvWith,
  refreshSandboxSupport,
  systemLaunchEnv,
  type SandboxSupport,
} from './sandbox';
import { buildHelperRequest, exceedsEntryLimit } from './sandbox_windows';

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Why a sandboxed server cannot start here, or null when it can.
export function mcpSandboxUnavailable(platform: NodeJS.Platform, support: SandboxSupport): string | null {
  if (platform === 'win32') {
    if (!support.appcontainer)
      return 'This server is set to run sandboxed, but the Windows sandbox helper (sandbox-helper.exe) was not found.';
    return null;
  }
  if (platform !== 'linux')
    return 'Sandboxed MCP servers run only on Linux (bubblewrap) and Windows so far. Remove "sandbox" to run this server with your full rights.';
  if (!support.bwrap)
    return 'This server is set to run sandboxed, but bubblewrap (bwrap) is not installed or cannot create a sandbox here.';
  return null;
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  return out;
}

// The sandbox launch for a stdio server with "sandbox": true (#87), like an agent command's: system folders and
// toolchain caches read-only, the rest of the home folder hidden, no network unless sandboxNetwork. Writable: the
// server's own folder (its HOME and working folder, kept between starts, so npx and uvx caches survive) and, when
// its args or env name ${project}, the open project with its Git metadata read-only. Fails closed: an error, never
// an unsandboxed start. Linux uses bubblewrap; Windows uses sandbox-helper --stdio so JSON-RPC stays on stdin/stdout.
export async function mcpSandboxLaunch(
  config: McpServerConfig,
  command: string,
  hostEnv: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; home?: string; sensitivePaths?: string[] } = {},
): Promise<McpLaunch> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  await refreshSandboxSupport('auto', platform);
  const support = detectSandboxSupport(platform);
  const unavailable = mcpSandboxUnavailable(platform, support);
  if (unavailable) throw new Error(unavailable);
  const state = config.cwd;
  if (!state) throw new Error('A sandboxed MCP server needs its own folder.');
  mkdirSync(state, { recursive: true });
  // The project root and its Git metadata are checked as for a command in that project.
  const project = config.projectAccess
    ? await systemLaunchEnv({
        cwd: config.projectAccess,
        home,
        tmp: platform === 'win32' ? tmpdir() : '/tmp',
        inner: { file: platform === 'win32' ? command : '/bin/sh', args: [] },
        command: '',
        containerName: '',
        image: '',
        sensitivePaths: options.sensitivePaths,
      })
    : null;
  if (platform === 'win32') {
    const helper = support.appcontainer!;
    const childEnv = sandboxEnv(hostEnv, 'win32', state, tmpdir());
    const merged: Record<string, string> = { ...(config.env ?? {}) };
    for (const [key, value] of Object.entries(childEnv)) if (value !== undefined) merged[key] ??= value;
    const request = buildHelperRequest({
      id: 1,
      shell: { file: command, args: config.args ?? [] },
      // Only the working folder becomes a drive the server can walk up from (Node resolves the real path of its script,
      // which fails on a folder whose parents are hidden), so a server that names ${project} starts in the project.
      cwd: project?.cwd ?? state,
      env: merged,
      network: config.sandboxNetwork === true,
      home,
      exists: (path) => existsSync(path),
      gitPaths: project?.gitPaths ?? [],
      writable: project ? [state] : [],
      workspace: true,
      tooLarge: (path) => exceedsEntryLimit(path),
      limits: { timeoutMs: 0 },
    });
    const requestPath = join(state, '.patch-sandbox-request.json');
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
    return { command: helper, args: ['--stdio', requestPath], env: definedEnv(hostEnv) };
  }
  // A program outside the system folders (nvm's node, a cargo binary) would be swapped for bash by the command
  // launcher, so the shell execs it with its own arguments instead.
  const inner = { file: '/bin/sh', args: ['-c', 'exec "$0" "$@"', command, ...(config.args ?? [])] };
  const env = launchEnvWith(
    {
      cwd: state,
      home,
      tmp: '/tmp',
      inner,
      command: '',
      containerName: '',
      image: '',
      writable: project ? [project.cwd] : [],
      homeEnv: state,
    },
    project?.gitPaths ?? [],
  );
  const launch = buildLaunch({ kind: 'bwrap', network: config.sandboxNetwork === true }, env, null, {
    scope: support.scope,
  });
  const launcherEnv = Object.fromEntries(
    (launch.launcherEnv ?? []).flatMap((name) => (hostEnv[name] === undefined ? [] : [[name, hostEnv[name]!]])),
  );
  const base = sandboxEnv(hostEnv, platform, state, '/tmp');
  const merged: Record<string, string> = { ...launcherEnv, ...(config.env ?? {}) };
  for (const [key, value] of Object.entries(base)) if (value !== undefined) merged[key] ??= value;
  return { command: launch.file, args: launch.args, env: merged };
}
