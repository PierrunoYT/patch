import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import type { SandboxMode, SandboxNetwork } from '@shared/settings';
import { isNetworkUrlAllowed } from '../agent/allowed_network_hosts';
import { findHelper } from './sandbox_windows';
import { validateSandboxGit } from './sandbox_git';

// Runs agent commands (run_command, background ones included) with limited rights. The planning code below is pure
// so it can be tested on any platform; only detectSandboxSupport() looks at the machine.

export interface SandboxConfig {
  mode: SandboxMode;
  network: SandboxNetwork;
  // Image for container mode.
  image: string;
  // Newline-separated hostnames (global plus project list) for the "allow-list" network setting.
  allowedHosts: string;
}

export interface SandboxSupport {
  bwrap: boolean;
  seatbelt: boolean;
  // Path of sandbox-helper.exe (Windows AppContainer).
  appcontainer: string | null;
  container: 'docker' | 'podman' | null;
}

// Extra rights one command asked for. Either one makes the approval card ask, even in Auto mode.
export interface CommandAccess {
  network?: boolean;
  unsandboxed?: boolean;
}

export type SandboxKind = 'bwrap' | 'seatbelt' | 'appcontainer' | 'container' | 'none';

export type SandboxDecision =
  { kind: SandboxKind; network: boolean; note?: string } | { kind: 'unavailable'; reason: string };

// Read-only inside the sandbox when they exist: what builds need. Everything else in the home folder is hidden.
// Open binaries/caches, not their credential-bearing parent folders or global Git configuration.
export const HOME_READ_ONLY = [
  '.cargo/bin',
  '.cargo/registry',
  '.cargo/git',
  '.rustup',
  '.nvm',
  '.volta',
  '.bun',
  '.deno',
  '.pyenv',
  '.rbenv',
  '.asdf',
  '.sdkman',
  '.local/bin',
  '.local/share/pnpm',
  '.npm',
  '.cache/pip',
  '.m2/repository',
  '.gradle/caches',
  '.gradle/wrapper',
  'go/pkg/mod',
];

const SYSTEM_READ_ONLY = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/etc',
  '/opt',
  '/nix',
  '/run/systemd/resolve',
];
const SYSTEM_SHELL_DIRS = ['/bin/', '/usr/', '/nix/', '/opt/'];

export function commandUrlsAllowed(command: string, allowedHosts: string): boolean {
  const urls = command.match(/https?:\/\/[^\s'"<>)]+/gi) ?? [];
  return urls.length > 0 && urls.every((url) => isNetworkUrlAllowed(url, allowedHosts));
}

// Whether the sandbox gets network. "allow-list" cannot filter by host (neither bubblewrap, Seatbelt nor a plain
// container can): matching command URLs request unrestricted network access, which must be approved for each run.
// This is a request heuristic, never a host-level network boundary.
export function wantsNetwork(command: string, config: SandboxConfig, access: CommandAccess): boolean {
  if (access.network || config.network === 'on') return true;
  return config.network === 'allow-list' && commandUrlsAllowed(command, config.allowedHosts);
}

export function decideSandbox(
  command: string,
  config: SandboxConfig,
  support: SandboxSupport,
  access: CommandAccess,
  platform: NodeJS.Platform,
): SandboxDecision {
  const network = wantsNetwork(command, config, access);
  if (access.unsandboxed) return { kind: 'none', network: true, note: 'Allowed to run without a sandbox.' };
  if (config.mode === 'off') return { kind: 'none', network: true, note: 'The sandbox is turned off in the settings.' };
  if (config.mode === 'container') {
    if (!support.container) {
      return {
        kind: 'unavailable',
        reason:
          'Sandbox mode is "container" but neither Docker nor Podman is running. Start one, or change the sandbox setting. The command was not run.',
      };
    }
    return { kind: 'container', network };
  }
  if (platform === 'linux' && support.bwrap) return { kind: 'bwrap', network };
  if (platform === 'darwin' && support.seatbelt) return { kind: 'seatbelt', network };
  if (platform === 'win32' && support.appcontainer) return { kind: 'appcontainer', network };
  const why =
    platform === 'linux'
      ? 'bubblewrap (bwrap) is not installed or cannot create a sandbox here'
      : platform === 'darwin'
        ? 'sandbox-exec is not available'
        : 'the Windows sandbox helper (sandbox-helper.exe) was not found';
  return {
    kind: 'unavailable',
    reason: `Sandbox unavailable: ${why}. Choose "container" mode to use Docker or Podman, or request unsandboxed access for this command. The command was not run.`,
  };
}

export interface LaunchEnv {
  cwd: string;
  home: string;
  tmp: string;
  // The shell and arguments that run the command outside a sandbox.
  inner: { file: string; args: string[] };
  command: string;
  exists: (path: string) => boolean;
  uid?: number;
  gid?: number;
  // Unique container name, so it can be removed when the command is stopped.
  containerName: string;
  image: string;
}

export interface Launch {
  file: string;
  args: string[];
  // Extra work needed to stop it (a container outlives its client process).
  stop?: { file: string; args: string[] };
}

function systemShell(inner: LaunchEnv['inner']): { file: string; args: string[] } {
  if (SYSTEM_SHELL_DIRS.some((dir) => inner.file.startsWith(dir))) return inner;
  // A shell in the home folder would be hidden in the sandbox.
  return { file: '/bin/bash', args: inner.args };
}

export function bwrapArgs(env: LaunchEnv, network: boolean): string[] {
  const { cwd, home, exists } = env;
  const shell = systemShell(env.inner);
  const args = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (network) args.push('--share-net');
  for (const dir of SYSTEM_READ_ONLY) if (exists(dir)) args.push('--ro-bind', dir, dir);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', home);
  for (const rel of HOME_READ_ONLY) {
    const path = `${home}/${rel}`;
    if (exists(path)) args.push('--ro-bind', path, path);
  }
  args.push('--bind', cwd, cwd);
  // Mount the directory itself: protecting leaves would allow absent control files and directory replacement.
  if (!exists(`${cwd}/.git`))
    throw new Error('Sandbox requires an existing .git directory. Request unsandboxed access.');
  args.push('--ro-bind', `${cwd}/.git`, `${cwd}/.git`);
  args.push('--setenv', 'HOME', home, '--setenv', 'TMPDIR', '/tmp', '--chdir', cwd, '--', shell.file, ...shell.args);
  return args;
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(env: Pick<LaunchEnv, 'cwd' | 'home' | 'tmp' | 'exists'>, network: boolean): string {
  const subpath = (path: string) => `(subpath ${sbplString(path)})`;
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow pseudo-tty)',
    // Later rules win: read everything, hide the home folder, then open the folders builds need.
    '(allow file-read*)',
    `(deny file-read* ${subpath(env.home)})`,
    '(allow file-read-metadata)',
  ];
  const open = [env.cwd, ...HOME_READ_ONLY.map((rel) => `${env.home}/${rel}`).filter((path) => env.exists(path))];
  lines.push(`(allow file-read* ${open.map(subpath).join(' ')})`);
  const writable = new Set([env.cwd, env.tmp, '/tmp', '/private/tmp', '/private/var/folders']);
  lines.push(
    `(allow file-write* ${[...writable].map(subpath).join(' ')} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))`,
  );
  lines.push(`(deny file-write* ${subpath(`${env.cwd}/.git`)})`);
  // A project in a writable temp tree must not move out from under the pathname-based deny rule.
  for (let path = env.cwd; path !== '/'; path = posix.dirname(path)) {
    lines.push(`(deny file-write-unlink (literal ${sbplString(path)}))`);
  }
  if (network) lines.push('(allow network*)');
  return lines.join('\n');
}

export function containerArgs(
  engine: 'docker' | 'podman',
  env: LaunchEnv,
  network: boolean,
): { args: string[]; stop: Launch['stop'] } {
  if (env.cwd.includes(','))
    throw new Error(
      'Container sandbox cannot protect Git metadata in a path containing commas. Request unsandboxed access.',
    );
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    env.containerName,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=1024',
  ];
  if (!network) args.push('--network', 'none');
  if (env.uid !== undefined && env.gid !== undefined) {
    // Files the command creates in the project belong to the user, not to root.
    args.push(engine === 'podman' ? '--userns=keep-id' : `--user=${env.uid}:${env.gid}`);
  }
  args.push('-v', `${env.cwd}:/workspace`);
  if (!env.exists(`${env.cwd}/.git`))
    throw new Error('Sandbox requires an existing .git directory. Request unsandboxed access.');
  // --mount fails if the source disappears, instead of creating a host directory as -v would.
  args.push('--mount', `type=bind,src=${env.cwd}/.git,dst=/workspace/.git,readonly`);
  args.push(
    '-w',
    '/workspace',
    '-e',
    'HOME=/tmp',
    '-e',
    'CI=1',
    '-e',
    'FORCE_COLOR=0',
    '-e',
    'NO_COLOR=1',
    env.image,
    '/bin/sh',
    '-c',
    env.command,
  );
  return { args, stop: { file: engine, args: ['rm', '-f', env.containerName] } };
}

export function buildLaunch(
  decision: Exclude<SandboxDecision, { kind: 'unavailable' }>,
  env: LaunchEnv,
  engine: SandboxSupport['container'],
): Launch {
  switch (decision.kind) {
    case 'bwrap':
      return { file: 'bwrap', args: bwrapArgs(env, decision.network) };
    case 'seatbelt':
      return {
        file: '/usr/bin/sandbox-exec',
        args: ['-p', seatbeltProfile(env, decision.network), env.inner.file, ...env.inner.args],
      };
    case 'container': {
      const { args, stop } = containerArgs(engine ?? 'docker', env, decision.network);
      return { file: engine ?? 'docker', args, stop };
    }
    case 'appcontainer':
      // Needs the helper protocol (sandbox_windows.ts); falling through would run the command unsandboxed.
      throw new Error('The AppContainer sandbox does not use a launch command line.');
    default:
      return { file: env.inner.file, args: env.inner.args };
  }
}

// One line for the approval card and the command result.
export function describeSandbox(decision: SandboxDecision, access: CommandAccess = {}): string {
  if (decision.kind === 'unavailable') return `Cannot run: ${decision.reason}`;
  if (decision.kind === 'none') return decision.note ?? 'Not sandboxed.';
  const where = {
    bwrap: 'Sandboxed (bubblewrap)',
    seatbelt: 'Sandboxed (Seatbelt)',
    appcontainer: 'Sandboxed (AppContainer)',
    container: 'Sandboxed (container)',
  }[decision.kind];
  const net = decision.network
    ? access.network
      ? 'unrestricted network allowed for this command'
      : 'unrestricted network on (not filtered by hostname)'
    : 'no network';
  return `${where}: project files are writable but Git metadata is read-only; use the Git panel or explicitly approved unsandboxed access for Git writes. The rest of your home folder is hidden, ${net}.`;
}

let cached: { at: number; support: SandboxSupport } | null = null;
const CACHE_MS = 30_000;

function succeeds(file: string, args: string[]): boolean {
  try {
    return spawnSync(file, args, { stdio: 'ignore', timeout: 8000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

// Looks for the sandbox programs on this machine. Cached briefly: starting Docker later should be noticed.
export function detectSandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.support;
  const support: SandboxSupport = {
    bwrap: platform === 'linux' && succeeds('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true']),
    seatbelt: platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
    appcontainer: platform === 'win32' ? findHelper() : null,
    container: succeeds('docker', ['version', '--format', '{{.Server.Version}}'])
      ? 'docker'
      : succeeds('podman', ['version'])
        ? 'podman'
        : null,
  };
  cached = { at: Date.now(), support };
  return support;
}

export function resetSandboxSupportCache(): void {
  cached = null;
}

export function systemLaunchEnv(
  base: Omit<LaunchEnv, 'exists' | 'uid' | 'gid' | 'home' | 'tmp'> & { home: string; tmp: string },
): LaunchEnv {
  validateSandboxGit(base.cwd);
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return {
    ...base,
    cwd: real(base.cwd),
    home: real(base.home),
    tmp: real(base.tmp),
    exists: (path) => existsSync(path),
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  };
}
