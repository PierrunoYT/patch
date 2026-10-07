import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { posix, relative } from 'node:path';
import type { SandboxMode, SandboxNetwork } from '@shared/settings';
import { isNetworkUrlAllowed } from '../agent/allowed_network_hosts';
import { findHelper } from './sandbox_windows';
import { validateSandboxGit } from './sandbox_git';

// Runs agent commands (run_command, background ones included) with limited rights. The planning code below is pure
// so it can be tested on any platform; only refreshSandboxSupport() and detectSandboxSupport() look at the machine.

export interface SandboxConfig {
  mode: SandboxMode;
  network: SandboxNetwork;
  // Image for container mode.
  image: string;
  // Newline-separated hostnames (global plus project list) for the "allow-list" network setting.
  allowedHosts: string;
  // Native-confirmed global settings only; never supplied by a command or project.
  envAllowList?: string;
  path?: string;
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
  if (access.unsandboxed)
    return {
      kind: 'none',
      network: true,
      note: 'Allowed to run without a sandbox: no filesystem confinement and unrestricted network access.',
    };
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
  // Validated top-level Git pointers and metadata directories, or an empty reservation for non-Git projects.
  gitPaths: string[];
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
  for (const path of env.gitPaths) args.push('--ro-bind', path, path);
  args.push('--setenv', 'HOME', home, '--setenv', 'TMPDIR', '/tmp', '--chdir', cwd, '--', shell.file, ...shell.args);
  return args;
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(
  env: Pick<LaunchEnv, 'cwd' | 'home' | 'tmp' | 'exists' | 'gitPaths'>,
  network: boolean,
): string {
  const subpath = (path: string) => `(subpath ${sbplString(path)})`;
  // CLI user/group lookup only. Network grants never admit application-launch or URL-session daemons.
  const services = ['com.apple.system.opendirectoryd.libinfo'];
  if (network) {
    services.push(
      'com.apple.SystemConfiguration.DNSConfiguration',
      'com.apple.SystemConfiguration.configd',
      'com.apple.networkd',
      'com.apple.ocspd',
      'com.apple.trustd.agent',
      'com.apple.TrustEvaluationAgent',
    );
  }
  // The CLI runtime baseline from Codex 79cae5f7 (seatbelt_base_policy.sbpl), plus kern.boottime (Node's os.uptime),
  // Rosetta and OS-compat version checks, and every hw.optional CPU feature flag (Intel included). Seatbelt does not
  // filter kern.proc reads by these names (macOS CI read a host process without them), so the sandbox cannot hide
  // other processes; the prefixes stay for parity with Codex.
  const sysctls = [
    'hw.activecpu',
    'hw.busfrequency_compat',
    'hw.byteorder',
    'hw.cacheconfig',
    'hw.cachelinesize_compat',
    'hw.cpufamily',
    'hw.cpufrequency_compat',
    'hw.cputype',
    'hw.l1dcachesize_compat',
    'hw.l1icachesize_compat',
    'hw.l2cachesize_compat',
    'hw.l3cachesize_compat',
    'hw.logicalcpu_max',
    'hw.machine',
    'hw.model',
    'hw.memsize',
    'hw.ncpu',
    'hw.nperflevels',
    'hw.packages',
    'hw.pagesize_compat',
    'hw.pagesize',
    'hw.physicalcpu',
    'hw.physicalcpu_max',
    'hw.logicalcpu',
    'hw.cpufrequency',
    'hw.tbfrequency_compat',
    'hw.vectorunit',
    'machdep.cpu.brand_string',
    'kern.argmax',
    'kern.boottime',
    'kern.hostname',
    'kern.maxfilesperproc',
    'kern.maxproc',
    'kern.osproductversion',
    'kern.osproductversioncompat',
    'kern.osrelease',
    'kern.ostype',
    'kern.osvariant_status',
    'kern.osversion',
    'kern.secure_kernel',
    'kern.sysv.semmns',
    'kern.usrstack64',
    'kern.version',
    'sysctl.proc_cputype',
    'sysctl.proc_translated',
    'vm.loadavg',
  ];
  const sysctlPrefixes = ['hw.optional.', 'hw.perflevel', 'kern.proc.pgrp.', 'kern.proc.pid.', 'net.routetable.'];
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    // Directly executed toolchain processes inherit the profile; service-mediated launches do not.
    '(allow process-exec)',
    '(allow signal (target self))',
    `(allow sysctl-read ${[
      ...sysctls.map((name) => `(sysctl-name ${sbplString(name)})`),
      ...sysctlPrefixes.map((name) => `(sysctl-name-prefix ${sbplString(name)})`),
    ].join(' ')})`,
    `(allow mach-lookup ${services.map((name) => `(global-name ${sbplString(name)})`).join(' ')})`,
    // Python multiprocessing locks need named semaphores. Shared memory stays denied except libomp's registration
    // names (PyTorch); a broader grant would let a command open host processes' segments by name.
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))',
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
  lines.push(`(deny file-write* ${env.gitPaths.map(subpath).join(' ')})`);
  // A project in a writable temp tree must not move out from under the pathname-based deny rule.
  for (let path = env.cwd; path !== '/'; path = posix.dirname(path)) {
    lines.push(`(deny file-write-unlink (literal ${sbplString(path)}))`);
  }
  if (network) lines.push('(allow network*)');
  // Keep service-mediated launches and arbitrary XPC lookups denied even if a later grant is broadened.
  lines.push(
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb"))',
    '(deny mach-lookup (xpc-service-name-prefix ""))',
  );
  return lines.join('\n');
}

export function containerArgs(
  engine: 'docker' | 'podman',
  env: LaunchEnv,
  network: boolean,
): { args: string[]; stop: Launch['stop'] } {
  if ([env.cwd, ...env.gitPaths].some((path) => path.includes(',')))
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
  // --mount fails if the source disappears, instead of creating a host directory as -v would.
  for (const path of env.gitPaths)
    args.push(
      '--mount',
      `type=bind,src=${path},dst=/workspace/${relative(env.cwd, path).replaceAll('\\', '/')},readonly`,
    );
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

const CACHE_MS = 30_000;
const BWRAP_PROBE: [string, string[]] = ['bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true']];
const DOCKER_PROBE: [string, string[]] = ['docker', ['version', '--format', '{{.Server.Version}}']];
const PODMAN_PROBE: [string, string[]] = ['podman', ['version']];

// Program probes run asynchronously: a hung Docker CLI must not freeze the main process (#112). `value` keeps the
// last finished result while a refresh runs, and stays undefined until the first probe finishes.
const probes = new Map<string, { at: number; result: Promise<boolean>; value?: boolean }>();

function probe([file, args]: [string, string[]]): Promise<boolean> {
  const key = [file, ...args].join(' ');
  const cached = probes.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  const entry: { at: number; result: Promise<boolean>; value?: boolean } = {
    at: Date.now(),
    result: new Promise((resolve) => {
      try {
        execFile(file, args, { timeout: 8000, windowsHide: true }, (error) => resolve(!error));
      } catch {
        resolve(false);
      }
    }),
    value: cached?.value,
  };
  void entry.result.then((ok) => (entry.value = ok));
  probes.set(key, entry);
  return entry.result;
}

function known(program: [string, string[]]): boolean {
  return probes.get([program[0], ...program[1]].join(' '))?.value ?? false;
}

// Runs the probes a sandbox mode needs: bwrap for "auto" on Linux, Docker and Podman only for "container".
// Cached briefly: starting Docker later should be noticed.
export async function refreshSandboxSupport(
  mode: SandboxMode,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (mode === 'auto' && platform === 'linux') await probe(BWRAP_PROBE);
  if (mode === 'container' && !(await probe(DOCKER_PROBE))) await probe(PODMAN_PROBE);
}

// What this machine supports, from the last finished probes. Never blocks: call refreshSandboxSupport first.
export function detectSandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
  return {
    bwrap: platform === 'linux' && known(BWRAP_PROBE),
    seatbelt: platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
    appcontainer: platform === 'win32' ? findHelper() : null,
    container: known(DOCKER_PROBE) ? 'docker' : known(PODMAN_PROBE) ? 'podman' : null,
  };
}

// Probes every sandbox program, for tests that pick their cases from what the machine has.
export async function probeSandboxSupport(platform: NodeJS.Platform = process.platform): Promise<SandboxSupport> {
  await Promise.all([refreshSandboxSupport('auto', platform), refreshSandboxSupport('container', platform)]);
  return detectSandboxSupport(platform);
}

export function resetSandboxSupportCache(): void {
  probes.clear();
}

export function systemLaunchEnv(
  base: Omit<LaunchEnv, 'exists' | 'gitPaths' | 'uid' | 'gid' | 'home' | 'tmp'> & { home: string; tmp: string },
): LaunchEnv {
  const gitPaths = validateSandboxGit(base.cwd);
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
    gitPaths,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  };
}
