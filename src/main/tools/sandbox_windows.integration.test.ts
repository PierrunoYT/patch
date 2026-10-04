import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
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

  it('cannot write git hooks, which later run with the user full rights', async () => {
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    const result = await shell.run(`Set-Content -Path '${hook}' -Value 'echo pwned'`);
    expect(existsSync(hook), result.output).toBe(false);
    const other = await shell.run(`Set-Content -Path '${join(root, '.git', 'config-test')}' -Value ok`);
    expect(other.exitCode).toBe(0);
  }, 60_000);

  it('blocks the network by default', async () => {
    const result = await shell.run(NET_PROBE);
    expect(result.output).toContain('NOCONNECT');
    expect(result.output).not.toContain('CONNECTED\r');
  }, 60_000);

  it('allows the network when the command was granted it', async () => {
    if (!hostCanConnect) return;
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
spawn(process.execPath, ['-e', "setInterval(() => require('fs').appendFileSync('beat.txt', 'x'), 100)"], { stdio: 'ignore' });
setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const result = await shell.run(`& '${sandboxNode.replace(/\\/g, '/')}' spawner.js`, { timeoutSeconds: 3 });
    expect(result.timedOut).toBe(true);
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
