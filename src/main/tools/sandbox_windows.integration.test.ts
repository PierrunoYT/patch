import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildHelperRequest, exceedsEntryLimit, findHelper, HelperProcess, type HelperLimits } from './sandbox_windows';
import { ShellRunner } from './shell';
import { scrubEnv } from './env';

// Runs real commands in a real AppContainer. Skipped unless this is Windows and sandbox-helper.exe has been built
// (npm run build:sandbox).
const helper = process.platform === 'win32' ? findHelper() : null;
const config = { mode: 'auto' as const, network: 'off' as const, image: '', allowedHosts: '' };
// libuv < 1.53 generates child-process pipe names outside AppContainer's required LOCAL namespace (#101).
const [uvMajor = 0, uvMinor = 0] = process.versions.uv.split('.').map(Number);
const appContainerPipes = uvMajor > 1 || (uvMajor === 1 && uvMinor >= 53);
const noTestIsolation = process.allowedNodeEnvironmentFlags.has('--test-isolation')
  ? '--test-isolation=none'
  : '--experimental-test-isolation=none';
// Hosts the machine can reach, so the "network on" check does not fail only because it is offline.
const NET_PROBE = `node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:4000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('NOCONNECT '+e.code);process.exit(0)});s.on('timeout',()=>{console.log('NOCONNECT timeout');process.exit(0)})"`;

describe.skipIf(!helper)('Windows AppContainer sandbox (real helper)', () => {
  let root: string;
  let outside: string;
  let sandboxNode: string;
  let shell: ShellRunner;
  let sandboxEnv: NodeJS.ProcessEnv;
  let hostCanConnect = false;

  beforeAll(async () => {
    // Under the user-profile temp folder, matching the reported PowerShell failure in #88.
    root = mkdtempSync(join(tmpdir(), 'patch-sbx-proj-'));
    outside = mkdtempSync(join(tmpdir(), 'patch-sbx-secret-'));
    sandboxNode = join(root, 'node.exe');
    copyFileSync(process.execPath, sandboxNode);
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-VALUE');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    sandboxEnv = Object.fromEntries(
      Object.entries(scrubEnv(process.env)).filter(([name]) => name.toLowerCase() !== 'path'),
    );
    // Do not let this real-helper suite grant an AppContainer SID to shared checkout dependencies. Electron aborts
    // during concurrent e2e launches if its install directory has a package SID without ALL APPLICATION PACKAGES.
    sandboxEnv.PATH = root;
    shell = new ShellRunner(
      () => root,
      () => config,
      undefined,
      () => sandboxEnv,
    );
    hostCanConnect = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '1.1.1.1', port: 443, timeout: 4000 });
      socket.on('connect', () => resolve(true));
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => resolve(false));
      setTimeout(() => socket.destroy(), 5000).unref();
    });
  });
  afterAll(() => {
    shell.stopAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reports the sandbox in the approval note', () => {
    const { sandboxed, text } = shell.describe('dir');
    expect(sandboxed).toBe(true);
    expect(text).toMatch(/AppContainer/);
  });

  it('gives a native process cwd access without exposing its siblings or home', async () => {
    const script = join(root, 'native-probe.js');
    writeFileSync(
      script,
      `const fs = require('fs'); const path = require('path');
const [outside, home] = process.argv.slice(2);
const attempt = (run) => { try { return { ok: true, value: run() }; } catch (error) { return { ok: false, code: error.code }; } };
const result = {
  initialCwd: attempt(() => process.cwd()),
  listProject: attempt(() => fs.readdirSync('.').sort()),
  relativeWrite: attempt(() => { fs.writeFileSync('native-probe.txt', 'written'); return true; }),
  readOutside: attempt(() => fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')),
  listHome: attempt(() => fs.readdirSync(home)),
};
console.log(JSON.stringify(result));`,
    );
    const request = buildHelperRequest({
      id: 1,
      shell: { file: sandboxNode, args: ['native-probe.js', outside, homedir()] },
      cwd: root,
      env: sandboxEnv,
      network: false,
      home: homedir(),
      exists: (path) => existsSync(path),
      tooLarge: (path) => exceedsEntryLimit(path),
      limits: { timeoutMs: 5000 },
    });
    const child = new HelperProcess(helper!, request);
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    child.on('error', (value: Error) => (error = value.message));
    await Promise.race([once(child, 'close'), once(child, 'error')]);

    expect(error).toBe('');
    expect(child.exitCode, output).toBe(0);
    const result = JSON.parse(output) as Record<
      'initialCwd' | 'listProject' | 'relativeWrite' | 'readOutside' | 'listHome',
      { ok: boolean; value?: unknown }
    >;
    expect(result.initialCwd.ok).toBe(true);
    expect(result.initialCwd.value).toMatch(/^[P-Z]:\\$/i);
    expect(result.listProject.ok).toBe(true);
    expect(result.relativeWrite).toEqual({ ok: true, value: true });
    expect(readFileSync(join(root, 'native-probe.txt'), 'utf8')).toBe('written');
    expect(result.readOutside.ok).toBe(false);
    expect(result.listHome.ok).toBe(false);
  }, 60_000);

  it('starts PowerShell in a project under the user profile and writes there', async () => {
    const result = await shell.run(
      'Write-Output (Get-Location).Path; Set-Content -Path inside.txt -Value written; Get-Content inside.txt',
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toMatch(/[P-Z]:\\/i);
    expect(result.output).toContain('written');
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toContain('written');
  }, 60_000);

  it('runs node from the PATH inside the container', async () => {
    const result = await shell.run('node -e "console.log(6*7)"');
    expect(result.output).toContain('42');
    expect(result.exitCode).toBe(0);
  }, 60_000);

  describe('dependency-free Node test commands', () => {
    beforeAll(() => {
      const install = dirname(process.execPath);
      cpSync(join(install, 'node_modules', 'npm'), join(root, 'node_modules', 'npm'), { recursive: true });
      for (const name of ['npm.cmd', 'npm.ps1']) copyFileSync(join(install, name), join(root, name));
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      writeFileSync(
        join(root, 'test', 'fixture.test.cjs'),
        "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('sandbox test fixture', () => assert.equal(6 * 7, 42));",
      );
    });

    it.for([
      { command: 'node --test', needsPipes: true },
      { command: 'npm test', needsPipes: true },
      { command: 'npm.cmd test', needsPipes: true },
      { command: `node --test ${noTestIsolation} test/fixture.test.cjs`, needsPipes: false },
      { command: `npm test -- ${noTestIsolation}`, needsPipes: false },
      { command: `npm.cmd test -- ${noTestIsolation}`, needsPipes: false },
    ])('runs $command inside the AppContainer', { timeout: 60_000 }, async ({ command, needsPipes }, { skip }) => {
      if (needsPipes && !appContainerPipes)
        skip(`Node's libuv ${process.versions.uv} lacks the AppContainer pipe fix (libuv #5181; Patch #101).`);
      const result = await shell.run(command, { timeoutSeconds: 30 });
      expect(result.timedOut, result.output).toBe(false);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('sandbox test fixture');
    });
  });

  it('filters the host environment while retaining runtime paths', async () => {
    const script = join(root, 'environment-probe.cjs');
    writeFileSync(
      script,
      `const os = require('node:os');
const fs = require('node:fs'), path = require('node:path');
const names = ['DATABASE_URL', 'PATCH_PRIVATE_VALUE', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'CC', 'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG'];
fs.writeFileSync(path.join(os.tmpdir(), 'temp-probe'), 'PRIVATE-TEMP');
fs.writeFileSync(path.join(process.env.NPM_CONFIG_CACHE, 'cache-probe'), 'PRIVATE-CACHE');
console.log(JSON.stringify({ ...Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])), tmpdir: os.tmpdir(), cwd: process.cwd(), userconfig: fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8') }));`,
    );
    const hostEnv = {
      ...sandboxEnv,
      DATABASE_URL: 'postgres://fixture-user:fixture-password@fixture.invalid/private',
      PATCH_PRIVATE_VALUE: 'patch-private-fixture',
      NODE_OPTIONS: '--trace-warnings',
      SSH_AUTH_SOCK: join(root, 'fixture-agent.sock'),
      CC: 'fixture-compiler',
      NPM_CONFIG_CACHE: outside,
      npm_config_userconfig: join(outside, 'secret.txt'),
    };
    const runner = new ShellRunner(
      () => root,
      () => ({ ...config, envAllowList: 'CC\nNODE_OPTIONS\nNPM_CONFIG_CACHE\nnpm_config_userconfig', path: root }),
      undefined,
      () => hostEnv,
    );
    try {
      const result = await runner.run('node environment-probe.cjs');
      expect(result.exitCode, result.output).toBe(0);
      const environment = JSON.parse(result.output.trim()) as Record<string, string | null>;
      expect(environment).toMatchObject({
        DATABASE_URL: null,
        PATCH_PRIVATE_VALUE: null,
        NODE_OPTIONS: null,
        SSH_AUTH_SOCK: null,
        CC: 'fixture-compiler',
        PATH: expect.stringMatching(/^[P-Z]:\\$/i),
        userconfig: '',
      });
      // The launcher expands 8.3 aliases (RUNNER~1 on CI); compare filesystem identity, not spelling.
      expect(realpathSync.native(environment.HOME!)).toBe(realpathSync.native(homedir()));
      expect(environment.TMPDIR).toMatch(/^[P-Z]:\\tmp$/i);
      expect(environment.NPM_CONFIG_CACHE).toBe(environment.TMPDIR!.replace(/tmp$/, 'npm-cache'));
      expect(environment.NPM_CONFIG_USERCONFIG).toBe(environment.TMPDIR!.replace(/tmp$/, 'npmrc'));
      expect(environment.TMPDIR!.slice(0, 2)).not.toBe(environment.cwd!.slice(0, 2));
      expect(readdirSync(join(process.env.LOCALAPPDATA!, 'Patch', 'sandbox-temp'))).toEqual([]);
      expect(environment.TEMP).toBe(environment.TMP);
      expect(environment.tmpdir).toBe(environment.TEMP);
      expect(isAbsolute(environment.tmpdir!)).toBe(true);
    } finally {
      runner.stopAll();
    }
  }, 60_000);

  it('does not grant the AppContainer access to the shared checkout', () => {
    const request = buildHelperRequest({
      id: 1,
      shell: { file: 'powershell.exe', args: [] },
      cwd: root,
      env: sandboxEnv,
      network: false,
      home: homedir(),
      exists: (path) => existsSync(path),
    });
    const checkout = process.cwd();
    expect(
      request.readOnly.some((path) => {
        const rel = relative(checkout, path);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      }),
    ).toBe(false);
  });

  it('hides files outside the project and the home folder contents', async () => {
    const secret = await shell.run(`Get-Content '${join(outside, 'secret.txt')}'`);
    expect(secret.exitCode).not.toBe(0);
    expect(secret.output).not.toContain('TOP-SECRET-VALUE');
    const listing = await shell.run(`Get-ChildItem '${homedir()}'`);
    expect(listing.exitCode).not.toBe(0);
  }, 60_000);

  it('cannot write outside the project', async () => {
    const target = join(outside, 'planted.txt');
    const result = await shell.run(`Set-Content -Path '${target}' -Value x`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it('hides toolchain credentials while keeping their allowed caches readable', async () => {
    const cases = [
      ['.cargo', 'credentials.toml', 'bin'],
      ['.m2', 'settings.xml', 'repository'],
      ['.gradle', 'gradle.properties', 'caches'],
    ] as const;
    for (const [tool, secret, cache] of cases) {
      mkdirSync(join(outside, tool, cache), { recursive: true });
      writeFileSync(join(outside, tool, secret), 'DUMMY-CREDENTIAL');
      writeFileSync(join(outside, tool, cache, 'fixture'), 'CACHE-READABLE');
    }
    const script = join(root, 'credentials.cjs');
    writeFileSync(
      script,
      `
const fs = require('node:fs');
const path = require('node:path');
const home = ${JSON.stringify(outside)};
console.log(JSON.stringify(${JSON.stringify(cases)}.map(([tool, secret, cache]) => {
  let error;
  try { fs.readFileSync(path.join(home, tool, secret), 'utf8'); } catch (e) { error = e.code; }
  return { error, cache: fs.readFileSync(path.join(home, tool, cache, 'fixture'), 'utf8') };
})));`,
    );
    const request = buildHelperRequest({
      id: 1,
      shell: { file: sandboxNode, args: ['credentials.cjs'] },
      cwd: root,
      env: sandboxEnv,
      network: false,
      home: outside,
      exists: existsSync,
    });
    const child = new HelperProcess(helper!, request);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    try {
      const [code] = await once(child, 'close');
      expect(code, output).toBe(0);
      expect(JSON.parse(output)).toEqual(
        cases.map(() => ({ error: expect.stringMatching(/^(EACCES|EPERM)$/), cache: 'CACHE-READABLE' })),
      );
    } finally {
      child.stopTree();
    }
  }, 60_000);

  it('cannot write git hooks, which later run with the user full rights', async () => {
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    const result = await shell.run(`Set-Content -Path '${hook}' -Value 'echo pwned'`);
    expect(existsSync(hook), result.output).toBe(false);
    const other = await shell.run(`Set-Content -Path '${join(root, '.git', 'config-test')}' -Value ok`);
    expect(other.exitCode).not.toBe(0);
    expect(existsSync(join(root, '.git', 'config-test'))).toBe(false);
  }, 60_000);

  it('blocks the network by default', async ({ skip }) => {
    if (!hostCanConnect) skip('The host cannot reach the control endpoint; network isolation is unverified.');
    const result = await shell.run(NET_PROBE);
    expect(result.output).toContain('NOCONNECT');
    expect(result.output).not.toContain('CONNECTED\r');
  }, 60_000);

  it('allows the network when the command was granted it', async ({ skip }) => {
    if (!hostCanConnect) skip('The host cannot reach the control endpoint.');
    const result = await shell.run(NET_PROBE, { access: { network: true } });
    expect(result.output.trim()).toBe('CONNECTED');
  }, 60_000);

  it('removes its access entries from the project when the command ends', async () => {
    await shell.run('echo done');
    const acl = execFileSync('icacls', [root], { encoding: 'utf8' });
    expect(acl).not.toMatch(/S-1-15-2-/);
  }, 60_000);

  it('does not leave its access entries in an ancestor-protected folder either', async () => {
    const hooks = execFileSync('icacls', [join(root, '.git', 'hooks')], { encoding: 'utf8' });
    expect(hooks).not.toMatch(/S-1-15-2-/);
  });

  it('stops the whole process tree on timeout', async () => {
    const beat = join(root, 'beat.txt');
    const script = join(root, 'spawner.js');
    writeFileSync(
      script,
      `const { spawn } = require('child_process');
// Reuse the sandbox's handles: ignored stdio makes libuv open NUL, which can be denied inside an AppContainer.
spawn(process.execPath, ['-e', "const beat = () => require('fs').appendFileSync('beat.txt', 'x'); beat(); console.log('CHILD-READY'); setInterval(beat, 100)"], { stdio: 'inherit' });
setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    // Start this watchdog before faking the parent's timer; child processes always keep their real clocks.
    const deadline = delay(20_000, undefined, { signal: controller.signal }).then(() => {
      throw new Error('The sandbox child did not become ready or stop within the test deadline');
    });
    let ready!: () => void;
    const heartbeat = new Promise<void>((resolve) => (ready = resolve));
    let output = '';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The helper maps the project to a drive root. Exercise that supported cwd rather than depending on access
    // through the host's absolute temp path (which can also contain an 8.3 alias such as RUNNER~1 on CI).
    const pending = shell.run('.\\node.exe spawner.js', {
      timeoutSeconds: 3,
      signal: controller.signal,
      onOutput: (text) => {
        output += text;
        if (output.includes('CHILD-READY')) ready();
      },
    });
    let finished = false;
    void pending.then(() => (finished = true));
    try {
      await Promise.race([
        heartbeat,
        deadline,
        pending.then((result) => {
          throw new Error(`Command exited before its child was ready: ${result.output}`);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(2999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await Promise.race([pending, deadline]);
      expect(result.timedOut, result.output).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.abort();
      await pending;
    }
    await delay(500);
    const size = existsSync(beat) ? readFileSync(beat, 'utf8').length : 0;
    await delay(1000);
    const after = existsSync(beat) ? readFileSync(beat, 'utf8').length : 0;
    expect(size).toBeGreaterThan(0);
    expect(after).toBe(size);
  }, 60_000);

  it('stops a background command when told to', async () => {
    const entry = shell.startBackground('Start-Sleep -Seconds 120');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(entry.exitCode).toBeUndefined();
    const closed = once(entry.process, 'close');
    shell.stopBackground(entry.id);
    await closed;
  }, 60_000);

  it('does not run the command at all when the helper cannot start it', async () => {
    const broken = new ShellRunner(
      () => join(root, 'does-not-exist'),
      () => config,
    );
    const result = await broken.run('Set-Content ran.txt x');
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  }, 60_000);

  describe('limits', () => {
    const run = async (script: string, limits: Partial<HelperLimits>) => {
      const file = join(root, 'limit.js');
      writeFileSync(file, script);
      const request = buildHelperRequest({
        id: 1,
        shell: { file: sandboxNode, args: ['limit.js'] },
        cwd: root,
        env: sandboxEnv,
        network: false,
        home: homedir(),
        exists: (path) => existsSync(path),
        tooLarge: (path) => exceedsEntryLimit(path),
        limits,
      });
      const child = new HelperProcess(helper!, request);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk));
      await Promise.race([once(child, 'close'), once(child, 'error')]);
      return { output, exitCode: child.exitCode };
    };

    it('refuses more processes than allowed', async () => {
      const { output } = await run(
        `const { spawn } = require('child_process'); let ok = 0, failed = 0;
for (let i = 0; i < 12; i++) { try { const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},3000)'], { stdio: 'ignore' }); c.on('spawn', () => ok++); c.on('error', () => failed++); } catch { failed++; } }
setTimeout(() => { console.log('RESULT ok=' + ok + ' failed=' + failed); process.exit(0); }, 2000);`,
        { processes: 4, memoryMb: 0 },
      );
      const match = /ok=(\d+) failed=(\d+)/.exec(output);
      expect(match, output).not.toBeNull();
      const [, ok, failed] = match!;
      expect(Number(ok)).toBeLessThan(4);
      expect(Number(failed)).toBeGreaterThan(0);
    }, 60_000);

    it('limits memory per process', async () => {
      const { output, exitCode } = await run(
        `try { const b = Buffer.alloc(600 * 1024 * 1024, 1); let s = 0; for (let i = 0; i < b.length; i += 4096) s += b[i]; console.log('ALLOCATED ' + s); } catch (e) { console.log('FAILED ' + e.message); }`,
        { memoryMb: 128, processes: 0 },
      );
      expect(output + String(exitCode)).not.toContain('ALLOCATED');
    }, 60_000);
  });
});

// Dedicated install fixtures never change host tool ACLs or grant access to checkout dependencies.
describe.skipIf(!helper)('Program Files toolchains (real helper)', () => {
  let fixture: string;
  let project: string;
  let programs: string;
  let tools: string;
  let env: NodeJS.ProcessEnv;
  let shell: ShellRunner;
  // Copies of protected installs persist here across commands (#108).
  const stageRoot = join(process.env.LOCALAPPDATA!, 'Patch', 'sandbox-toolchains');
  const cacheRoot = join(stageRoot, 'cache');
  const cacheEntries = () => (existsSync(cacheRoot) ? readdirSync(cacheRoot) : []);
  let cachedBefore: string[];
  // A staged command runs Node from the cache drive: <letter>:\<install hash>-<contents hash>\node.exe.
  const cachedNode = /^[P-Z]:\\[0-9a-f]{16}-[0-9a-f]{16}\\node\.exe$/im;
  const acl = (path: string) => execFileSync('icacls', [path], { encoding: 'utf8' });
  // Whether the DACL has an ALL APPLICATION PACKAGES entry. icacls prints names in the system language, so read
  // the SDDL that `icacls /save` writes (UTF-16), where the group is always the alias AC.
  const allPackages = (path: string) => {
    const saved = join(fixture, `acl-${Date.now()}.txt`);
    execFileSync('icacls', [path, '/save', saved], { windowsHide: true });
    try {
      return /;AC\)/.test(readFileSync(saved, 'utf16le'));
    } finally {
      rmSync(saved, { force: true });
    }
  };
  beforeAll(() => {
    cachedBefore = cacheEntries();
    fixture = mkdtempSync(join(tmpdir(), 'patch-toolchain-'));
    project = join(fixture, 'project');
    programs = join(fixture, 'Program Files');
    tools = join(programs, 'nodejs');
    // Sandboxed commands need the project's own regular .git directory (#98).
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
    mkdirSync(tools, { recursive: true });
    copyFileSync(process.execPath, join(tools, 'node.exe'));
    writeFileSync(join(tools, 'marker.txt'), 'READ-ONLY-TOOL');
    writeFileSync(join(programs, 'private.txt'), 'SIBLING-SECRET');
    writeFileSync(
      join(project, 'assert.cjs'),
      `require('node:assert/strict').equal(6 * 7, 42); console.log('ASSERT-PASS')`,
    );
    env = Object.fromEntries(
      Object.entries(scrubEnv(process.env)).filter(
        ([key]) => !['path', 'programfiles', 'programfiles(x86)', 'programw6432'].includes(key.toLowerCase()),
      ),
    );
    env.pAtH = `${tools};${process.env.SystemRoot}\\System32`;
    env.PROGRAMFILES = programs;
    // Protected ACLs mirror the Node installer and force a private copy even for a fixture owned by this user.
    execFileSync('icacls', [tools, '/inheritance:r']);
    const user = execFileSync(join(process.env.SystemRoot!, 'System32', 'whoami.exe'), [], { encoding: 'utf8' }).trim();
    execFileSync('icacls', [tools, '/grant:r', `${user}:(OI)(CI)(F)`]);
    expect(allPackages(tools)).toBe(false);
    shell = new ShellRunner(
      () => project,
      () => config,
      undefined,
      () => env,
    );
  });
  afterAll(() => {
    shell.stopAll();
    rmSync(fixture, { recursive: true, force: true });
    // Fixture installs live in a temp folder that is now gone; their copies would only expire after 30 days.
    for (const name of cacheEntries().filter((entry) => !cachedBefore.includes(entry)))
      rmSync(join(cacheRoot, name), { recursive: true, force: true });
  });
  it('stages a protected installation read-only and runs Node plus dependency-free assertions', async () => {
    const original = acl(tools);
    const started = Date.now();
    const version = await shell.run('node --version');
    expect(version.exitCode, version.output).toBe(0);
    expect(version.output.trim()).toBe(process.version);
    const probe = join(project, 'tool-probe.cjs');
    writeFileSync(
      probe,
      `const fs=require('node:fs'), path=require('node:path');
const tool=path.dirname(process.execPath);
const attempt=f=>{try{f();return true}catch{return false}};
console.log(JSON.stringify({exe:process.execPath,marker:fs.readFileSync(path.join(tool,'marker.txt'),'utf8'),
write:attempt(()=>fs.writeFileSync(path.join(tool,'planted.txt'),'x')),
sibling:attempt(()=>fs.readFileSync(${JSON.stringify(join(programs, 'private.txt'))})),
home:attempt(()=>fs.readdirSync(${JSON.stringify(homedir())}))}));`,
    );
    const test = await shell.run(
      'node assert.cjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node tool-probe.cjs',
    );
    expect(test.exitCode, test.output).toBe(0);
    expect(test.output).toContain('ASSERT-PASS');
    const result = JSON.parse(test.output.trim().split(/\r?\n/).at(-1)!) as {
      exe: string;
      marker: string;
      write: boolean;
      sibling: boolean;
      home: boolean;
    };
    expect(result.exe).toMatch(cachedNode);
    // The cached copy is readable and executable for the container, never writable.
    expect(result).toMatchObject({ marker: 'READ-ONLY-TOOL', write: false, sibling: false, home: false });
    expect(acl(tools)).toBe(original);
    expect(existsSync(join(tools, 'planted.txt'))).toBe(false);
    const key = result.exe.split('\\')[1]!;
    expect(existsSync(join(cacheRoot, key, 'planted.txt'))).toBe(false);
    expect(readdirSync(stageRoot).filter((name) => name.startsWith('patch.sbx.'))).toEqual([]);
    console.info(
      `Protected Node fixture: version + assertion/isolation probes completed in ${Date.now() - started} ms`,
    );
  }, 60_000);

  it('reuses the cached copy for the next command and copies again after an upgrade (#108)', async () => {
    const execPath = async () => {
      const result = await shell.run('node -p process.execPath');
      expect(result.exitCode, result.output).toBe(0);
      return result.output.trim().split(/\r?\n/).at(-1)!;
    };
    const first = await execPath();
    expect(first).toMatch(cachedNode);
    const key = first.split('\\')[1]!;
    const copied = statSync(join(cacheRoot, key, 'node.exe')).birthtimeMs;

    let started = performance.now();
    execFileSync(join(tools, 'node.exe'), ['-p', 'process.execPath']);
    const host = performance.now() - started;
    started = performance.now();
    expect(await execPath()).toBe(first);
    const sandboxed = performance.now() - started;
    // Same copy, not a new one with the same name.
    expect(statSync(join(cacheRoot, key, 'node.exe')).birthtimeMs).toBe(copied);
    console.info(`Cached Node: sandboxed ${Math.round(sandboxed)} ms, unsandboxed ${Math.round(host)} ms`);

    // Any changed entry is an upgrade: copy again under a new name, and drop the copy nothing uses any more.
    writeFileSync(join(tools, 'marker.txt'), 'READ-ONLY-TOOL v2');
    const upgraded = await execPath();
    expect(upgraded).toMatch(cachedNode);
    const upgradedKey = upgraded.split('\\')[1]!;
    expect(upgradedKey).not.toBe(key);
    expect(upgradedKey.split('-')[0]).toBe(key.split('-')[0]);
    expect(readFileSync(join(cacheRoot, upgradedKey, 'marker.txt'), 'utf8')).toBe('READ-ONLY-TOOL v2');
    expect(existsSync(join(cacheRoot, key))).toBe(false);
    expect(readdirSync(stageRoot).filter((name) => name.startsWith('patch.sbx.'))).toEqual([]);
  }, 60_000);

  it('does not modify or stage a package-readable installation', async () => {
    // Install controls get explicit inherited package RX rights, including the executable.
    execFileSync('icacls', [tools, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)']);
    const original = acl(tools);
    // Map only the package-readable fixture itself, bypassing inaccessible user-profile ancestors.
    const used = execFileSync('subst', { encoding: 'utf8' });
    const drive = ['P:', 'Q:', 'R:', 'S:'].find((value) => !used.includes(`${value}\\`));
    expect(drive).toBeDefined();
    execFileSync('subst', [drive!, tools]);
    const request = buildHelperRequest({
      id: 1,
      shell: { file: `${drive}\\node.exe`, args: ['--version'] },
      cwd: project,
      env,
      home: join(fixture, 'home'),
      network: false,
      exists: existsSync,
      tooLarge: exceedsEntryLimit,
      limits: { timeoutMs: 5000 },
    });
    const child = new HelperProcess(helper!, request);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    try {
      const [code] = await once(child, 'close');
      expect(code, output).toBe(0);
      expect(output.trim()).toBe(process.version);
      expect(acl(tools)).toBe(original);
    } finally {
      child.stopTree();
      execFileSync('subst', [drive!, '/D']);
    }
  }, 60_000);

  it('uses only a temporary read-execute grant when an unprotected install can inherit it', async () => {
    const grantTools = join(programs, 'grant-node');
    mkdirSync(grantTools);
    copyFileSync(process.execPath, join(grantTools, 'node.exe'));
    // Normalize this disposable fixture to Windows' automatic inheritance model before taking the baseline: CI's
    // temp tree can have legacy explicit ACEs that the first edit legitimately reclassifies as inherited. Include a
    // distinct explicit grant so the revoke must preserve more than recomputed parent permissions.
    execFileSync('icacls', [grantTools, '/inheritance:e', '/grant', '*S-1-1-0:(R)']);
    expect(allPackages(grantTools)).toBe(false);
    const original = acl(grantTools);
    const drive = ['T:', 'U:', 'V:', 'W:'].find(
      (value) => !execFileSync('subst', { encoding: 'utf8' }).includes(`${value}\\`),
    );
    expect(drive).toBeDefined();
    execFileSync('subst', [drive!, grantTools]);
    const request = buildHelperRequest({
      id: 1,
      shell: {
        file: `${drive}\\node.exe`,
        args: [
          '-e',
          `const fs=require('fs'); console.log(process.execPath); try { fs.writeFileSync(${JSON.stringify(`${drive}\\denied.txt`)},'x'); process.exit(2) } catch { console.log('WRITE-DENIED') }`,
        ],
      },
      cwd: project,
      env: { ...env, pAtH: grantTools },
      home: join(fixture, 'empty-home'),
      network: false,
      exists: existsSync,
      limits: { timeoutMs: 5000 },
    });
    const child = new HelperProcess(helper!, request);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    try {
      const [code] = await once(child, 'close');
      expect(code, output).toBe(0);
      expect(output).toContain(`${drive}\\node.exe`);
      expect(output).toContain('WRITE-DENIED');
      expect(acl(grantTools)).toBe(original);
      expect(existsSync(join(grantTools, 'denied.txt'))).toBe(false);
    } finally {
      child.stopTree();
      execFileSync('subst', [drive!, '/D']);
    }
  }, 60_000);

  it('leaves out a toolchain with an escaping junction, says why, and still runs the command', async () => {
    const linked = join(programs, 'linked');
    mkdirSync(linked);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(project, join(linked, 'escape'), 'junction');
    const original = acl(linked);
    const runner = new ShellRunner(
      () => project,
      () => config,
      undefined,
      () => ({ ...env, pAtH: `${linked};${process.env.SystemRoot}\\System32` }),
    );
    // Skipping a toolchain only withholds access, so the command runs as it did before toolchain support.
    const result = await runner.run(`Write-Output RAN; $env:PATH`);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('RAN');
    expect(result.output).toMatch(/not readable in this command: .*linked: .*(reparse point|escaping path)/i);
    // Neither granted nor copied: PATH still names the original folder, and its ACL is unchanged.
    expect(result.output).toContain(linked);
    expect(result.output).not.toMatch(/[P-Z]:\\[0-9a-f]{16}-/i);
    expect(acl(linked)).toBe(original);
  }, 60_000);

  it('stops a staged background command and removes its private staging, keeping the cached copy', async () => {
    // Remove the readable control ACE so this test must stage again.
    execFileSync('icacls', [tools, '/remove:g', '*S-1-15-2-1']);
    const entry = shell.startBackground('node -e "console.log(process.execPath); setInterval(()=>{},1000)"');
    try {
      const until = Date.now() + 30_000;
      while (!entry.output.includes('node.exe') && Date.now() < until && entry.exitCode === undefined)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(entry.output).toMatch(cachedNode);
      const closed = once(entry.process, 'close');
      shell.stopBackground(entry.id);
      await closed;
      expect(readdirSync(stageRoot).filter((name) => name.startsWith('patch.sbx.'))).toEqual([]);
      expect(existsSync(join(cacheRoot, entry.output.match(cachedNode)![0].split('\\')[1]!))).toBe(true);
      expect(acl(tools)).not.toMatch(/S-1-15-2-|patch\.sbx\./);
    } finally {
      shell.stopAll();
    }
  }, 60_000);

  it('recovers a forcibly killed staging helper while preserving a live staged command', async () => {
    const local = join(fixture, 'recovery-local');
    const stagedRoot = join(local, 'Patch', 'sandbox-toolchains');
    const temporaryRoot = join(local, 'Patch', 'sandbox-temp');
    // Private staging folders only; the shared cache folder outlives every run.
    const staging = () => readdirSync(stagedRoot).filter((name) => name.startsWith('patch.sbx.'));
    execFileSync('icacls', [tools, '/remove:g', '*S-1-15-2-1']);
    const request = buildHelperRequest({
      id: 1,
      shell: {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'],
      },
      cwd: project,
      env,
      home: join(fixture, 'empty-home'),
      network: false,
      exists: existsSync,
    });
    const helperEnv = { ...process.env, LOCALAPPDATA: local };
    const recover = async () => {
      const child = spawn(helper!, [], { env: helperEnv, windowsHide: true });
      const closed = once(child, 'close');
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk));
      child.stdin.end();
      await closed;
      expect(child.exitCode, output).toBe(0);
      expect(output).toBe('');
    };
    const child = spawn(helper!, [], { env: helperEnv, windowsHide: true });
    const closed = once(child, 'close');
    try {
      const started = new Promise<void>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk;
          if (output.includes('"type":"started"')) resolve();
          if (output.includes('"type":"error"')) reject(new Error(output));
        });
        child.on('error', reject);
        child.on('close', () => reject(new Error('helper closed before start')));
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      await started;
      expect(staging()).toHaveLength(1);
      expect(readdirSync(join(stagedRoot, 'cache'))).toHaveLength(1);
      expect(readdirSync(temporaryRoot)).toHaveLength(1);
      const liveMapping = execFileSync('subst', { encoding: 'utf8' })
        .split(/\r?\n/)
        .find((line) => line.includes(stagedRoot));
      expect(liveMapping).toBeDefined();
      const temporaryMapping = execFileSync('subst', { encoding: 'utf8' })
        .split(/\r?\n/)
        .find((line) => line.includes(temporaryRoot));
      expect(temporaryMapping).toBeDefined();
      await recover();
      expect(staging()).toHaveLength(1);
      expect(readdirSync(temporaryRoot)).toHaveLength(1);
      expect(execFileSync('subst', { encoding: 'utf8' })).toContain(liveMapping!);
      expect(execFileSync('subst', { encoding: 'utf8' })).toContain(temporaryMapping!);
      child.kill();
      await closed;
      await recover();
      expect(staging()).toEqual([]);
      // Recovery removes the run, not the shared copy another run may be using.
      expect(readdirSync(join(stagedRoot, 'cache'))).toHaveLength(1);
      expect(readdirSync(temporaryRoot)).toEqual([]);
      expect(execFileSync('subst', { encoding: 'utf8' })).not.toContain(liveMapping!);
      expect(execFileSync('subst', { encoding: 'utf8' })).not.toContain(temporaryMapping!);
      expect(readdirSync(join(local, 'Patch', 'sandbox-recovery'))).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      await recover();
      // Fallback for a failed assertion: remove only this fixture's exact project mapping.
      for (const line of execFileSync('subst', { encoding: 'utf8' }).split(/\r?\n/)) {
        const mapping = /^([P-Z]:)\\: => (.+)$/.exec(line);
        if (mapping?.[2]?.toLowerCase() === project.toLowerCase()) execFileSync('subst', [mapping[1]!, '/D']);
      }
    }
  }, 60_000);

  it('runs package-readable host Git and Python without changing their ACLs', async ({ skip }) => {
    const programRoot = process.env.ProgramFiles;
    const cases = [
      { tool: join(programRoot || '', 'Git', 'cmd'), command: 'git --version', pattern: /git version/ },
      { tool: join(programRoot || '', 'Python312'), command: 'python --version', pattern: /Python 3/ },
    ];
    const available = cases.filter((value) => existsSync(value.tool));
    if (!available.length) skip('No host Program Files Git/Python installs available.');
    for (const value of available) {
      const original = acl(value.tool);
      expect(allPackages(value.tool)).toBe(true);
      const runner = new ShellRunner(
        () => project,
        () => config,
        undefined,
        () => ({ ...env, PROGRAMFILES: programRoot, pAtH: value.tool }),
      );
      const result = await runner.run(value.command);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toMatch(value.pattern);
      expect(acl(value.tool)).toBe(original);
    }
  }, 60_000);

  it('runs the official host Node installation without changing its ACL', async ({ skip }) => {
    const official = dirname(process.execPath);
    const programRoot = process.env.ProgramFiles;
    if (!programRoot || relative(programRoot, official).startsWith('..'))
      skip('Host Node is not a Program Files installation.');
    const original = acl(official);
    const hostEnv = { ...env, PROGRAMFILES: programRoot, pAtH: official };
    const runner = new ShellRunner(
      () => project,
      () => config,
      undefined,
      () => hostEnv,
    );
    const started = Date.now();
    const result = await runner.run('node --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node assert.cjs');
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain(process.version);
    expect(result.output).toContain('ASSERT-PASS');
    expect(acl(official)).toBe(original);
    console.info(`Official Node staging + assertions: ${Date.now() - started} ms`);
    // The acceptance check of #108: the next command reuses the cached copy instead of copying ~110 MiB again.
    let begun = performance.now();
    execFileSync(process.execPath, ['--version']);
    const host = performance.now() - begun;
    begun = performance.now();
    const again = await runner.run('node --version');
    const sandboxed = performance.now() - begun;
    expect(again.exitCode, again.output).toBe(0);
    console.info(`Official Node again: sandboxed ${Math.round(sandboxed)} ms, unsandboxed ${Math.round(host)} ms`);
  }, 60_000);
});

describe.skipIf(!helper)('Windows sandbox recovery (real helper)', () => {
  it.each(['normal exit', 'forced termination'])(
    'keeps metadata protected through an overlapping helper %s',
    async (exit) => {
      const fixture = mkdtempSync(join(tmpdir(), 'patch-sbx-recovery-'));
      const project = join(fixture, 'project');
      const tools = join(fixture, 'tools');
      const hooks = join(project, '.git', 'hooks');
      const local = join(fixture, 'local');
      const journal = join(local, 'Patch', 'sandbox-recovery');
      mkdirSync(hooks, { recursive: true });
      // Normalize this disposable fixture to Windows' automatic inheritance model before taking the baseline.
      // CI's temp tree can have legacy ACEs that Windows legitimately reclassifies as inherited on the first edit.
      // Include a distinct explicit grant so recovery must preserve more than just recomputed parent permissions.
      execFileSync('icacls', [hooks, '/inheritance:e', '/grant', '*S-1-1-0:(R)']);
      mkdirSync(tools);
      writeFileSync(join(tools, 'nested.txt'), 'tool');
      const request = buildHelperRequest({
        id: 1,
        shell: {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'],
        },
        cwd: project,
        env: scrubEnv(process.env),
        home: local,
        network: false,
        exists: () => false,
      });
      request.readOnly = [tools];
      const env = { ...process.env, LOCALAPPDATA: local };
      const recover = async () => {
        const child = spawn(helper!, [], { env, windowsHide: true });
        const closed = once(child, 'close');
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk));
        child.stdin.end();
        await closed;
        expect(output).toBe('');
        expect(child.exitCode).toBe(0);
      };
      const acl = (path: string) => execFileSync('icacls', [path], { encoding: 'utf8' });
      const projectMappings = () =>
        execFileSync('subst', { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter((line) => /^([P-Z]:)\\: => (.+)$/.exec(line)?.[2]?.toLowerCase() === project.toLowerCase());
      const originalHooksAcl = acl(hooks);
      expect(originalHooksAcl).toContain('(I)');
      expect(originalHooksAcl).toContain(':(R)');
      const child = spawn(helper!, [], { env, windowsHide: true });
      const closed = once(child, 'close');
      let writer: ReturnType<typeof spawn> | undefined;
      let writerClosed: Promise<unknown> | undefined;
      let writerOutput = '';
      try {
        const started = new Promise<void>((resolve, reject) => {
          let output = '';
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk;
            if (output.includes('"type":"started"')) resolve();
            if (output.includes('"type":"error"')) reject(new Error(output));
          });
          child.on('error', reject);
          child.on('close', () => reject(new Error('helper closed before starting')));
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
        await started;
        const firstMapping = projectMappings();
        expect(firstMapping).toHaveLength(1);
        const liveAcl = acl(tools);
        expect(liveAcl).toMatch(/patch\.sbx\.|S-1-15-2-/);
        expect(readdirSync(journal)).toHaveLength(1);
        await recover();
        expect(acl(tools)).toBe(liveAcl);
        expect(readdirSync(journal)).toHaveLength(1);

        writer = spawn(helper!, [], { env, windowsHide: true });
        writerClosed = once(writer, 'close');
        writer.stdout!.on('data', (chunk: Buffer) => (writerOutput += chunk));
        writer.stdin!.write(
          `${JSON.stringify({
            ...request,
            id: 2,
            readOnly: [join(project, '.git')],
            args: [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              // Both a metadata file and a hook (#100: hooks later run with the user's full rights).
              "while ($true) { foreach ($target in '.git/config.worktree', '.git/hooks/pre-commit') { try { [IO.File]::WriteAllText([IO.Path]::Combine([Environment]::CurrentDirectory, $target), 'bad'); [Console]::WriteLine('WRITABLE ' + $target) } catch [UnauthorizedAccessException] { [Console]::WriteLine('BLOCKED') } catch { [Console]::WriteLine($_.Exception.ToString()); exit 1 } }; [Threading.Thread]::Sleep(100) }",
            ],
          })}\n`,
        );
        // The first attempt includes process/runtime startup, not just the loop's 100 ms interval.
        await expect.poll(() => writerOutput, { timeout: 10_000 }).toContain('BLOCKED');
        expect(readdirSync(journal)).toHaveLength(2);
        const writerMapping = projectMappings().filter((line) => !firstMapping.includes(line));
        expect(writerMapping).toHaveLength(1);

        // ChildProcess.kill is TerminateProcess on Windows: no Rust destructors can run.
        if (exit === 'forced termination') child.kill();
        else child.stdin.end(`${JSON.stringify({ id: 1, kill: true })}\n`);
        await closed;
        if (exit === 'forced termination') expect(acl(tools)).toBe(liveAcl);
        else expect(acl(tools)).not.toMatch(/patch\.sbx\.|S-1-15-2-/);
        await recover();
        expect(projectMappings()).toEqual(writerMapping);
        await recover();
        expect(projectMappings()).toEqual(writerMapping);
        const attempts = (writerOutput.match(/BLOCKED/g) ?? []).length;
        await expect.poll(() => (writerOutput.match(/BLOCKED/g) ?? []).length).toBeGreaterThan(attempts + 2);
        expect(writerOutput).not.toContain('WRITABLE');
        expect(existsSync(join(project, '.git', 'config.worktree'))).toBe(false);
        expect(existsSync(join(hooks, 'pre-commit'))).toBe(false);
        expect(readdirSync(journal)).toHaveLength(1);
        writer.stdin!.end(`${JSON.stringify({ id: 2, kill: true })}\n`);
        await writerClosed;
        for (const path of [project, tools, join(tools, 'nested.txt'), hooks])
          expect(acl(path)).not.toMatch(/patch\.sbx\.|S-1-15-2-/);
        expect(readdirSync(journal)).toEqual([]);
        expect(projectMappings()).toEqual([]);
        // Windows recomputes inherited entries from the parent. Explicit entries must stay unchanged,
        // rather than accumulating the copies produced when inheritance was temporarily protected.
        const explicit = (text: string) => text.split(/\r?\n/).filter((line) => !line.includes('(I)'));
        expect(explicit(acl(hooks))).toEqual(explicit(originalHooksAcl));
        expect(acl(hooks)).toContain('(I)');
      } finally {
        if (writer?.exitCode === null) writer.kill();
        if (writerClosed) await writerClosed;
        if (child.exitCode === null) child.kill();
        await closed;
        await recover();
        // Fallback for a failed assertion: successful cleanup and recovery are checked above before teardown.
        // Remove only this fixture's exact project mapping so a failed test cannot pollute later runs.
        for (const line of execFileSync('subst', { encoding: 'utf8' }).split(/\r?\n/)) {
          const mapping = /^([P-Z]:)\\: => (.+)$/.exec(line);
          if (mapping?.[2]?.toLowerCase() === project.toLowerCase()) execFileSync('subst', [mapping[1]!, '/D']);
        }
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
