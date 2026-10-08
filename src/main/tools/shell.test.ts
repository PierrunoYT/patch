import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { APPCONTAINER_TIMEOUT_HINT, backgroundStartup, formatResult, runCommandTool, ShellRunner } from './shell';
import type { ToolContext } from './types';
import { Workspace } from './workspace';

// Long enough for a Node script to start and print on a busy machine; the real wait is three seconds.
backgroundStartup.waitMs = 1000;

const command =
  "node -e \"require('net').createServer().listen(0, '127.0.0.1', () => console.log('background-ready'))\"";

describe('background command cancellation', () => {
  let root: string;
  let shell: ShellRunner;
  let controller: AbortController;
  let context: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-shell-stop-'));
    shell = new ShellRunner(() => root);
    controller = new AbortController();
    context = {
      shell,
      signal: controller.signal,
      workspace: new Workspace(root),
      readFiles: new Set(),
      browser: null,
      codeSearch: null,
      webSearch: null,
      onProgress() {},
    };
  });

  afterEach(() => {
    shell.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['stdout', 'stderr'] as const)('decodes split UTF-8 on foreground %s', async (stream) => {
    const script = `process.${stream}.write(Buffer.from([226])); setTimeout(() => process.${stream}.write(Buffer.from([156,147,240,159])), 30); setTimeout(() => process.${stream}.write(Buffer.from([152,128,195])), 60); setTimeout(() => process.${stream}.write(Buffer.from([169])), 90);`;
    const chunks: string[] = [];
    const result = await shell.run(`node -e "${script}"`, { onOutput: (text) => chunks.push(text) });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('✓😀é');
    expect(chunks.join('')).toBe('✓😀é');
    expect(chunks.every((text) => !text.includes('�'))).toBe(true);
  });

  it.each(['stdout', 'stderr'] as const)('decodes split UTF-8 on background %s', async (stream) => {
    const script = `process.${stream}.write(Buffer.from([226])); setTimeout(() => process.${stream}.write(Buffer.from([156,147,240,159])), 30); setTimeout(() => process.${stream}.write(Buffer.from([152,128,195])), 60); setTimeout(() => process.${stream}.write(Buffer.from([169])), 90);`;
    const entry = shell.startBackground(`node -e "${script}"`);
    await once(entry.process, 'close');
    expect(entry.exitCode).toBe(0);
    expect(entry.output).toBe('✓😀é');
    expect(entry.unread).toBe('✓😀é');
  });

  it('does not launch a background command with an already-aborted signal', async () => {
    controller.abort();
    await expect(
      runCommandTool.run(
        {
          command: "node -e \"require('fs').writeFileSync('unexpected.txt', 'started')\"",
          background: true,
        },
        context,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(root, 'unexpected.txt'))).toBe(false);
    expect(shell.getBackground(1)).toBeUndefined();
  });

  it('terminates a command when Stop arrives during launch, before the abort listener is installed', async () => {
    shell = new ShellRunner(() => {
      controller.abort();
      return root;
    });
    const entry = shell.startBackground(command, controller.signal);
    await once(entry.process, 'close');
    expect(shell.getBackground(entry.id)).toBeUndefined();
    expect(entry.exitCode).not.toBeUndefined();
  }, 20_000);

  it('cancels the startup wait immediately and terminates its process', async () => {
    const pending = runCommandTool.run({ command, background: true }, context);
    // The command starts once the sandbox probes it needs have finished.
    const entry = await vi.waitFor(() => {
      const started = shell.getBackground(1);
      expect(started).toBeDefined();
      return started!;
    });
    const closed = once(entry.process, 'close');
    controller.abort();

    // Abort must settle without waiting for the three-second startup timer.
    const result = await Promise.race([
      pending.then(
        () => 'finished',
        (error: Error) => error.name,
      ),
      new Promise<string>((resolve) => setImmediate(() => resolve('still waiting'))),
    ]);
    expect(result).toBe('AbortError');
    await closed;
    expect(shell.getBackground(entry.id)).toBeUndefined();
  }, 20_000);

  it.skipIf(process.platform !== 'win32')(
    'terminates its owned process when taskkill fails during startup',
    async () => {
      const taskkill = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
        pid: 0,
        output: [],
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        status: 128,
        signal: null,
      });
      syncBuiltinESMExports();
      try {
        const entry = shell.startBackground('Start-Sleep -Seconds 120', controller.signal);
        const closed = once(entry.process, 'close');
        await once(entry.process, 'spawn');
        controller.abort();
        await closed;
        expect(taskkill).toHaveBeenCalledWith('taskkill', expect.any(Array), expect.any(Object));
        expect(entry.exitCode).not.toBeUndefined();
        expect(shell.getBackground(entry.id)).toBeUndefined();
      } finally {
        taskkill.mockRestore();
        syncBuiltinESMExports();
      }
    },
    20_000,
  );

  it('keeps a background command cancellable after its startup result has returned', async () => {
    const result = await runCommandTool.run({ command, background: true }, context);
    const entry = shell.getBackground(1)!;
    expect(result.content).toContain('still running');
    expect(result.content).toContain('background-ready');
    const closed = once(entry.process, 'close');
    controller.abort();
    await closed;
    expect(shell.getBackground(entry.id)).toBeUndefined();
  }, 20_000);

  it('returns the startup result as soon as a background command exits', async () => {
    const waitMs = backgroundStartup.waitMs;
    backgroundStartup.waitMs = 15_000;
    try {
      const startedAt = Date.now();
      const result = await runCommandTool.run({ command: 'exit 2', background: true }, context);
      expect(result.content).toContain('exited with code 2');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      backgroundStartup.waitMs = waitMs;
    }
  }, 20_000);
});

describe.skipIf(process.platform === 'win32')('processes a command leaves behind (#165)', () => {
  let root: string;
  let shell: ShellRunner;
  const spawnedPids: number[] = [];

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const readPid = (output: string) => {
    const pid = Number(/^\d+$/m.exec(output)?.[0]);
    spawnedPids.push(pid);
    return pid;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-shell-leftover-'));
    shell = new ShellRunner(() => root);
  });

  afterEach(() => {
    shell.stopAll();
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('kills a program a foreground command started and left running', async () => {
    const result = await shell.run('sleep 100 & echo $!');
    const pid = readPid(result.output);
    expect(result.exitCode).toBe(0);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  }, 20_000);

  it('kills a program a background command started when the shell has already exited', async () => {
    const entry = shell.startBackground('sleep 100 & echo $!');
    await vi.waitFor(() => expect(entry.output).toMatch(/\d+/));
    const pid = readPid(entry.output);
    await vi.waitFor(() => expect(entry.process.exitCode).not.toBeNull());
    expect(entry.exitCode).toBeUndefined();
    expect(isAlive(pid)).toBe(true);
    shell.stopBackground(entry.id);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  }, 20_000);

  it('kills a leftover that holds no output pipe once the background command has closed', async () => {
    const entry = shell.startBackground('sleep 100 > /dev/null 2>&1 & echo $!');
    await once(entry.process, 'close');
    const pid = readPid(entry.output);
    expect(isAlive(pid)).toBe(true);
    shell.stopBackground(entry.id);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  }, 20_000);
});

describe.skipIf(process.platform !== 'win32')('processes a command leaves behind on Windows (#165)', () => {
  let shell: ShellRunner;
  const spawnedPids: number[] = [];
  const root = tmpdir();
  // A program that runs until killed, started detached from the shell the way `Start-Process npm run dev` would.
  const start = `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru; $p.Id`;

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const readPid = (output: string) => {
    const pid = Number(/^\d+$/m.exec(output)?.[0]);
    spawnedPids.push(pid);
    return pid;
  };

  beforeEach(() => {
    shell = new ShellRunner(() => root);
  });

  afterEach(() => {
    shell.stopAll();
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('kills a program a foreground command started and left running', async () => {
    const result = await shell.run(start);
    const pid = readPid(result.output);
    expect(result.exitCode).toBe(0);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 15_000, interval: 250 });
  }, 30_000);

  it('kills a program a background command started when the shell has already exited', async () => {
    const entry = shell.startBackground(start);
    await vi.waitFor(() => expect(entry.output).toMatch(/\d+/), { timeout: 15_000 });
    const pid = readPid(entry.output);
    await vi.waitFor(() => expect(entry.process.exitCode).not.toBeNull(), { timeout: 15_000 });
    // The background command is not swept when its shell exits; only Stop reaches what it left.
    if (!isAlive(pid)) throw new Error('the program was expected to outlive its shell');
    shell.stopBackground(entry.id);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 15_000, interval: 250 });
  }, 40_000);
});

describe('formatResult', () => {
  const result = { exitCode: null, output: 'running tests', timedOut: true, aborted: false };

  it('explains the Node child-process hang when a Windows sandbox command times out (#101)', () => {
    const text = formatResult('node --test', { ...result, sandbox: 'appcontainer' });
    expect(text).toBe(`$ node --test\nTimed out and was stopped.\nrunning tests\n${APPCONTAINER_TIMEOUT_HINT}`);
    expect(text).toContain('--test-isolation=none');
    expect(text).toContain('unsandboxed');
  });

  it('adds no hint to other timeouts or to Windows sandbox commands that finished', () => {
    for (const sandbox of ['none', 'bwrap', 'seatbelt', 'container'] as const)
      expect(formatResult('node --test', { ...result, sandbox })).not.toContain(APPCONTAINER_TIMEOUT_HINT);
    expect(
      formatResult('node --test', { ...result, timedOut: false, exitCode: 1, sandbox: 'appcontainer' }),
    ).not.toContain(APPCONTAINER_TIMEOUT_HINT);
    expect(
      formatResult('node --test', { ...result, timedOut: false, aborted: true, sandbox: 'appcontainer' }),
    ).not.toContain(APPCONTAINER_TIMEOUT_HINT);
  });
});

describe('sandbox selection', () => {
  const config = { mode: 'container' as const, network: 'off' as const, image: 'node:lts', allowedHosts: '' };
  const noSupport = { bwrap: false, seatbelt: false, appcontainer: null, container: null };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-shell-sandbox-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['auto', 'container'] as const)(
    'does not run foreground or background commands without the %s sandbox',
    async (mode) => {
      const shell = new ShellRunner(
        () => root,
        () => ({ ...config, mode }),
        () => noSupport,
      );
      const command = "node -e \"require('fs').writeFileSync('ran.txt', 'x')\"";
      const result = await shell.run(command);
      expect(result.exitCode).toBeNull();
      expect(result.output).toMatch(/The command was not run/);
      expect(() => shell.startBackground(command)).toThrow(/The command was not run/);
      expect(shell.getBackground(1)).toBeUndefined();
      expect(existsSync(join(root, 'ran.txt'))).toBe(false);
    },
  );

  it.each(['auto', 'container'] as const)(
    'allows one unsandboxed run without disabling %s confinement',
    async (mode) => {
      const shell = new ShellRunner(
        () => root,
        () => ({ ...config, mode }),
        () => noSupport,
      );
      expect(shell.describe('echo hi').sandboxed).toBe(false);
      expect(shell.describe('echo hi', { unsandboxed: true }).text).toContain('Allowed to run without a sandbox');
      const result = await shell.run('echo hi', { access: { unsandboxed: true } });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('hi');
      expect((await shell.run('echo hi')).output).toContain('The command was not run');
    },
  );

  it('reports where a command ran, and nothing for a command that never started', async () => {
    const off = new ShellRunner(() => root);
    expect((await off.run('echo hi')).sandbox).toBe('none');
    const refused = new ShellRunner(
      () => root,
      () => config,
      () => noSupport,
    );
    expect((await refused.run('echo hi')).sandbox).toBeUndefined();
  });

  it('uses an injected environment for commands', async () => {
    const shell = new ShellRunner(
      () => root,
      undefined,
      undefined,
      () => ({ ...process.env, PATCH_TEST_ENV: 'isolated' }),
    );
    const result = await shell.run(`node -e "console.log(process.env.PATCH_TEST_ENV)"`);
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('isolated');
  });

  it('asks even in Auto mode when the model requests more access', () => {
    const context = {
      shell: new ShellRunner(
        () => root,
        () => config,
      ),
    } as ToolContext;
    expect(runCommandTool.mustAsk?.({ command: 'x', network: true }, context)).toBe(true);
    expect(runCommandTool.mustAsk?.({ command: 'x', unsandboxed: true }, context)).toBe(true);
    expect(runCommandTool.mustAsk?.({ command: 'x' }, context)).toBe(false);
  });

  it('requires approval for URL-triggered network access, including a harmless URL hiding another command', () => {
    const context = {
      shell: new ShellRunner(
        () => root,
        () => ({ ...config, network: 'allow-list', allowedHosts: 'allowed.test' }),
      ),
    } as ToolContext;
    for (const command of ['curl https://allowed.test/x', 'echo https://allowed.test/x; node steal.js']) {
      expect(runCommandTool.mustAsk?.({ command }, context)).toBe(true);
      expect(runCommandTool.mustAsk?.({ command, background: true }, context)).toBe(true);
    }
    expect(runCommandTool.mustAsk?.({ command: 'npm test' }, context)).toBe(false);
    expect(runCommandTool.mustAsk?.({ command: 'curl https://blocked.test' }, context)).toBe(false);
  });
});
