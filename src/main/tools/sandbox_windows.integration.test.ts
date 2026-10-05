import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHelperRequest, exceedsEntryLimit, findHelper, HelperProcess, type HelperLimits } from './sandbox_windows';
import { ShellRunner } from './shell';
import { scrubEnv } from './env';

// Runs real commands in a real AppContainer. Skipped unless this is Windows and sandbox-helper.exe has been built
// (npm run build:sandbox).
const helper = process.platform === 'win32' ? findHelper() : null;
const config = { mode: 'auto' as const, network: 'off' as const, image: '', allowedHosts: '' };
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
    expect(other.exitCode).toBe(0);
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
spawn(process.execPath, ['-e', "setInterval(() => require('fs').appendFileSync('beat.txt', 'x'), 100)"], { stdio: 'inherit' });
setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    // The helper maps the project to a drive root. Exercise that supported cwd rather than depending on access
    // through the host's absolute temp path (which can also contain an 8.3 alias such as RUNNER~1 on CI).
    const result = await shell.run('.\\node.exe spawner.js', { timeoutSeconds: 3 });
    expect(result.timedOut, result.output).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const size = existsSync(beat) ? readFileSync(beat, 'utf8').length : 0;
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
  const acl = (path: string) => execFileSync('icacls', [path], { encoding: 'utf8' });
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'patch-toolchain-'));
    project = join(fixture, 'project');
    programs = join(fixture, 'Program Files');
    tools = join(programs, 'nodejs');
    mkdirSync(project);
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
    expect(acl(tools)).not.toMatch(/APPLICATION PACKAGES|S-1-15-2-1/);
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
    expect(result.exe).toMatch(/^[P-Z]:\\0\\node.exe$/i);
    expect(result).toMatchObject({ marker: 'READ-ONLY-TOOL', write: false, sibling: false, home: false });
    expect(acl(tools)).toBe(original);
    expect(existsSync(join(tools, 'planted.txt'))).toBe(false);
    const stageRoot = join(process.env.LOCALAPPDATA!, 'Patch', 'sandbox-toolchains');
    expect(readdirSync(stageRoot).filter((name) => name.startsWith('patch.sbx.'))).toEqual([]);
    console.info(
      `Protected Node fixture: version + assertion/isolation probes completed in ${Date.now() - started} ms`,
    );
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
    expect(acl(grantTools)).not.toMatch(/APPLICATION PACKAGES|S-1-15-2-1/);
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

  it('fails closed for escaping junctions without executing the command', async () => {
    const linked = join(programs, 'linked');
    mkdirSync(linked);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(project, join(linked, 'escape'), 'junction');
    const runner = new ShellRunner(
      () => project,
      () => config,
      undefined,
      () => ({ ...env, pAtH: linked }),
    );
    const result = await runner.run('Set-Content should-not-run.txt planted');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/reparse point|escaping path/);
    expect(existsSync(join(project, 'should-not-run.txt'))).toBe(false);
  }, 60_000);

  it('stops a staged background command and cleans its read-only copy', async () => {
    // Remove the readable control ACE so this test must stage again.
    execFileSync('icacls', [tools, '/remove:g', '*S-1-15-2-1']);
    const entry = shell.startBackground('node -e "console.log(process.execPath); setInterval(()=>{},1000)"');
    try {
      const until = Date.now() + 30_000;
      while (!entry.output.includes('node.exe') && Date.now() < until && entry.exitCode === undefined)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(entry.output).toMatch(/[P-Z]:\\0\\node.exe/i);
      const closed = once(entry.process, 'close');
      shell.stopBackground(entry.id);
      await closed;
      expect(readdirSync(join(process.env.LOCALAPPDATA!, 'Patch', 'sandbox-toolchains'))).toEqual([]);
      expect(acl(tools)).not.toMatch(/S-1-15-2-|patch\.sbx\./);
    } finally {
      shell.stopAll();
    }
  }, 60_000);

  it('recovers a forcibly killed staging helper while preserving a live staged command', async () => {
    const local = join(fixture, 'recovery-local');
    const stagedRoot = join(local, 'Patch', 'sandbox-toolchains');
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
      expect(readdirSync(stagedRoot)).toHaveLength(1);
      const liveMapping = execFileSync('subst', { encoding: 'utf8' })
        .split(/\r?\n/)
        .find((line) => line.includes(stagedRoot));
      expect(liveMapping).toBeDefined();
      await recover();
      expect(readdirSync(stagedRoot)).toHaveLength(1);
      expect(execFileSync('subst', { encoding: 'utf8' })).toContain(liveMapping!);
      child.kill();
      await closed;
      await recover();
      expect(readdirSync(stagedRoot)).toEqual([]);
      expect(execFileSync('subst', { encoding: 'utf8' })).not.toContain(liveMapping!);
      expect(readdirSync(join(local, 'Patch', 'sandbox-recovery'))).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      await recover();
      // #94 stays out of scope: remove only the forced run's project mapping, not other threads' drives.
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
      expect(original).toMatch(/APPLICATION PACKAGES|S-1-15-2-1/);
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
  }, 60_000);
});

describe.skipIf(!helper)('Windows sandbox recovery (real helper)', () => {
  it('recovers a forcibly killed helper without revoking a live helper grant', async () => {
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
    const originalHooksAcl = acl(hooks);
    expect(originalHooksAcl).toContain('(I)');
    expect(originalHooksAcl).toContain(':(R)');
    const child = spawn(helper!, [], { env, windowsHide: true });
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
        child.on('close', () => reject(new Error('helper closed before starting')));
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      await started;
      const liveAcl = acl(tools);
      expect(liveAcl).toMatch(/patch\.sbx\.|S-1-15-2-/);
      expect(readdirSync(journal)).toHaveLength(1);
      await recover();
      expect(acl(tools)).toBe(liveAcl);
      expect(readdirSync(journal)).toHaveLength(1);

      // ChildProcess.kill is TerminateProcess on Windows: no Rust destructors can run.
      child.kill();
      await closed;
      expect(acl(tools)).toBe(liveAcl);
      await recover();
      for (const path of [project, tools, join(tools, 'nested.txt'), hooks])
        expect(acl(path)).not.toMatch(/patch\.sbx\.|S-1-15-2-/);
      expect(readdirSync(journal)).toEqual([]);
      // Windows recomputes inherited entries from the parent. Explicit entries must stay unchanged,
      // rather than accumulating the copies produced when inheritance was temporarily protected.
      const explicit = (text: string) => text.split(/\r?\n/).filter((line) => !line.includes('(I)'));
      expect(explicit(acl(hooks))).toEqual(explicit(originalHooksAcl));
      expect(acl(hooks)).toContain('(I)');
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      await recover();
      // Forced termination also bypasses ProjectDrive's destructor. Permission recovery does not yet reclaim
      // drive mappings: remove only this fixture's mapping so repeated test runs do not consume P: through Z:.
      for (const line of execFileSync('subst', { encoding: 'utf8' }).split(/\r?\n/)) {
        const mapping = /^([P-Z]:)\\: => (.+)$/.exec(line);
        if (mapping?.[2]?.toLowerCase() === project.toLowerCase()) execFileSync('subst', [mapping[1]!, '/D']);
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 60_000);
});
