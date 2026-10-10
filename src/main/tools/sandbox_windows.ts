import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { PassThrough } from 'node:stream';
import { basename, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appLog } from '../app_log';
import { trustedHelper } from './native_integrity';

// The Windows sandbox: sandbox-helper.exe (native/sandbox-helper) starts the command in an AppContainer. The planning
// code here is pure so it can be tested on any platform; the protocol client can be pointed at any script that speaks
// the same line-delimited JSON.

export const HELPER_NAME = 'sandbox-helper.exe';

export interface HelperLimits {
  // For the whole command, all its processes together (#150).
  memoryMb: number;
  processes: number;
  timeoutMs: number;
  // A hard cap on the command's share of all processors, in percent; 0 for none (#150).
  cpuPercent: number;
}

export interface HelperRequest {
  id: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  network: boolean;
  // Patch's filtering proxy (a named pipe) when the network is filtered by host (#97); `network` is then false.
  proxy?: string;
  // The working folder may sit under application data (a sandboxed MCP server's own folder, #87).
  workspace?: boolean;
  readWrite: string[];
  readOnly: string[];
  // Individual Program Files PATH directories; the helper checks package access before granting or staging.
  toolchains: string[];
  denyWrite: string[];
  limits: HelperLimits;
}

export type HelperEvent =
  | { type: 'started'; id: number; pid: number }
  | { type: 'stdout'; id: number; data: string }
  | { type: 'stderr'; id: number; data: string }
  | { type: 'exit'; id: number; exitCode: number; timedOut: boolean }
  | { type: 'error'; id?: number | null; message: string }
  | { type: 'log'; code: string; record: string; failures: number };

export const DEFAULT_LIMITS = { memoryMb: 8192, processes: 512 };
// Windows also caps a command's CPU, so a busy build or a runaway loop leaves the machine room to respond (#150).
export const WINDOWS_CPU_PERCENT = 90;

// Looked at from the home folder: what builds need (the same list as on the other platforms, plus the npm and pnpm
// folders Windows installs put under AppData). Credentials are deliberately not listed.
const HOME_READ_ONLY_WINDOWS = [
  '.cargo\\bin',
  '.cargo\\registry',
  '.cargo\\git',
  '.rustup',
  '.nvm',
  '.volta',
  '.bun',
  '.deno',
  '.pyenv',
  '.rbenv',
  '.asdf',
  '.local\\bin',
  '.local\\share\\pnpm',
  '.m2\\repository',
  '.gradle\\caches',
  '.gradle\\wrapper',
  'go\\pkg\\mod',
  'AppData\\Roaming\\npm',
  'AppData\\Local\\pnpm',
  'scoop',
];

// Granting a folder rewrites the permissions of every file inside it before each command (about 50 s for the 128,000
// files of ~/.rustup), so a folder with more entries than this is not opened whole.
export const GRANT_ENTRY_LIMIT = 5000;

const sizeCache = new Map<string, boolean>();

// True when the folder holds more than `limit` entries. Stops counting at the limit, and remembers the answer for
// the life of the app (a toolchain folder does not shrink).
export function exceedsEntryLimit(path: string, limit = GRANT_ENTRY_LIMIT): boolean {
  const key = `${limit}|${process.platform === 'win32' ? path.toLowerCase() : path}`;
  const known = sizeCache.get(key);
  if (known !== undefined) return known;
  let count = 0;
  const pending = [path];
  while (pending.length > 0 && count <= limit) {
    const dir = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    count += entries.length;
    for (const entry of entries) if (entry.isDirectory()) pending.push(join(dir, entry.name));
  }
  const result = count > limit;
  sizeCache.set(key, result);
  return result;
}

export interface WindowsPolicyInput {
  cwd: string;
  home: string;
  systemRoot: string;
  programDirs: string[];
  pathEntries: string[];
  exists: (path: string) => boolean;
  protectedPaths?: string[];
  // Extra writable folders besides cwd (a sandboxed MCP server's project, #87).
  writable?: string[];
  // Whether a folder is too big to grant whole; such a folder is replaced by its `bin` subfolder, or left closed.
  tooLarge?: (path: string) => boolean;
}

export interface WindowsPolicy {
  readWrite: string[];
  readOnly: string[];
  // Individual Program Files PATH directories; the helper checks package access before granting or staging.
  toolchains: string[];
  denyWrite: string[];
}

const same = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

function within(path: string, dir: string): boolean {
  const rel = win32.relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
}

// Windows system paths need no grant. Program Files installers can replace inherited package permissions, so
// individual PATH directories there need native inspection. Never open a whole install root, home or drive.
export function windowsPolicy(input: WindowsPolicyInput): WindowsPolicy {
  const { cwd, home, exists } = input;
  const toolchains: string[] = [];
  // PATH must not reopen the configuration/credentials excluded from the toolchain grants above.
  const privatePaths = [
    '.cargo\\credentials',
    '.cargo\\credentials.toml',
    '.cargo\\config.toml',
    '.cargo\\config',
    '.m2\\settings.xml',
    '.m2\\settings-security.xml',
    '.gradle\\gradle.properties',
    '.gitconfig',
    '.config\\git',
  ].map((rel) => win32.join(home, rel));
  const readOnly: string[] = [];
  const add = (path: string) => {
    const full = win32.resolve(path);
    if ([...readOnly, ...toolchains].some((existing) => same(existing, full))) return;
    if (input.systemRoot && within(full, input.systemRoot)) return;
    if (input.programDirs.some((dir) => dir && within(dir, full))) return;
    if (within(cwd, full) || same(full, win32.parse(full).root) || within(home, full)) return;
    if (privatePaths.some((path) => within(path, full) || within(full, path))) return;
    if (!exists(full)) return;
    if (input.programDirs.some((dir) => dir && within(full, dir))) {
      // Native code enforces resource bounds too, and fails explicitly for oversized inaccessible installs.
      toolchains.push(full);
      return;
    }
    if (!input.tooLarge?.(full)) {
      readOnly.push(full);
      return;
    }
    // A big toolchain folder (.rustup, .cargo) is not opened whole: its commands alone are, when that is small.
    const bin = win32.join(full, 'bin');
    if (exists(bin) && !same(bin, full) && !input.tooLarge(bin) && !readOnly.some((entry) => same(entry, bin)))
      readOnly.push(bin);
  };
  for (const rel of HOME_READ_ONLY_WINDOWS) add(win32.join(home, rel));
  for (const entry of input.pathEntries) if (entry && win32.isAbsolute(entry)) add(entry);
  const protectedPaths = input.protectedPaths ?? [win32.join(cwd, '.git')];
  const extra = (input.writable ?? []).filter((path) => !same(path, cwd));
  return {
    readWrite: [cwd, ...extra],
    readOnly: [...readOnly, ...protectedPaths],
    toolchains,
    denyWrite: protectedPaths,
  };
}

export interface BuildRequestInput {
  id: number;
  shell: { file: string; args: string[] };
  cwd: string;
  env: NodeJS.ProcessEnv;
  network: boolean;
  home: string;
  exists: (path: string) => boolean;
  protectedPaths?: string[];
  writable?: string[];
  workspace?: boolean;
  tooLarge?: (path: string) => boolean;
  limits?: Partial<HelperLimits>;
}

export function buildHelperRequest(input: BuildRequestInput): HelperRequest {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env)) if (value !== undefined) env[name] = value;
  const lookup = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
  const systemRoot = lookup('systemroot') || 'C:\\Windows';
  const policy = windowsPolicy({
    cwd: input.cwd,
    home: input.home,
    systemRoot,
    programDirs: [lookup('programfiles'), lookup('programfiles(x86)'), lookup('programw6432')].filter(Boolean),
    pathEntries: lookup('path').split(';'),
    exists: input.exists,
    protectedPaths: input.protectedPaths,
    writable: input.writable,
    tooLarge: input.tooLarge,
  });
  const shell = win32.isAbsolute(input.shell.file)
    ? input.shell.file
    : win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', input.shell.file);
  return {
    id: input.id,
    command: shell,
    args: input.shell.args,
    cwd: input.cwd,
    env,
    network: input.network,
    ...(input.workspace ? { workspace: true } : {}),
    ...policy,
    limits: { ...DEFAULT_LIMITS, timeoutMs: 0, cpuPercent: WINDOWS_CPU_PERCENT, ...input.limits },
  };
}

// Startup recovery reports records it could not clean up or set aside (codes, record names and counts only).
export function logHelperEvent(event: Extract<HelperEvent, { type: 'log' }>): void {
  appLog.warn('sandbox-helper', event.code, { record: event.record, failures: event.failures });
}

export function parseHelperEvent(line: string): HelperEvent | null {
  try {
    const value = JSON.parse(line) as HelperEvent;
    return value && typeof value === 'object' && typeof value.type === 'string' ? value : null;
  } catch {
    return null;
  }
}

// Where sandbox-helper.exe lives: next to the app resources when packaged, in the Cargo output when developing. A
// packaged build only trusts its bundled helper, so an environment variable or a file in the working directory can't
// pick the binary that every sandboxed command runs through (#149). If that helper is missing, there is no sandbox.
export function helperCandidates(
  resourcesPath: string | undefined,
  dirname: string,
  cwd: string,
  override: string | undefined,
  packaged: boolean,
): string[] {
  if (packaged) return resourcesPath ? [win32.join(resourcesPath, HELPER_NAME)] : [];
  return [
    override,
    resourcesPath ? win32.join(resourcesPath, HELPER_NAME) : undefined,
    win32.join(dirname, '..', '..', 'native', 'sandbox-helper', 'target', 'release', HELPER_NAME),
    win32.join(cwd, 'native', 'sandbox-helper', 'target', 'release', HELPER_NAME),
  ].filter((path): path is string => Boolean(path));
}

// The same rule as Electron's app.isPackaged, without importing electron: this module also runs under plain Node in
// tests and perf runs, which count as development.
export function isPackagedElectron(
  electronVersion: string | undefined,
  execPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (!electronVersion) return false;
  const exe = (platform === 'win32' ? win32.basename(execPath) : basename(execPath)).toLowerCase();
  return exe !== (platform === 'win32' ? 'electron.exe' : 'electron');
}

export function findHelper(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = isPackagedElectron(process.versions.electron, process.execPath, process.platform);
  return (
    helperCandidates(resources, __dirname, process.cwd(), process.env.PATCH_SANDBOX_HELPER, packaged).find(
      // A packaged build runs only the helper it was built with (#149); a replaced one means no sandbox.
      (path) => existsSync(path) && (!packaged || trustedHelper(path)),
    ) ?? null
  );
}

export const REVOKE_TIMEOUT_MS = 15_000;

// The helper grants each project's sandbox write access once, to a capability derived from the project path, and
// keeps it across commands (#103). This removes it when the user closes or removes the project; quitting keeps it.
// Resolves to the helper's error, or null. The helper refuses while a sandboxed command still runs in the project.
// A helper that hangs is killed after timeoutMs and reported as an error.
export function revokeProjectGrant(
  project: string,
  helper: string | null = findHelper(),
  timeoutMs = REVOKE_TIMEOUT_MS,
): Promise<string | null> {
  if (!helper || process.platform !== 'win32') return Promise.resolve(null);
  let cwd = project;
  try {
    // The same spelling ShellRunner sends as the command's cwd, which names the capability.
    cwd = realpathSync.native(project);
  } catch {
    // A deleted project has nothing left to revoke on disk; the helper still drops its record.
  }
  return new Promise((resolve) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    // A helper stuck on the permission mutex would otherwise leave this, and the retry loop above it, waiting forever.
    const timer = setTimeout(() => {
      child.kill();
      resolve('The sandbox helper did not answer in time.');
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
    child.on('close', () => {
      clearTimeout(timer);
      let error: string | null = null;
      for (const event of output.split('\n').map(parseHelperEvent)) {
        if (event?.type === 'log') logHelperEvent(event);
        else if (event?.type === 'error') error ??= event.message;
      }
      resolve(error);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${JSON.stringify({ revokeProject: cwd })}\n`);
  });
}

// Closing a project stops its commands first, but their helpers can still be finishing their cleanup, and a grant a
// live run uses is kept, so the revoke is retried briefly. Resolves to whether the grant is gone.
export async function releaseProjectGrant(
  project: string,
  revoke: (project: string) => Promise<string | null> = revokeProjectGrant,
  attempts = 5,
  waitMs = 2000,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if ((await revoke(project)) === null) return true;
    if (attempt >= attempts) return false;
    await delay(waitMs);
  }
}

const FORCE_KILL_MS = 3000;

// A command running through the helper, shaped like the parts of ChildProcess the shell runner uses.
export class HelperProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  exitCode: number | null = null;
  private done = false;
  private buffer = '';
  private readonly helper: ChildProcess;
  private readonly id: number;

  constructor(helperPath: string, request: HelperRequest, helperArgs: string[] = []) {
    super();
    this.id = request.id;
    this.helper = spawn(helperPath, helperArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.helper.stdout?.setEncoding('utf8');
    this.helper.stdout?.on('data', (chunk: string) => this.read(chunk));
    // A helper that crashes writes its panic here; nothing sensitive, but also nothing the agent should see.
    this.helper.stderr?.resume();
    this.helper.stdin?.on('error', () => {});
    this.helper.on('error', (error) => this.fail(`Could not start the sandbox helper: ${error.message}`));
    this.helper.on('close', () => {
      this.read('\n');
      this.fail('The sandbox helper stopped before the command finished.');
    });
    this.helper.stdin?.write(`${JSON.stringify(request)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const event = line ? parseHelperEvent(line) : null;
      if (event) this.handle(event);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handle(event: HelperEvent): void {
    switch (event.type) {
      case 'started':
        this.pid = event.pid;
        this.emit('spawn');
        break;
      case 'stdout':
        this.stdout.write(event.data);
        break;
      case 'stderr':
        this.stderr.write(event.data);
        break;
      case 'exit':
        this.finish(event.exitCode);
        break;
      case 'error':
        this.fail(event.message);
        break;
      case 'log':
        logHelperEvent(event);
        break;
    }
  }

  private fail(message: string): void {
    if (this.done) return;
    this.done = true;
    // The helper keeps serving until its input closes, so a run that failed before starting would leave it idle.
    this.helper.stdin?.end();
    this.stdout.end();
    this.stderr.end();
    this.emit('error', new Error(message));
    this.emit('close', null);
  }

  private finish(exitCode: number): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = exitCode;
    this.stdout.end();
    this.stderr.end();
    // Lets the output written just before the exit reach its listeners first.
    setImmediate(() => {
      this.emit('exit', exitCode);
      this.emit('close', exitCode);
    });
    this.helper.stdin?.end();
  }

  // Ends the command and everything it started: the helper terminates its job object, then the helper itself exits.
  stopTree(): void {
    if (!this.helper.pid || this.helper.exitCode !== null) return;
    try {
      this.helper.stdin?.write(`${JSON.stringify({ id: this.id, kill: true })}\n`);
      this.helper.stdin?.end();
    } catch {
      // Falls through to the forced stop.
    }
    const force = setTimeout(() => {
      if (this.helper.exitCode === null && this.helper.pid) {
        // The job object has KILL_ON_JOB_CLOSE, so ending the helper ends the command too.
        execFile('taskkill', ['/pid', String(this.helper.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      }
    }, FORCE_KILL_MS);
    force.unref();
    this.helper.once('close', () => clearTimeout(force));
  }

  kill(): boolean {
    this.stopTree();
    return true;
  }
}
