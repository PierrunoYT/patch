import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildHelperRequest,
  exceedsEntryLimit,
  helperCandidates,
  HelperProcess,
  parseHelperEvent,
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

  it('makes only the project writable and refuses writes to git hooks', () => {
    const policy = windowsPolicy({ ...base, exists: () => false });
    expect(policy.readWrite).toEqual([cwd]);
    expect(policy.denyWrite).toEqual([`${cwd}\\.git\\hooks`]);
  });

  it('opens toolchain folders under the home folder read-only, and never credentials', () => {
    const policy = windowsPolicy({
      ...base,
      exists: present(`${home}\\.cargo\\bin`, `${home}\\.ssh`, `${home}\\.gitconfig`, `${home}\\AppData\\Roaming\\npm`),
    });
    expect(policy.readOnly).toEqual([`${home}\\.cargo\\bin`, `${home}\\AppData\\Roaming\\npm`]);
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
    expect(policy.readOnly).toEqual(safePaths.map((rel) => `${home}\\${rel}`));
  });

  it('adds PATH folders that exist, skipping system folders every container can already read', () => {
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
    expect(policy.readOnly).toEqual(['C:\\nvm4w\\nodejs']);
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
    expect(policy.readOnly).toEqual([`${home}\\.cargo\\bin`]);
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
    expect(request).toMatchObject({ id: 4, cwd, network: false, readWrite: [cwd], readOnly: ['D:\\tools'] });
    expect(request.env.CI).toBe('1');
    expect(request.limits.memoryMb).toBeGreaterThan(0);
    expect(request.limits.processes).toBeGreaterThan(0);
  });

  it('passes the network decision through', () => {
    expect(buildHelperRequest({ ...input, network: true }).network).toBe(true);
  });

  it('drops undefined environment values', () => {
    const request = buildHelperRequest({ ...input, env: { ...input.env, GONE: undefined } });
    expect('GONE' in request.env).toBe(false);
  });
});

describe('helper discovery and events', () => {
  it('prefers an override, then the packaged resources, then the Cargo output', () => {
    expect(helperCandidates('C:\\app\\resources', 'C:\\app\\out\\main', 'C:\\dev', 'X:\\h.exe')).toEqual([
      'X:\\h.exe',
      'C:\\app\\resources\\sandbox-helper.exe',
      'C:\\app\\native\\sandbox-helper\\target\\release\\sandbox-helper.exe',
      'C:\\dev\\native\\sandbox-helper\\target\\release\\sandbox-helper.exe',
    ]);
    expect(helperCandidates(undefined, 'C:\\a\\out\\main', 'C:\\dev')).toHaveLength(2);
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
  if (request.command === 'error') { out({ type: 'error', id: request.id, message: 'no container' }); setTimeout(() => process.exit(0), 100); }
  if (request.command === 'crash') process.exit(9);
});
rl.on('close', () => process.exit(0));
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
    const child = start('error');
    const [error] = (await once(child, 'error')) as [Error];
    expect(error.message).toBe('no container');
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
