import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { appLog } from '../app_log';
import { sandboxEnv, scrubEnv } from './env';
import {
  buildLaunch,
  decideSandbox,
  describeSandbox,
  detectSandboxSupport,
  systemLaunchEnv,
  wantsNetwork,
  type CommandAccess,
  type Launch,
  type SandboxConfig,
  type SandboxDecision,
  type SandboxSupport,
} from './sandbox';
import { buildHelperRequest, exceedsEntryLimit, HelperProcess } from './sandbox_windows';
import { defineTool, truncateOutput } from './types';
import { validateSandboxGit } from './sandbox_git';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_BUFFERED_CHARS = 1_000_000;
const EXIT_DRAIN_MS = 500;

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

// What the runner needs from a running command: a ChildProcess, or a command running through the Windows helper.
export interface CommandProcess extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

interface BackgroundCommand {
  id: number;
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
  private nextId = 1;

  constructor(
    private readonly cwd: () => string,
    private readonly sandbox: () => SandboxConfig = () => ({ mode: 'off', network: 'on', image: '', allowedHosts: '' }),
    private readonly detect: () => SandboxSupport = detectSandboxSupport,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  // URL matching cannot constrain the connections a program makes. Treat it as a request for full network access.
  mustAsk(command: string, access: CommandAccess): boolean {
    if (access.network || access.unsandboxed) return true;
    const config = this.sandbox();
    return config.mode !== 'off' && config.network === 'allow-list' && wantsNetwork(command, config, access);
  }

  // What would happen to this command: shown on the approval card and in the result.
  describe(command: string, access: CommandAccess = {}): { sandboxed: boolean; text: string } {
    const decision = this.decide(command, access);
    return {
      sandboxed: decision.kind !== 'none' && decision.kind !== 'unavailable',
      text: describeSandbox(decision, access),
    };
  }

  private decide(command: string, access: CommandAccess): SandboxDecision {
    const config = this.sandbox();
    const support =
      config.mode === 'off' || access.unsandboxed
        ? { bwrap: false, seatbelt: false, appcontainer: null, container: null }
        : this.detect();
    return decideSandbox(command, config, support, access, process.platform);
  }

  run(
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
    return new Promise((resolve) => {
      // A stop that came in before the command could start: an abort listener added now would never fire.
      if (signal?.aborted) return resolve({ exitCode: null, output: '', timedOut: false, aborted: true });
      let child: CommandProcess;
      try {
        child = this.spawn(command, access);
      } catch (error) {
        return resolve({ exitCode: null, output: (error as Error).message, timedOut: false, aborted: false });
      }
      let output = '';
      let timedOut = false;
      let aborted = false;

      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output = (output + text).slice(-MAX_BUFFERED_CHARS);
        onOutput?.(text);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

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

      let finished = false;
      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ exitCode, output, timedOut, aborted });
      };
      child.on('error', (error) => {
        output += `\n${error.message}`;
        finish(null);
      });
      // 'close' waits for the output pipes, which a leftover child (a test worker, a dev server the command started)
      // can hold open long after the command itself ended. Give the pipes a moment to drain, then stop waiting.
      child.on('exit', (code) => setTimeout(() => finish(code), EXIT_DRAIN_MS));
      child.on('close', (code) => finish(code));
    });
  }

  startBackground(command: string, signal?: AbortSignal, access: CommandAccess = {}): BackgroundCommand {
    signal?.throwIfAborted();
    const child = this.spawn(command, access);
    const onAbort = () => this.stopBackground(entry.id);
    const entry: BackgroundCommand = {
      id: this.nextId++,
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
    const collect = (chunk: Buffer) => append(chunk.toString('utf8'));
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('close', (code) => {
      entry.exitCode = code;
      entry.detachAbort();
    });
    child.on('error', (error) => {
      append(`\n${error.message}`);
      entry.exitCode = null;
      entry.detachAbort();
    });
    this.background.set(entry.id, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort during spawning must not leave an untracked command alive.
    if (signal?.aborted) onAbort();
    return entry;
  }

  getBackground(id: number): BackgroundCommand | undefined {
    return this.background.get(id);
  }

  stopBackground(id: number): boolean {
    const entry = this.background.get(id);
    if (!entry) return false;
    entry.detachAbort();
    if (entry.exitCode === undefined) killTree(entry.process);
    this.background.delete(id);
    return true;
  }

  // Called on Stop, when a chat/project closes, or when the app quits.
  stopAll(): void {
    for (const id of [...this.background.keys()]) this.stopBackground(id);
  }

  // Throws when the sandbox the user chose is not available: the command must not run unsandboxed then.
  private spawn(command: string, access: CommandAccess): CommandProcess {
    const decision = this.decide(command, access);
    if (decision.kind === 'unavailable') {
      appLog.warn('sandbox', 'The chosen sandbox is not available.', { mode: this.sandbox().mode });
      throw new Error(decision.reason);
    }
    const config = this.sandbox();
    const inner = shellCommand(command, decision.kind !== 'none');
    if (decision.kind === 'appcontainer') return this.spawnInAppContainer(inner, decision.network);
    const launch: Launch =
      decision.kind === 'none'
        ? { file: inner.file, args: inner.args }
        : buildLaunch(
            decision,
            systemLaunchEnv({
              cwd: this.cwd(),
              home: homedir(),
              tmp: tmpdir(),
              inner: decision.kind === 'container' ? { file: '/bin/sh', args: ['-c', command] } : inner,
              command,
              containerName: `patch-${randomBytes(6).toString('hex')}`,
              image: config.image,
            }),
            this.detect().container,
          );
    appLog.info('sandbox', 'Command started.', {
      kind: decision.kind,
      network: decision.kind === 'none' ? true : decision.network,
    });
    const child = spawn(launch.file, launch.args, {
      cwd: this.cwd(),
      env: {
        ...(decision.kind === 'bwrap' || decision.kind === 'seatbelt'
          ? sandboxEnv(this.env(), process.platform, homedir(), decision.kind === 'bwrap' ? '/tmp' : tmpdir(), config)
          : scrubEnv(this.env())),
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== 'win32',
    });
    if (launch.stop) stoppers.set(child, launch.stop);
    child.once('spawn', () => spawned.add(child));
    return child;
  }

  private spawnInAppContainer(inner: { file: string; args: string[] }, network: boolean): CommandProcess {
    const helper = this.detect().appcontainer;
    if (!helper)
      throw new Error('The Windows sandbox helper (sandbox-helper.exe) was not found. The command was not run.');
    const gitPaths = validateSandboxGit(this.cwd());
    const real = (path: string) => {
      try {
        return realpathSync.native(path);
      } catch {
        return path;
      }
    };
    const request = buildHelperRequest({
      id: this.nextId,
      shell: inner,
      cwd: real(this.cwd()),
      env: {
        ...sandboxEnv(this.env(), 'win32', real(homedir()), real(tmpdir()), this.sandbox()),
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      network,
      home: real(homedir()),
      exists: (path) => existsSync(path),
      gitPaths,
      tooLarge: (path) => exceedsEntryLimit(path),
    });
    appLog.info('sandbox', 'Command started.', { kind: 'appcontainer', network });
    return new HelperProcess(helper, request);
  }
}

// A container keeps running when its client process is killed, so it is removed by name as well.
const stoppers = new WeakMap<CommandProcess, NonNullable<Launch['stop']>>();
const spawned = new WeakSet<CommandProcess>();

function killTree(child: CommandProcess): void {
  if (child instanceof HelperProcess) return child.stopTree();
  const stop = stoppers.get(child);
  if (stop) {
    try {
      spawnSync(stop.file, stop.args, { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    } catch {
      // Falls through to killing the client.
    }
  }
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // Before the spawn event, synchronously spawning taskkill gives the just-created shell time to launch a
      // child after taskkill's snapshot. Terminate our native process handle immediately instead.
      if (!spawned.has(child)) {
        child.kill('SIGKILL');
        return;
      }
      const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      // taskkill can lose a startup race before Windows exposes the new process to its process-tree query.
      // spawnSync returns a nonzero status rather than throwing; still terminate the process we own.
      if (killed.status !== 0) child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}
export function formatResult(command: string, result: CommandResult): string {
  const status = result.aborted
    ? 'Stopped by the user.'
    : result.timedOut
      ? 'Timed out and was stopped.'
      : `Exit code: ${result.exitCode ?? 'unknown'}`;
  const output = stripAnsi(result.output).trim();
  return `$ ${command}\n${status}\n${output ? truncateOutput(output) : '(no output)'}`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description: `Run a shell command (${shellName()}) in the project root and return its output and exit code. Each call starts a fresh shell: use paths instead of cd. Set background to true for servers and watchers that do not exit, then read their output with command_output. Do not use it to change files (no sed, perl, PowerShell replace scripts or redirects into project files): use edit_file, write_file and apply_patch, which show a diff and can be undone. Commands may run in a sandbox: only the project folder is writable, the rest of the home folder is hidden and the network is usually off. If a command fails because of that, set network (needs the internet) or unsandboxed (needs files outside the project) so the user is asked to allow it once; do not set them otherwise.`,
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
      .describe('The command needs rights the sandbox withholds. The user is asked to allow this one run.'),
  }),
  requiresApproval: true,
  mustAsk: ({ command, network, unsandboxed }, context) => context.shell.mustAsk(command, { network, unsandboxed }),
  async preview({ command, background, network, unsandboxed }, context) {
    const { text } = context.shell.describe(command, { network, unsandboxed });
    return { title: background ? 'Start background command' : 'Run command', command, note: text };
  },
  async run({ command, background, timeout_seconds, network, unsandboxed }, context) {
    const access = { network, unsandboxed };
    if (background) {
      let entry: BackgroundCommand;
      try {
        entry = context.shell.startBackground(command, context.signal, access);
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { content: (error as Error).message, isError: true, summary: `Could not start \`${command}\`` };
      }
      // Give servers a moment so early errors (port in use, syntax errors) show up in the result.
      await delay(3000, undefined, { signal: context.signal });
      const status = entry.exitCode === undefined ? 'still running' : `exited with code ${entry.exitCode}`;
      return {
        content: `Started background command ${entry.id} (${status}).\n${truncateOutput(stripAnsi(takeUnread(entry))) || '(no output yet)'}`,
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
    const entry = context.shell.getBackground(id);
    if (!entry) return { content: `No background command with id ${id}.`, isError: true };
    const status = entry.exitCode === undefined ? 'running' : `exited with code ${entry.exitCode}`;
    const unread = takeUnread(entry);
    const output = full
      ? truncateOutput(stripAnsi(entry.output).trim()) || '(no output)'
      : truncateOutput(stripAnsi(unread).trim()) || '(no new output since your last read)';
    if (stop) context.shell.stopBackground(id);
    return {
      content: `Command ${id}: ${entry.command}\nStatus: ${stop ? 'stopped' : status}\n${output}`,
      summary: `${stop ? 'Stopped' : 'Checked'} background command ${id}`,
    };
  },
});
