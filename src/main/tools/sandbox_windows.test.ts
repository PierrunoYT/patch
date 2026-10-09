import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appLog } from '../app_log';
import {
  buildHelperRequest,
  exceedsEntryLimit,
  helperCandidates,
  HelperProcess,
  isPackagedElectron,
  parseHelperEvent,
  releaseProjectGrant,
  revokeProjectGrant,
  windowsPolicy,
  type HelperRequest,
} from './sandbox_windows';

const home = 'C:\\Users\\me';
const cwd = 'C:\\Users\\me\\work\\proj';
const present =
  (...paths: string[]) =>
  (path: string) =>
    paths.some((p) => p.toLowerCase() === path.toLowerCase());

describe('windowsPolicy', () => {
  const base = {
    cwd,
    home,
    systemRoot: 'C:\\WINDOWS',
    programDirs: ['C:\\Program Files', 'C:\\Program Files (x86)'],
    pathEntries: [],
  };

  it('makes only project files writable and protects the entire Git directory', () => {
    const policy = windowsPolicy({ ...base, exists: () => false });
    expect(policy.readWrite).toEqual([cwd]);
    expect(policy.denyWrite).toEqual([`${cwd}\\.git`]);
    expect(policy.readOnly).toEqual([`${cwd}\\.git`]);
  });

  it('adds extra writable folders besides the working directory (#87)', () => {
    const state = 'C:\\Users\\me\\AppData\\Roaming\\patch\\mcp\\sandboxed\\x';
    const policy = windowsPolicy({
      ...base,
      cwd: state,
      writable: [cwd, state],
      exists: () => false,
      gitPaths: [`${cwd}\\.git`],
    });
    expect(policy.readWrite).toEqual([state, cwd]);
    expect(policy.denyWrite).toEqual([`${cwd}\\.git`]);
  });

  it('protects a gitfile and its in-project metadata directory', () => {
    const gitPaths = [`${cwd}\\.git`, `${cwd}\\metadata`];
    const policy = windowsPolicy({ ...base, exists: () => false, gitPaths });
    expect(policy.readWrite).toEqual([cwd]);
    expect(policy.readOnly).toEqual(gitPaths);
    expect(policy.denyWrite).toEqual(gitPaths);
  });

  it('opens toolchain folders under the home folder read-only, and never credentials', () => {
    const policy = windowsPolicy({
      ...base,
      exists: present(`${home}\\.cargo\\bin`, `${home}\\.ssh`, `${home}\\.gitconfig`, `${home}\\AppData\\Roaming\\npm`),
    });
    expect(policy.readOnly).toEqual([`${home}\\.cargo\\bin`, `${home}\\AppData\\Roaming\\npm`, `${cwd}\\.git`]);
  });

  it('does not reopen credential-bearing paths through PATH, even if the credentials do not exist yet', () => {
    const privatePaths = ['.cargo', '.m2', '.gradle', '.gitconfig', '.config', '.config\\git'];
    const safePaths = [
      '.cargo\\bin',
      '.cargo\\registry',
      '.cargo\\git',
      '.m2\\repository',
      '.gradle\\caches',
      '.gradle\\wrapper',
    ];
    const policy = windowsPolicy({
      ...base,
      pathEntries: privatePaths.map((rel) => `${home}\\${rel}`.toUpperCase()),
      exists: present(...[...privatePaths, ...safePaths].map((rel) => `${home}\\${rel}`)),
    });
    expect(policy.readOnly).toEqual([...safePaths.map((rel) => `${home}\\${rel}`), `${cwd}\\.git`]);
  });

  it('selects narrow Program Files candidates while skipping system folders', () => {
    const policy = windowsPolicy({
      ...base,
      pathEntries: [
        'C:\\WINDOWS\\system32',
        'C:\\Program Files\\nodejs',
        'C:\\nvm4w\\nodejs',
        'C:\\missing',
        'relative',
      ],
      exists: present('C:\\WINDOWS\\system32', 'C:\\Program Files\\nodejs', 'C:\\nvm4w\\nodejs'),
    });
    expect(policy.readOnly).toEqual(['C:\\nvm4w\\nodejs', `${cwd}\\.git`]);
    expect(policy.toolchains).toEqual(['C:\\Program Files\\nodejs']);
  });

  it('never opens a drive root, the home folder, or a folder that contains the project or the home folder', () => {
    const policy = windowsPolicy({
      ...base,
      pathEntries: ['C:\\', home, 'C:\\Users', 'C:\\Users\\me\\work'],
      exists: () => true,
    });
    expect(policy.readOnly).not.toContain('C:\\');
    expect(policy.readOnly).not.toContain(home);
    expect(policy.readOnly).not.toContain('C:\\Users');
    expect(policy.readOnly).not.toContain('C:\\Users\\me\\work');
  });

  it('opens only the bin folder of a toolchain folder that is too large, or nothing when that is too large too', () => {
    const big = new Set([
      `${home}\\.rustup`.toLowerCase(),
      `${home}\\scoop`.toLowerCase(),
      `${home}\\scoop\\bin`.toLowerCase(),
    ]);
    const policy = windowsPolicy({
      ...base,
      exists: present(
        `${home}\\.cargo`,
        `${home}\\.cargo\\bin`,
        `${home}\\.rustup`,
        `${home}\\scoop`,
        `${home}\\scoop\\bin`,
      ),
      tooLarge: (path) => big.has(path.toLowerCase()) || path.toLowerCase() === `${home}\\.cargo`.toLowerCase(),
    });
    expect(policy.readOnly).toEqual([`${home}\\.cargo\\bin`, `${cwd}\\.git`]);
  });

  it('never selects install roots, their ancestors or similarly named sibling folders as toolchains', () => {
    const policy = windowsPolicy({
      ...base,
      pathEntries: [
        'C:\\',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\Program Files\\..',
        'C:\\Program Files\\nodejs',
        'c:\\PROGRAM FILES\\NODEJS\\',
        'C:\\Program Files-extra\\tools',
      ],
      exists: () => true,
    });
    expect(policy.toolchains).toEqual(['C:\\Program Files\\nodejs']);
    expect(policy.readOnly).toContain('C:\\Program Files-extra\\tools');
    expect(policy.readOnly).not.toContain('C:\\Program Files');
  });

  it('leaves Program Files resource checks to the native helper rather than granting a broad or bin fallback', () => {
    const policy = windowsPolicy({
      ...base,
      pathEntries: ['C:\\Program Files\\nodejs'],
      exists: () => true,
      tooLarge: () => true,
    });
    expect(policy.toolchains).toEqual(['C:\\Program Files\\nodejs']);
    expect(policy.readOnly).not.toContain('C:\\Program Files\\nodejs');
  });

  it('does not list a folder twice', () => {
    const policy = windowsPolicy({
      ...base,
      pathEntries: ['D:\\tools', 'd:\\TOOLS\\'],
      exists: () => true,
    });
    expect(policy.readOnly.filter((path) => path.toLowerCase().startsWith('d:\\tools'))).toHaveLength(1);
  });
});

describe('releaseProjectGrant (#103)', () => {
  it('retries while a closing project still has a running command, then reports success', async () => {
    const answers = ['sandboxed commands still run in this project; its grant is kept', null];
    const calls: string[] = [];
    const released = await releaseProjectGrant(
      cwd,
      async (project) => (calls.push(project), answers.shift() ?? null),
      5,
      0,
    );
    expect(released).toBe(true);
    expect(calls).toEqual([cwd, cwd]);
  });

  it('gives up after its attempts and says the grant was kept', async () => {
    let calls = 0;
    expect(await releaseProjectGrant(cwd, async () => (calls++, 'refused'), 3, 0)).toBe(false);
    expect(calls).toBe(3);
  });
});

describe('revokeProjectGrant timeout (#188)', () => {
  it.skipIf(process.platform !== 'win32')('kills a hung helper and resolves with an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-revoke-hang-'));
    try {
      // A copy of node.exe stands in for the helper; the preload keeps it alive so it never answers.
      const helper = join(dir, 'hang.exe');
      copyFileSync(process.execPath, helper);
      const hang = join(dir, 'hang.js');
      writeFileSync(
        hang,
        'setInterval(() => {}, 1000);\nprocess.on("uncaughtException", () => {});\nprocess.exit = () => undefined;\n',
      );
      const previous = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `--require ${JSON.stringify(hang)}`;
      let error: string | null;
      const started = Date.now();
      try {
        error = await revokeProjectGrant(dir, helper, 300);
      } finally {
        if (previous === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previous;
      }
      expect(error).toMatch(/did not answer in time/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe('exceedsEntryLimit', () => {
  it('counts nested entries and stops at the limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-grant-size-'));
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      for (let i = 0; i < 6; i++) writeFileSync(join(root, 'a', 'b', `f${i}`), '');
      expect(exceedsEntryLimit(root, 100)).toBe(false);
      expect(exceedsEntryLimit(root, 5)).toBe(true);
      expect(exceedsEntryLimit(root, 7)).toBe(true);
      expect(exceedsEntryLimit(root, 8)).toBe(false);
      expect(exceedsEntryLimit(join(root, 'missing'), 5)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildHelperRequest', () => {
  const input = {
    id: 4,
    shell: { file: 'powershell.exe', args: ['-NoLogo', '-Command', 'dir'] },
    cwd,
    env: {
      SystemRoot: 'C:\\WINDOWS',
      Path: 'C:\\WINDOWS\\system32;D:\\tools',
      ProgramFiles: 'C:\\Program Files',
      CI: '1',
    },
    network: false,
    home,
    exists: present('D:\\tools'),
  };

  it('resolves the shell to its full path and carries the policy', () => {
    const request = buildHelperRequest(input);
    expect(request.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(request.args).toEqual(['-NoLogo', '-Command', 'dir']);
    expect(request).toMatchObject({
      id: 4,
      cwd,
      network: false,
      readWrite: [cwd],
      readOnly: ['D:\\tools', `${cwd}\\.git`],
    });
    expect(request.env.CI).toBe('1');
    expect(request.limits.memoryMb).toBeGreaterThan(0);
    expect(request.limits.processes).toBeGreaterThan(0);
  });

  it('selects toolchains from case-insensitive Windows environment keys without changing PATH order', () => {
    const path = 'C:\\Program Files\\nodejs;C:\\WINDOWS\\system32;C:\\Program Files (x86)\\Python';
    const request = buildHelperRequest({
      ...input,
      env: { pAtH: path, PROGRAMFILES: 'C:\\Program Files', 'programfiles(x86)': 'C:\\Program Files (x86)' },
      exists: () => true,
    });
    expect(request.toolchains).toEqual(['C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\Python']);
    expect(request.env.pAtH).toBe(path);
    expect(request.readWrite).toEqual([cwd]);
  });

  it('passes the network decision through', () => {
    expect(buildHelperRequest({ ...input, network: true }).network).toBe(true);
  });

  it('marks a workspace folder so the helper can live under application data (#87)', () => {
    expect(buildHelperRequest({ ...input, workspace: true }).workspace).toBe(true);
    expect(buildHelperRequest(input).workspace).toBeUndefined();
  });

  it('drops undefined environment values', () => {
    const request = buildHelperRequest({ ...input, env: { ...input.env, GONE: undefined } });
    expect('GONE' in request.env).toBe(false);
  });
});

describe('helper discovery and events', () => {
  it('prefers an override, then the packaged resources, then the Cargo output', () => {
    expect(helperCandidates('C:\\app\\resources', 'C:\\app\\out\\main', 'C:\\dev', 'X:\\h.exe', false)).toEqual([
      'X:\\h.exe',
      'C:\\app\\resources\\sandbox-helper.exe',
      'C:\\app\\native\\sandbox-helper\\target\\release\\sandbox-helper.exe',
      'C:\\dev\\native\\sandbox-helper\\target\\release\\sandbox-helper.exe',
    ]);
    expect(helperCandidates(undefined, 'C:\\a\\out\\main', 'C:\\dev', undefined, false)).toHaveLength(2);
  });

  it('only trusts the bundled helper in a packaged build (#149)', () => {
    expect(helperCandidates('C:\\app\\resources', 'C:\\app\\out\\main', 'C:\\dev', 'X:\\h.exe', true)).toEqual([
      'C:\\app\\resources\\sandbox-helper.exe',
    ]);
    expect(helperCandidates(undefined, 'C:\\app\\out\\main', 'C:\\dev', 'X:\\h.exe', true)).toEqual([]);
  });

  it('detects a packaged build the way Electron does', () => {
    expect(isPackagedElectron(undefined, 'C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(false);
    expect(isPackagedElectron('38.0.0', 'C:\\proj\\node_modules\\electron\\dist\\electron.exe', 'win32')).toBe(false);
    expect(isPackagedElectron('38.0.0', 'C:\\Users\\me\\AppData\\Local\\Programs\\Patch\\Patch.exe', 'win32')).toBe(
      true,
    );
    expect(isPackagedElectron('38.0.0', '/proj/node_modules/electron/dist/electron', 'linux')).toBe(false);
    expect(isPackagedElectron('38.0.0', '/opt/Patch/patch', 'linux')).toBe(true);
  });

  it('parses events and ignores noise', () => {
    expect(parseHelperEvent('{"type":"exit","id":1,"exitCode":0,"timedOut":false}')).toMatchObject({ type: 'exit' });
    expect(parseHelperEvent('hello')).toBeNull();
    expect(parseHelperEvent('{"id":1}')).toBeNull();
    expect(parseHelperEvent('null')).toBeNull();
  });
});

// A stand-in for sandbox-helper.exe: the first line of stdin is the request, its "command" picks the behaviour.
const FAKE_HELPER = `
const readline = require('node:readline');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let request;
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.kill) { out({ type: 'exit', id: message.id, exitCode: 1, timedOut: false }); setTimeout(() => process.exit(0), 100); }
  request = message;
  out({ type: 'started', id: request.id, pid: 4242 });
  if (request.command === 'echo') {
    out({ type: 'stdout', id: request.id, data: 'hello ' });
    out({ type: 'stderr', id: request.id, data: 'warn\\n' });
    out({ type: 'stdout', id: request.id, data: request.args.join(' ') });
    out({ type: 'exit', id: request.id, exitCode: 3, timedOut: false });
    setTimeout(() => process.exit(0), 100);
  }
  // Like the real helper, it keeps waiting for input after an error and only exits once stdin closes.
  if (request.command === 'error') out({ type: 'error', id: request.id, message: 'no container' });
  if (request.command === 'crash') process.exit(9);
  if (request.command === 'log') {
    out({ type: 'log', code: 'recovery-failed', record: 'patch.sbx.1', failures: 2 });
    out({ type: 'exit', id: request.id, exitCode: 0, timedOut: false });
  }
});
rl.on('close', () => {
  if (request?.command === 'error' && request.args[0]) require('node:fs').writeFileSync(request.args[0], 'closed');
  process.exit(0);
});
`;

describe('HelperProcess', () => {
  let dir: string;
  let script: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-fake-helper-'));
    script = join(dir, 'helper.js');
    writeFileSync(script, FAKE_HELPER);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const request = (command: string, args: string[] = []): HelperRequest => ({
    ...buildHelperRequest({
      id: 7,
      shell: { file: 'C:\\x.exe', args },
      cwd,
      env: {},
      network: false,
      home,
      exists: () => false,
    }),
    command,
  });
  const start = (command: string, args?: string[]) =>
    new HelperProcess(process.execPath, request(command, args), [script]);

  it('streams output and reports the exit code', async () => {
    const child = start('echo', ['a', 'b']);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk));
    const [code] = (await once(child, 'close')) as [number];
    expect(code).toBe(3);
    expect(out).toBe('hello a b');
    expect(err).toBe('warn\n');
    expect(child.pid).toBe(4242);
    expect(child.exitCode).toBe(3);
  });

  it('reports a helper error event as an error, so the command is never run unsandboxed', async () => {
    const marker = join(dir, 'error-closed');
    const child = start('error', [marker]);
    const [error] = (await once(child, 'error')) as [Error];
    expect(error.message).toBe('no container');
    // The helper must not be left running after the failed run.
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 3000 });
  });

  it('writes helper log events to the app log without failing the command', async () => {
    const warn = vi.spyOn(appLog, 'warn').mockImplementation(() => {});
    const child = start('log');
    const errors: Error[] = [];
    child.on('error', (error: Error) => errors.push(error));
    const [code] = (await once(child, 'close')) as [number];
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(warn).toHaveBeenCalledWith('sandbox-helper', 'recovery-failed', { record: 'patch.sbx.1', failures: 2 });
    warn.mockRestore();
  });

  it('reports a helper that dies without an exit event', async () => {
    const child = start('crash');
    const [error] = (await once(child, 'error')) as [Error];
    expect(error.message).toMatch(/stopped before the command finished/);
  });

  it('reports a helper that cannot be started', async () => {
    const child = new HelperProcess(join(dir, 'missing.exe'), request('echo'));
    const [error] = (await once(child, 'error')) as [Error];
    expect(error.message).toMatch(/Could not start the sandbox helper/);
  });

  it('asks the helper to kill the command when stopped', async () => {
    const child = start('hang');
    await once(child, 'spawn');
    child.stopTree();
    const [code] = (await once(child, 'close')) as [number];
    expect(code).toBe(1);
  });
});
