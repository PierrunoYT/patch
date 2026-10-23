import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { appLog } from '../app_log';
import { sandboxEnv, scrubEnv } from './env';
import { startFilteringProxy, type FilteringProxy } from './net_proxy';
import { redactSecrets } from './redact';
import {
  buildLaunch,
  decideSandbox,
  describeSandbox,
  detectSandboxSupport,
  refreshSandboxSupport,
  systemLaunchEnv,
  wantsNetwork,
  type CommandAccess,
  type Launch,
  type SandboxConfig,
  type SandboxDecision,
  type SandboxKind,
  type SandboxSupport,
} from './sandbox';
import {
  MAX_GRANT_PATHS,
  describeGrants,
  emptyGrants,
  grantsKey,
  hasPathGrants,
  hasResolvedGrants,
  resolvePathGrants,
  type PathGrants,
} from './sandbox_grants';
import { AddedEntries } from './added_entries';
import { patchWriteMark, protectedConfigSnapshot, settleCreatedProtectedEntries } from './sandbox_config';
import {
  settleChangedSubmoduleGit,
  submodulePaths,
  submoduleSnapshot,
  type SubmoduleSnapshot,
} from './sandbox_submodules';
import {
  buildHelperRequest,
  GRANT_ENTRY_LIMIT,
  HelperProcess,
  measureEntryLimit,
  withEntryLimits,
} from './sandbox_windows';
import { killWindowsLeftovers } from './shell_leftovers';
import { defineTool, truncateOutput } from './types';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_BUFFERED_CHARS = 1_000_000;
const EXIT_DRAIN_MS = 500;
// Finished background commands whose output was never fully read are kept for a later command_output, newest first.
const MAX_FINISHED_BACKGROUND = 5;
const SHARED_OWNER = '';

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  // Where the command ran; absent when it never started.
  sandbox?: SandboxKind;
}

// What the runner needs from a running command: a ChildProcess, or a command running through the Windows helper.
export interface CommandProcess extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  exitCode: number | null;
  // Set instead of exitCode when a signal ended the process.
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

interface BackgroundCommand {
  // Numbered per owner (1, 2, ...), as the owning chat sees it.
  id: number;
  // Unique across the runner.
  key: number;
  // The chat that started it (see ToolContext.chatId).
  owner: string;
  command: string;
  process: CommandProcess;
  output: string;
  // The part of `output` no tool result has carried yet. A poll returns only this, so a command that is checked
  // several times does not put its whole output into the conversation again each time.
  unread: string;
  exitCode: number | null | undefined;
  detachAbort: () => void;
}

// The output that arrived since the last call, which it marks as read.
function takeUnread(entry: BackgroundCommand): string {
  const text = entry.unread;
  entry.unread = '';
  return text;
}

// The shell the agent's commands run in. Named in the system prompt so the model writes matching syntax.
export function shellName(containerMode = false): string {
  if (containerMode) return 'sh in a Linux container; the project is mounted at /workspace';
  return process.platform === 'win32' ? 'PowerShell' : process.env.SHELL?.split('/').pop() || 'bash';
}

function shellCommand(command: string, sandboxed = false): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // UTF-8 output so non-ASCII text survives.
    let prelude = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
    // AppContainer module discovery can fail even when built-in manifests are readable and import directly.
    // Use the installation path, never a module name that could resolve to a project or user-supplied module.
    if (sandboxed)
      prelude += ['Management', 'Utility']
        .map(
          (name) =>
            `Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.${name}\\Microsoft.PowerShell.${name}.psd1" -ErrorAction Stop;`,
        )
        .join('');
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        // Sandboxed script authorization can fail on inaccessible host ancestors (e.g. npm.ps1).
        // This applies only to this shell process; AppContainer still controls all file/network access.
        ...(sandboxed ? ['-ExecutionPolicy', 'Bypass'] : []),
        '-Command',
        prelude + command,
      ],
    };
  }
  // Native sandbox commands must not load login profiles that can restore host environment values.
  return { file: process.env.SHELL || '/bin/bash', args: [sandboxed ? '-c' : '-lc', command] };
}

// Runs agent commands in the project directory. Each command gets a fresh shell, so `cd` does not persist.
export class ShellRunner {
  private readonly background = new Map<number, BackgroundCommand>();
  private nextKey = 1;
  // Windows: entries added to the project since the last sandboxed command (#140).
  private readonly added = new AddedEntries();
  private readonly nextIds = new Map<string, number>();
  // Sandboxed commands that have started and not yet ended (#262).
  private sandboxedRunning = 0;

  constructor(
    private readonly cwd: () => string,
    private readonly sandbox: () => SandboxConfig = () => ({ mode: 'off', network: 'on', image: '', allowedHosts: '' }),
    private readonly detect: () => SandboxSupport = detectSandboxSupport,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
    private readonly sensitivePaths: () => string[] = () => [],
  ) {}

  // URL matching cannot constrain the connections a program makes. Treat it as a request for full network access,
  // except where the network is filtered by host (#97): then the boundary holds without asking.
  mustAsk(command: string, access: CommandAccess): boolean {
    // New path grants always ask, in Auto mode and under allow rules too (#126).
    if (access.network || access.unsandboxed || hasPathGrants(access)) return true;
    const config = this.sandbox();
    if (config.mode === 'off' || config.network !== 'allow-list') return false;
    const decision = this.decide(command, access);
    return !('filtered' in decision && decision.filtered) && wantsNetwork(command, config, access);
  }

  // Runs the sandbox probes this command's decision needs, off the main thread's critical path (#112). describe,
  // run and startBackground read the results; run awaits this itself.
  async prepare(access: CommandAccess = {}): Promise<void> {
    const config = this.sandbox();
    // An injected detector (tests) already knows its answer.
    if (config.mode === 'off' || access.unsandboxed || this.detect !== detectSandboxSupport) return;
    await refreshSandboxSupport(config.mode);
  }

  // What would happen to this command: shown on the approval card and in the result.
  describe(command: string, access: CommandAccess = {}): { sandboxed: boolean; text: string } {
    const decision = this.decide(command, access);
    return {
      sandboxed: decision.kind !== 'none' && decision.kind !== 'unavailable',
      text: describeSandbox(decision, access),
    };
  }

  // The canonical grants a command's read_paths and write_paths name right now. Throws, naming the entry, when one
  // cannot be granted. The approval card and the command's start both use this function.
  async resolveGrants(access: CommandAccess): Promise<PathGrants> {
    if (!hasPathGrants(access)) return emptyGrants();
    const env = await systemLaunchEnv({
      cwd: this.cwd(),
      home: homedir(),
      tmp: tmpdir(),
      inner: { file: '', args: [] },
      command: '',
      containerName: '',
      image: '',
      sensitivePaths: this.sensitivePaths(),
    });
    return resolvePathGrants(access, {
      cwd: env.cwd,
      home: homedir(),
      protectedPaths: env.protectedPaths,
      sensitivePaths: this.sensitivePaths(),
    });
  }

  // Resolves the grants again at start and refuses when they are not what the user approved (a link or junction that
  // was replaced, a path that disappeared).
  private async approvedGrants(access: CommandAccess): Promise<PathGrants> {
    const grants = await this.resolveGrants(access);
    if (access.approvedGrants !== undefined && access.approvedGrants !== grantsKey(grants))
      throw new Error(
        'The paths granted to this command resolve differently than when you approved them, so it was not run. Ask again.',
      );
    return grants;
  }

  private decide(command: string, access: CommandAccess): SandboxDecision {
    const config = this.sandbox();
    const support =
      config.mode === 'off' || access.unsandboxed
        ? { bwrap: false, seatbelt: false, appcontainer: null, container: null }
        : this.detect();
    return decideSandbox(command, config, support, access, process.platform);
  }

  async run(
    command: string,
    {
      timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
      signal,
      onOutput,
      access = {},
    }: {
      timeoutSeconds?: number;
      signal?: AbortSignal;
      onOutput?: (text: string) => void;
      access?: CommandAccess;
    } = {},
  ): Promise<CommandResult> {
    await this.prepare(access);
    const stopped: CommandResult = { exitCode: null, output: '', timedOut: false, aborted: true };
    // A stop that came in before the command could start: an abort listener added now would never fire.
    if (signal?.aborted) return stopped;
    let child: CommandProcess;
    let sandbox: SandboxKind;
    let guard: () => string;
    try {
      ({ child, sandbox, guard } = await this.spawn(command, access, signal));
    } catch (error) {
      if (signal?.aborted) return stopped;
      return { exitCode: null, output: (error as Error).message, timedOut: false, aborted: false };
    }
    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      let aborted = false;

      const collect = (text: string) => {
        output = (output + text).slice(-MAX_BUFFERED_CHARS);
        onOutput?.(text);
      };
      child.stdout?.setEncoding('utf8').on('data', collect);
      child.stderr?.setEncoding('utf8').on('data', collect);

      const timer = setTimeout(
        () => {
          timedOut = true;
          killTree(child);
        },
        Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000,
      );
      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      // A stop between the launch and the listener above.
      if (signal?.aborted) onAbort();

      let finished = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        signal?.removeEventListener('abort', onAbort);
        killLeftovers(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        output += guard();
        resolve({ exitCode, output, timedOut, aborted, sandbox });
      };
      child.on('error', (error) => {
        output += `\n${error.message}`;
        finish(null);
      });
      // 'close' waits for the output pipes, which a leftover child (a test worker, a dev server the command started)
      // can hold open long after the command itself ended. Give the pipes a moment to drain, then stop waiting.
      child.on('exit', (code) => (drainTimer = setTimeout(() => finish(code), EXIT_DRAIN_MS)));
      child.on('close', (code) => finish(code));
    });
  }

  async startBackground(
    command: string,
    signal?: AbortSignal,
    access: CommandAccess = {},
    owner: string = SHARED_OWNER,
  ): Promise<BackgroundCommand> {
    signal?.throwIfAborted();
    const { child, guard } = await this.spawn(command, access, signal);
    const onAbort = () => this.stopBackground(entry.id, owner);
    const id = this.nextIds.get(owner) ?? 1;
    this.nextIds.set(owner, id + 1);
    const entry: BackgroundCommand = {
      id,
      key: this.nextKey++,
      owner,
      command,
      process: child,
      output: '',
      unread: '',
      exitCode: undefined,
      detachAbort: () => signal?.removeEventListener('abort', onAbort),
    };
    const append = (text: string) => {
      entry.output = (entry.output + text).slice(-MAX_BUFFERED_CHARS);
      entry.unread = (entry.unread + text).slice(-MAX_BUFFERED_CHARS);
    };
    child.stdout?.setEncoding('utf8').on('data', append);
    child.stderr?.setEncoding('utf8').on('data', append);
    child.on('close', (code) => {
      append(guard());
      entry.exitCode = code;
      entry.detachAbort();
      this.pruneFinished(owner);
    });
    child.on('error', (error) => {
      append(`\n${error.message}`);
      append(guard());
      entry.exitCode = null;
      entry.detachAbort();
      this.pruneFinished(owner);
    });
    this.background.set(entry.key, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort during spawning must not leave an untracked command alive.
    if (signal?.aborted) onAbort();
    return entry;
  }

  getBackground(id: number, owner: string = SHARED_OWNER): BackgroundCommand | undefined {
    for (const entry of this.background.values()) if (entry.owner === owner && entry.id === id) return entry;
    return undefined;
  }

  stopBackground(id: number, owner: string = SHARED_OWNER): boolean {
    const entry = this.getBackground(id, owner);
    if (!entry) return false;
    entry.detachAbort();
    if (entry.exitCode === undefined) killTree(entry.process);
    else killLeftovers(entry.process);
    this.background.delete(entry.key);
    return true;
  }

  // Drops a command that has ended and whose output has been read: its buffers are no longer needed.
  releaseIfRead(entry: BackgroundCommand): void {
    if (entry.exitCode !== undefined && entry.unread === '') this.stopBackground(entry.id, entry.owner);
  }

  // Keeps only the newest finished commands of a chat whose output was never read to the end.
  private pruneFinished(owner: string): void {
    const finished = [...this.background.values()].filter((e) => e.owner === owner && e.exitCode !== undefined);
    for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_BACKGROUND)))
      this.stopBackground(entry.id, owner);
  }

  // Called on Stop, when a chat/project closes, or when the app quits.
  stopAll(): void {
    for (const entry of [...this.background.values()]) this.stopBackground(entry.id, entry.owner);
  }

  // Starts a command and, when it is sandboxed, notes which protected entries the project lacks. A sandbox cannot
  // guard a path that does not exist yet, so `guard` (called once the command ended) finds what the command created
  // there and moves it aside, or only reports it while another sandboxed command is still running (#262), or when
  // Patch's own edit tools wrote to it meanwhile (#276). It also records each submodule's .git and moves aside one the
  // command created or changed, which host Git would recurse into (#294).
  private async spawn(
    command: string,
    access: CommandAccess,
    signal?: AbortSignal,
  ): Promise<{ child: CommandProcess; sandbox: SandboxKind; guard: () => string }> {
    let root = '';
    let before = new Set<string>();
    let submodules: SubmoduleSnapshot | null = null;
    let mark = 0;
    let counted = false;
    let done = false;
    const begin = (submodulePaths: string[]) => {
      root = this.cwd();
      before = protectedConfigSnapshot(root);
      submodules = submoduleSnapshot(root, submodulePaths);
      mark = patchWriteMark();
      this.sandboxedRunning++;
      counted = true;
    };
    const release = () => {
      if (counted && !done) this.sandboxedRunning--;
      done = true;
    };
    const guard = () => {
      if (done) return '';
      release();
      const settled = this.sandboxedRunning === 0;
      return (
        settleCreatedProtectedEntries(root, before, mark, settled) + settleChangedSubmoduleGit(submodules, settled)
      );
    };
    try {
      const started = await this.spawnProcess(command, access, begin, signal);
      if (started.sandbox === 'none') {
        release();
        return { ...started, guard: () => '' };
      }
      return { ...started, guard };
    } catch (error) {
      release();
      throw error;
    }
  }

  // Throws when the sandbox the user chose is not available: the command must not run unsandboxed then. The Git
  // metadata check is awaited before anything starts; a stop that arrives during it throws instead of starting.
  private async spawnProcess(
    command: string,
    access: CommandAccess,
    begin: (submodulePaths: string[]) => void,
    signal?: AbortSignal,
  ): Promise<{ child: CommandProcess; sandbox: SandboxKind }> {
    const decision = this.decide(command, access);
    if (decision.kind === 'unavailable') {
      appLog.warn('sandbox', 'The chosen sandbox is not available.', { mode: this.sandbox().mode });
      throw new Error(decision.reason);
    }
    const config = this.sandbox();
    const inner = shellCommand(command, decision.kind !== 'none');
    const grants = await this.approvedGrants(access);
    const submodules = decision.kind === 'none' ? [] : await submodulePaths(this.cwd());
    signal?.throwIfAborted();
    if (decision.kind !== 'none') begin(submodules);
    if (decision.kind === 'appcontainer')
      return {
        child: await this.spawnInAppContainer(inner, decision.network, decision.filtered === true, grants, signal),
        sandbox: decision.kind,
      };
    let launch: Launch;
    let commandTemp: string | undefined;
    let proxy: FilteringProxy | undefined;
    if (decision.kind === 'none') launch = { file: inner.file, args: inner.args };
    else {
      const env = await systemLaunchEnv({
        cwd: this.cwd(),
        home: homedir(),
        tmp: tmpdir(),
        inner: decision.kind === 'container' ? { file: '/bin/sh', args: ['-c', command] } : inner,
        command,
        containerName: `patch-${randomBytes(6).toString('hex')}`,
        image: config.image,
        sensitivePaths: this.sensitivePaths(),
      });
      signal?.throwIfAborted();
      env.grants = grants;
      if (decision.kind === 'seatbelt') {
        commandTemp = mkdtempSync(join(env.cwd, '.patch-command-tmp-'));
        env.tmp = commandTemp;
      }
      const support = this.detect();
      if (decision.filtered) {
        // A proxy that cannot start leaves the command without any network; it is not run unfiltered instead.
        proxy = await startFilteringProxy({ allowedHosts: config.allowedHosts });
        env.proxy = { socket: proxy.socketPath, bridge: support.netBridge! };
        if (signal?.aborted) {
          await proxy.close();
          signal.throwIfAborted();
        }
      }
      launch = buildLaunch(decision, env, support.container, { scope: support.scope });
      // The limits are not a security boundary, so a missing systemd user manager does not stop the command (#104).
      if (decision.kind === 'bwrap' && !support.scope)
        appLog.warn('sandbox', 'Process and memory limits were not applied: no systemd user scope.');
    }
    appLog.info('sandbox', 'Command started.', {
      kind: decision.kind,
      network: decision.kind === 'none' ? true : decision.network,
      readGrants: grants.read.length,
      writeGrants: grants.write.length,
    });
    const launcherEnv = Object.fromEntries(
      (launch.launcherEnv ?? []).flatMap((name) => {
        const value = this.env()[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const child = spawn(launch.file, launch.args, {
      cwd: this.cwd(),
      env: {
        ...(decision.kind === 'bwrap' || decision.kind === 'seatbelt'
          ? sandboxEnv(
              this.env(),
              process.platform,
              homedir(),
              decision.kind === 'bwrap' ? '/tmp' : commandTemp!,
              config,
            )
          : scrubEnv(this.env())),
        ...launcherEnv,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== 'win32',
    });
    if (commandTemp)
      child.once('close', () => {
        try {
          rmSync(commandTemp, { recursive: true, force: true });
        } catch {
          appLog.warn('sandbox', 'Could not remove the command temporary directory.');
        }
      });
    if (proxy) {
      const filtering = proxy;
      child.once('close', () => void filtering.close());
      child.once('error', () => void filtering.close());
    }
    if (launch.stop) stoppers.set(child, launch.stop);
    child.once('spawn', () => spawned.add(child));
    const lifetime: Lifetime = { startedAt: Date.now() };
    lifetimes.set(child, lifetime);
    child.once('exit', () => (lifetime.endedAt = Date.now()));
    return { child, sandbox: decision.kind };
  }

  private async spawnInAppContainer(
    inner: { file: string; args: string[] },
    network: boolean,
    filtered: boolean,
    grants: PathGrants,
    signal?: AbortSignal,
  ): Promise<CommandProcess> {
    const helper = this.detect().appcontainer;
    if (!helper)
      throw new Error('The Windows sandbox helper (sandbox-helper.exe) was not found. The command was not run.');
    const launchEnv = await systemLaunchEnv({
      cwd: this.cwd(),
      home: homedir(),
      tmp: tmpdir(),
      inner,
      command: '',
      containerName: '',
      image: '',
      sensitivePaths: this.sensitivePaths(),
    });
    const protectedPaths = launchEnv.protectedPaths;
    // Granting a folder rewrites the permissions of every file in it before the command runs, so a huge one is refused.
    for (const path of [...grants.read, ...grants.write])
      if (await measureEntryLimit(path))
        throw new Error(
          `The Windows sandbox cannot grant "${path}": it holds more than ${GRANT_ENTRY_LIMIT} entries. Grant a narrower path. The command was not run.`,
        );
    signal?.throwIfAborted();
    const real = (path: string) => {
      try {
        return realpathSync.native(path);
      } catch {
        return path;
      }
    };
    // The folders it may grant are measured off the main thread first (#303).
    const request = await withEntryLimits((tooLarge) =>
      buildHelperRequest({
        id: this.nextKey,
        shell: inner,
        cwd: launchEnv.cwd,
        env: {
          ...sandboxEnv(this.env(), 'win32', real(homedir()), real(tmpdir()), this.sandbox()),
          CI: '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        network,
        home: real(homedir()),
        exists: (path) => existsSync(path),
        protectedPaths,
        grants: hasResolvedGrants(grants) ? grants : undefined,
        refresh: this.added.take(launchEnv.cwd),
        tooLarge,
      }),
    );
    let proxy: FilteringProxy | undefined;
    if (filtered) {
      // A proxy that cannot start leaves the command without any network; it is not run unfiltered instead.
      proxy = await startFilteringProxy({ allowedHosts: this.sandbox().allowedHosts });
      if (signal?.aborted) {
        await proxy.close();
        signal.throwIfAborted();
      }
      request.proxy = proxy.socketPath;
    }
    appLog.info('sandbox', 'Command started.', { kind: 'appcontainer', network, filtered });
    const child = new HelperProcess(helper, request);
    if (proxy) {
      const filtering = proxy;
      child.once('close', () => void filtering.close());
    }
    return child;
  }
}

// A container keeps running when its client process is killed, so it is removed by name as well.
const stoppers = new WeakMap<CommandProcess, NonNullable<Launch['stop']>>();
const spawned = new WeakSet<CommandProcess>();
// When a command's shell started and ended, to tell its leftovers on Windows from processes that reused its pid.
interface Lifetime {
  startedAt: number;
  endedAt?: number;
}
const lifetimes = new WeakMap<CommandProcess, Lifetime>();

// Stops still running (container removal, taskkill, the Windows leftover sweep). They run asynchronously so a slow
// engine or process listing does not freeze the main process; quitting waits for them (commandStopsSettled).
const pendingStops = new Set<Promise<void>>();

function trackStop(work: Promise<unknown>): void {
  const tracked = work.then(
    () => undefined,
    () => undefined,
  );
  pendingStops.add(tracked);
  void tracked.then(() => pendingStops.delete(tracked));
}

// A settling stop can start another (the leftover sweep after a shell exits), so this waits until none is left.
export async function commandStopsSettled(): Promise<void> {
  while (pendingStops.size > 0) await Promise.all([...pendingStops]);
}

// Resolves once the process has exited, or after `ms`. A stop is not settled before it (#50): on Windows the stopped
// command's folder stays busy until then, and everywhere a caller may expect the exit code.
function exited(child: CommandProcess, ms = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Whether a program ran and exited with 0. Never rejects.
function runQuietly(file: string, args: string[], timeout?: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, windowsHide: true }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

function killTree(child: CommandProcess): void {
  if (child instanceof HelperProcess) return child.stopTree();
  const stop = stoppers.get(child);
  // Removing the container and killing its client below happen side by side.
  if (stop) trackStop(runQuietly(stop.file, stop.args, 10_000));
  if (!child.pid) return;
  // The shell can exit while programs it started (its process group) keep running, so the group is signalled anyway.
  if (child.exitCode !== null) return killLeftovers(child);
  try {
    if (process.platform === 'win32') {
      // Before the spawn event, spawning taskkill gives the just-created shell time to launch a child after
      // taskkill's snapshot. Terminate our native process handle immediately instead.
      if (!spawned.has(child)) {
        child.kill('SIGKILL');
        // The shell can have started a program before it was killed, which would keep its output pipes and folder
        // busy. Sweep for it once the shell is gone.
        trackStop(exited(child).then(() => sweepWindowsLeftovers(child)));
        return;
      }
      // taskkill can lose a startup race before Windows exposes the new process to its process-tree query.
      // When it fails, still terminate the process we own.
      trackStop(
        runQuietly('taskkill', ['/pid', String(child.pid), '/T', '/F']).then((killed) => {
          if (!killed) child.kill('SIGKILL');
          return exited(child);
        }),
      );
    } else {
      process.kill(-child.pid, 'SIGKILL');
      // Settled, like on Windows, once the process is gone.
      trackStop(exited(child));
    }
  } catch {
    child.kill('SIGKILL');
    trackStop(exited(child));
  }
}

// Kills what a command left behind (`npm run dev &`) after its shell has exited. On POSIX the command was started in
// its own process group, which outlives the shell while any member runs; ESRCH means nothing is left. Windows has no
// groups, so the leftovers are found through their parent pid, in the background (quitting waits for it).
function killLeftovers(child: CommandProcess): void {
  if (!child.pid || child instanceof HelperProcess) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null) return;
    return trackStop(sweepWindowsLeftovers(child));
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Nothing left in the group.
  }
}

async function sweepWindowsLeftovers(child: CommandProcess): Promise<void> {
  const lifetime = lifetimes.get(child);
  if (!child.pid || !lifetime) return;
  await killWindowsLeftovers(child.pid, { startedAt: lifetime.startedAt, endedAt: lifetime.endedAt ?? Date.now() });
}

// libuv before 1.53 (every Node.js release so far) names child-process pipes outside the AppContainer's LOCAL\
// namespace and retries the denied name forever, so the command hangs instead of failing (#101). Patch never
// rewrites the command; the model decides whether a workaround suits the project.
export const APPCONTAINER_TIMEOUT_HINT =
  'Note: this command ran in the Windows sandbox. Node.js programs that start child processes with piped output hang ' +
  'there on current Node.js releases (libuv older than 1.53), including `node --test` and `npm test` with default ' +
  'test isolation. For Node tests, add `--test-isolation=none` (`--experimental-test-isolation=none` on ' +
  'Node 22), for example `npm test -- --test-isolation=none`; test files then share one process. If the tests need ' +
  'separate processes, set unsandboxed to ask the user to run the command outside the sandbox.';

export function formatResult(command: string, result: CommandResult): string {
  const status = result.aborted
    ? 'Stopped by the user.'
    : result.timedOut
      ? 'Timed out and was stopped.'
      : `Exit code: ${result.exitCode ?? 'unknown'}`;
  // Redacted before it is cut: a key whose END falls in the left-out middle would otherwise come through (#253).
  const output = redactSecrets(stripAnsi(result.output).trim());
  const hint = result.timedOut && result.sandbox === 'appcontainer' ? `\n${APPCONTAINER_TIMEOUT_HINT}` : '';
  return `$ ${command}\n${status}\n${output ? truncateOutput(output) : '(no output)'}${hint}`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// How long a started background command is watched before its first result is returned. Tests shorten it.
export const backgroundStartup = { waitMs: 3000 };

// Waits up to backgroundStartup.waitMs, or until the command has ended. Rejects only when `signal` aborts.
async function waitForStartup(entry: BackgroundCommand, signal: AbortSignal): Promise<void> {
  if (entry.exitCode !== undefined) return;
  const ended = new AbortController();
  const end = () => ended.abort();
  entry.process.once('close', end);
  entry.process.once('error', end);
  try {
    await delay(backgroundStartup.waitMs, undefined, { signal: AbortSignal.any([signal, ended.signal]) });
  } catch (error) {
    if (signal.aborted) throw error;
  } finally {
    entry.process.off('close', end);
    entry.process.off('error', end);
  }
}

// The grants each previewed call showed on its card (the agent passes one input object to mustAsk, preview and run).
const approved = new WeakMap<object, string>();

function accessOf(input: {
  network?: boolean;
  unsandboxed?: boolean;
  read_paths?: string[];
  write_paths?: string[];
}): CommandAccess {
  return {
    network: input.network,
    unsandboxed: input.unsandboxed,
    readPaths: input.read_paths,
    writePaths: input.write_paths,
  };
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description: `Run a shell command (${shellName()}) in the project root and return its output and exit code. Each call starts a fresh shell: use paths instead of cd. Set background to true for servers and watchers that do not exit, then read their output with command_output. Do not use it to change files (no sed, perl, PowerShell replace scripts or redirects into project files): use edit_file, write_file and apply_patch, which show a diff and can be undone. Commands may run in a sandbox: only the project folder is writable, the rest of the home folder is hidden and the network is usually off. If a command fails because of that, set network (needs the internet), read_paths or write_paths (needs a few specific files or folders outside the project) or unsandboxed (needs more than that) so the user is asked to allow it once; do not set them otherwise. Prefer read_paths, then write_paths, to unsandboxed.`,
  schema: z.object({
    command: z.string().min(1),
    background: z.boolean().optional().describe('Start without waiting for it to finish (servers, watchers).'),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe(`Default ${DEFAULT_TIMEOUT_SECONDS}.`),
    network: z.boolean().optional().describe('The command needs network access. The user is asked to allow it.'),
    unsandboxed: z
      .boolean()
      .optional()
      .describe(
        'The command needs rights the sandbox withholds, such as unrestricted access to the whole machine. The user is asked to allow this one run.',
      ),
    read_paths: z
      .array(z.string().min(1))
      .max(MAX_GRANT_PATHS)
      .optional()
      .describe(
        'Absolute paths of existing files or folders outside the project the command may read but not change. The command stays sandboxed. The user is asked to allow exactly these paths for this one run.',
      ),
    write_paths: z
      .array(z.string().min(1))
      .max(MAX_GRANT_PATHS)
      .optional()
      .describe(
        'Absolute paths of existing files or folders outside the project the command may read and change. Name the narrowest path; a parent folder opens everything in it. The user is asked to allow exactly these paths for this one run.',
      ),
  }),
  requiresApproval: true,
  mustAsk: (input, context) => context.shell.mustAsk(input.command, accessOf(input)),
  async preview(input, context) {
    const access = accessOf(input);
    await context.shell.prepare(access);
    const { text } = context.shell.describe(input.command, access);
    let note = text;
    if (hasPathGrants(access)) {
      // Resolved now so the card shows the real paths; the command must still resolve to the same set when it starts.
      const grants = await context.shell.resolveGrants(access);
      approved.set(input, grantsKey(grants));
      note = `${text}\n${describeGrants(grants)}`;
    }
    return { title: input.background ? 'Start background command' : 'Run command', command: input.command, note };
  },
  async run(input, context) {
    const { command, background, timeout_seconds } = input;
    const access = { ...accessOf(input), approvedGrants: approved.get(input) };
    if (background) {
      let entry: BackgroundCommand;
      try {
        await context.shell.prepare(access);
        entry = await context.shell.startBackground(command, context.signal, access, context.chatId);
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { content: (error as Error).message, isError: true, summary: `Could not start \`${command}\`` };
      }
      // Give servers a moment so early errors (port in use, syntax errors) show up in the result. A command that
      // has already ended has nothing more to show, so it does not wait.
      await waitForStartup(entry, context.signal);
      const status = entry.exitCode === undefined ? 'still running' : `exited with code ${entry.exitCode}`;
      const content = `Started background command ${entry.id} (${status}).\n${truncateOutput(redactSecrets(stripAnsi(takeUnread(entry)))) || '(no output yet)'}`;
      // Already ended and fully shown: nothing is left to poll.
      context.shell.releaseIfRead(entry);
      return {
        content,
        summary: `Started \`${command}\` in the background`,
      };
    }
    const result = await context.shell.run(command, {
      timeoutSeconds: timeout_seconds,
      signal: context.signal,
      onOutput: (text) => context.onProgress(stripAnsi(text)),
      access,
    });
    return {
      content: formatResult(command, result),
      isError: result.exitCode !== 0,
      summary: `Ran \`${command}\` (${result.timedOut ? 'timed out' : `exit ${result.exitCode}`})`,
    };
  },
});
export const commandOutputTool = defineTool({
  name: 'command_output',
  description:
    'Get the output of a background command started with run_command, or stop it. Returns only the output that is new since your last read of that command (the result of starting it counts as a read); set full to true to get all of its output again.',
  schema: z.object({
    id: z.number().int(),
    stop: z.boolean().optional().describe('Stop the command after reading its output.'),
    full: z.boolean().optional().describe('Return all of the output so far, not only what is new.'),
  }),
  requiresApproval: false,
  async run({ id, stop, full }, context) {
    const entry = context.shell.getBackground(id, context.chatId);
    if (!entry) return { content: `No background command with id ${id}.`, isError: true };
    const status = entry.exitCode === undefined ? 'running' : `exited with code ${entry.exitCode}`;
    const unread = takeUnread(entry);
    const output = full
      ? truncateOutput(redactSecrets(stripAnsi(entry.output).trim())) || '(no output)'
      : truncateOutput(redactSecrets(stripAnsi(unread).trim())) || '(no new output since your last read)';
    if (stop) context.shell.stopBackground(id, entry.owner);
    // An ended command whose output is now fully read is dropped from memory.
    else context.shell.releaseIfRead(entry);
    return {
      content: `Command ${id}: ${entry.command}\nStatus: ${stop ? 'stopped' : status}\n${output}`,
      summary: `${stop ? 'Stopped' : 'Checked'} background command ${id}`,
    };
  },
});
