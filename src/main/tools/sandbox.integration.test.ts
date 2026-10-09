import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxEnv } from './env';
import { ShellRunner } from './shell';
import { buildLaunch, probeSandboxSupport, systemLaunchEnv } from './sandbox';

// Exercise the production launch builders, never Automatic mode's unsandboxed fallback.
// Container tests use an already-pulled image; tests must not download images or use the internet.
const support = await probeSandboxSupport();
const native = process.platform === 'linux' ? 'bwrap' : process.platform === 'darwin' ? 'seatbelt' : null;
const nativeAvailable = native === 'bwrap' ? support.bwrap : native === 'seatbelt' && support.seatbelt;
const image = 'node:lts';
const containerAvailable = Boolean(
  support.container &&
  spawnSync(support.container, ['image', 'inspect', image], { stdio: 'ignore', timeout: 8000 }).status === 0,
);
const execute = promisify(execFile);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const credentials = [
  '.cargo/credentials.toml',
  '.m2/settings.xml',
  '.gradle/gradle.properties',
  '.gitconfig',
  '.config/git/credentials',
];
const caches = ['.cargo/bin', '.cargo/registry', '.m2/repository', '.gradle/caches', '.gradle/wrapper'];

// A successful probe always returns JSON, even on an expected denial. A failed runtime or sandbox launch fails
// the test instead of being mistaken for a denied read/write/network operation.
const probe = `
const fs = require('node:fs');
const net = require('node:net');
const [action, target, value] = process.argv.slice(2);
const report = (value) => console.log(JSON.stringify(value));
if (action === 'connect' || action === 'connect-abstract') {
  // An abstract Unix socket's name starts with a NUL byte, which cannot be passed as an argument.
  const where = action === 'connect' ? { host: target, port: Number(value) } : { path: '\\0' + target };
  const socket = net.connect({ ...where, timeout: 2000 });
  socket.once('connect', () => { report({ connected: true }); socket.destroy(); });
  socket.once('error', (error) => { report({ error: error.code }); socket.destroy(); });
  socket.once('timeout', () => { report({ error: 'ETIMEDOUT' }); socket.destroy(); });
} else if (action === 'environment') {
  report({
    DATABASE_URL: process.env.DATABASE_URL ?? null,
    PATCH_PRIVATE_VALUE: process.env.PATCH_PRIVATE_VALUE ?? null,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? null,
    CC: process.env.CC ?? null,
    PATH: process.env.PATH ?? null,
    HOME: process.env.HOME ?? null,
    TMPDIR: process.env.TMPDIR ?? null,
    tmpdir: require('node:os').tmpdir(),
  });
} else {
  try {
    if (action === 'read') report({ content: fs.readFileSync(target, 'utf8') });
    else { fs.writeFileSync(target, value); report({ written: true }); }
  } catch (error) { report({ error: error.code }); }
}
`;

it.skipIf(process.env.PATCH_REQUIRE_NATIVE_SANDBOX !== '1')('has a working native sandbox required by CI', () => {
  expect(process.platform === 'win32' ? Boolean(support.appcontainer) : nativeAvailable).toBe(true);
});

for (const [kind, available] of [
  [native ?? 'bwrap', nativeAvailable],
  ['container', containerAvailable],
] as const) {
  describe.skipIf(!available)(
    `real ${kind} sandbox${available ? '' : ' (backend or cached image unavailable)'}`,
    () => {
      let home: string;
      let project: string;
      let temp: string;
      let server: Server;
      let port: number;
      let hostEnv: NodeJS.ProcessEnv;

      const run = async (action: string, target: string, value = '', network = false) => {
        const command = `${kind === 'container' ? 'node' : './node'} probe.cjs ${[action, target, value].map(quote).join(' ')}`;
        const env = await systemLaunchEnv({
          cwd: project,
          home,
          tmp: temp,
          command,
          inner: { file: '/bin/sh', args: ['-c', command] },
          containerName: `patch-sandbox-test-${randomUUID()}`,
          image,
        });
        const launch = buildLaunch({ kind, network }, env, support.container);
        try {
          const { stdout } = await execute(launch.file, launch.args, {
            cwd: project,
            timeout: 15_000,
            killSignal: 'SIGKILL',
            // The host engine needs its normal connection config; containerArgs passes no host variables inside.
            env: kind === 'container' ? hostEnv : sandboxEnv(hostEnv, process.platform, home, temp),
          });
          return JSON.parse(stdout.trim()) as {
            content?: string;
            written?: boolean;
            connected?: boolean;
            error?: string;
            DATABASE_URL?: string | null;
            PATCH_PRIVATE_VALUE?: string | null;
            NODE_OPTIONS?: string | null;
            SSH_AUTH_SOCK?: string | null;
            PATH?: string | null;
            HOME?: string | null;
            TMPDIR?: string | null;
            tmpdir?: string;
          };
        } finally {
          if (launch.stop) await execute(launch.stop.file, launch.stop.args, { timeout: 10_000 }).catch(() => {});
        }
      };

      beforeAll(async () => {
        home = realpathSync(mkdtempSync(join(homedir(), '.patch-sandbox-test-')));
        project = join(home, 'project');
        mkdirSync(project);
        temp = realpathSync(mkdtempSync(join(kind === 'seatbelt' ? project : tmpdir(), 'patch-sandbox-temp-')));
        hostEnv = {
          ...process.env,
          DATABASE_URL: 'postgres://fixture-user:fixture-password@fixture.invalid/private',
          PATCH_PRIVATE_VALUE: 'patch-private-fixture',
          NODE_OPTIONS: '--trace-warnings',
          SSH_AUTH_SOCK: join(home, 'fixture-agent.sock'),
        };
        mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
        if (kind !== 'container') copyFileSync(process.execPath, join(project, 'node'));
        writeFileSync(join(project, 'probe.cjs'), probe);
        writeFileSync(join(project, 'inside.txt'), 'PROJECT-READABLE');
        writeFileSync(join(home, 'outside.txt'), 'OUTSIDE-PRIVATE');
        writeFileSync(join(project, '.git', 'hooks', 'pre-commit.sample'), 'ORIGINAL-HOOK');
        for (const rel of credentials) {
          const path = join(home, rel);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `DUMMY-CREDENTIAL:${rel}`);
        }
        for (const rel of caches) {
          mkdirSync(join(home, rel), { recursive: true });
          writeFileSync(join(home, rel, 'fixture'), `CACHE:${rel}`);
        }
        server = createServer((socket) => socket.end());
        server.listen(0, '0.0.0.0');
        await once(server, 'listening');
        port = (server.address() as { port: number }).port;
      });

      afterAll(async () => {
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (home) rmSync(home, { recursive: true, force: true });
        if (temp) rmSync(temp, { recursive: true, force: true });
      });

      it('can read/write the project and use temporary storage', async () => {
        expect(await run('read', 'inside.txt')).toEqual({ content: 'PROJECT-READABLE' });
        expect(await run('write', 'created.txt', 'PROJECT-WRITTEN')).toEqual({ written: true });
        expect(readFileSync(join(project, 'created.txt'), 'utf8')).toBe('PROJECT-WRITTEN');
        const scratch = kind === 'seatbelt' ? join(temp, 'fixture') : '/tmp/patch-sandbox-fixture';
        expect(await run('write', scratch, 'TEMP-WRITTEN')).toEqual({ written: true });
      });

      it.skipIf(kind === 'container')('applies environment settings through the production shell runner', async () => {
        const runner = new ShellRunner(
          () => project,
          () => ({
            mode: 'auto',
            network: 'off',
            image: '',
            allowedHosts: '',
            envAllowList: 'CC\nNODE_OPTIONS',
            path: '/usr/bin:/bin',
          }),
          () => support,
          () => ({ ...hostEnv, CC: 'fixture-compiler' }),
        );
        try {
          const result = await runner.run("./node probe.cjs environment '' ''");
          expect(result.exitCode, result.output).toBe(0);
          expect(JSON.parse(result.output.trim())).toMatchObject({
            DATABASE_URL: null,
            PATCH_PRIVATE_VALUE: null,
            NODE_OPTIONS: null,
            SSH_AUTH_SOCK: null,
            CC: 'fixture-compiler',
            PATH: '/usr/bin:/bin',
            HOME: homedir(),
          });
        } finally {
          runner.stopAll();
        }
      });

      it('does not expose the host environment while retaining runtime paths', async () => {
        const result = await run('environment', '');
        expect(result).toMatchObject({
          DATABASE_URL: null,
          PATCH_PRIVATE_VALUE: null,
          NODE_OPTIONS: null,
          SSH_AUTH_SOCK: null,
          PATH: expect.any(String),
          HOME: kind === 'container' ? '/tmp' : home,
          tmpdir: kind === 'seatbelt' ? temp : '/tmp',
        });
        expect(result.PATH).not.toBe('');
        if (kind !== 'container') expect(result.TMPDIR).toBe(kind === 'seatbelt' ? temp : '/tmp');
      });

      it('cannot read or modify private files outside the project', async () => {
        const outside = join(home, 'outside.txt');
        expect((await run('read', outside)).error).toMatch(/^(EACCES|EPERM|ENOENT)$/);
        // Bubblewrap can write a private tmpfs at this path; it must never change the host's file.
        await run('write', outside, 'CHANGED');
        expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE-PRIVATE');
      });

      it.each(credentials)('cannot read home credentials at %s', async (rel) => {
        expect(readFileSync(join(home, rel), 'utf8')).toBe(`DUMMY-CREDENTIAL:${rel}`);
        expect((await run('read', join(home, rel))).error).toMatch(/^(EACCES|EPERM|ENOENT)$/);
      });

      it.skipIf(kind === 'container')('can read allowed toolchain caches but cannot overwrite them', async () => {
        for (const rel of caches) {
          const target = join(home, rel, 'fixture');
          expect(await run('read', target)).toEqual({ content: `CACHE:${rel}` });
          expect((await run('write', target, 'CHANGED')).error).toMatch(/^(EACCES|EPERM|EROFS)$/);
          expect(readFileSync(target, 'utf8')).toBe(`CACHE:${rel}`);
        }
      });

      it('cannot create or overwrite Git hooks', async () => {
        expect((await run('write', '.git/hooks/pre-commit.sample', 'CHANGED')).error).toMatch(/^(EACCES|EPERM|EROFS)$/);
        expect((await run('write', '.git/hooks/pre-push', 'NEW')).error).toMatch(/^(EACCES|EPERM|EROFS)$/);
        expect(readFileSync(join(project, '.git', 'hooks', 'pre-commit.sample'), 'utf8')).toBe('ORIGINAL-HOOK');
        expect(existsSync(join(project, '.git', 'hooks', 'pre-push'))).toBe(false);
        expect((await run('write', '.git/config-test', 'DENIED')).error).toMatch(/^(EACCES|EPERM|EROFS)$/);
      });

      it.skipIf(process.platform === 'win32')('cannot follow a project symlink into the private home', async () => {
        symlinkSync(join(home, 'outside.txt'), join(project, 'outside-link'));
        expect((await run('read', 'outside-link')).error).toMatch(/^(EACCES|EPERM|ENOENT)$/);
        await run('write', 'outside-link', 'CHANGED');
        expect(readFileSync(join(home, 'outside.txt'), 'utf8')).toBe('OUTSIDE-PRIVATE');
      });

      it('blocks a live TCP endpoint offline and permits it with network access', async () => {
        const host =
          kind !== 'container'
            ? '127.0.0.1'
            : process.platform === 'linux'
              ? Object.values(networkInterfaces())
                  .flat()
                  .find((entry) => entry?.family === 'IPv4' && !entry.internal)!.address
              : support.container === 'podman'
                ? 'host.containers.internal'
                : 'host.docker.internal';
        expect(await run('connect', host, String(port), true)).toEqual({ connected: true });
        expect((await run('connect', host, String(port))).error).toMatch(
          /^(EPERM|EACCES|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/,
        );
      });

      // #104: a cgroup for the command and everything it starts. TasksMax counts threads, and Node alone runs about
      // a dozen, so the process limit here leaves room for the runtime.
      it.skipIf(kind !== 'bwrap' || !support.scope)(
        'stops a process loop and a memory hog at the scope limits, and runs ordinary commands (#104)',
        async () => {
          const limited = async (script: string) => {
            const command = `./node -e ${quote(script)}`;
            const env = await systemLaunchEnv({
              cwd: project,
              home,
              tmp: temp,
              command,
              inner: { file: '/bin/sh', args: ['-c', command] },
              containerName: '',
              image,
            });
            const launch = buildLaunch({ kind: 'bwrap', network: false }, env, null, {
              scope: true,
              limits: { processes: 48, memoryMb: 256 },
            });
            expect(launch.file).toBe('systemd-run');
            const result = spawnSync(launch.file, launch.args, {
              cwd: project,
              encoding: 'utf8',
              timeout: 30_000,
              env: {
                ...sandboxEnv(hostEnv, process.platform, home, temp),
                XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
              },
            });
            return { status: result.status, signal: result.signal, output: `${result.stdout}${result.stderr}` };
          };
          expect(await limited('console.log(6 * 7, process.env.XDG_RUNTIME_DIR ?? "unset")')).toMatchObject({
            status: 0,
            output: '42 unset\n',
          });
          const loop = await limited(`
            const { spawn } = require('node:child_process');
            let started = 0;
            const children = [];
            const next = () => {
              if (started === 200) return finish('none');
              const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
              child.once('spawn', () => { started++; children.push(child); next(); });
              child.once('error', (error) => finish(error.code));
            };
            const finish = (error) => {
              console.log(JSON.stringify({ started, error }));
              for (const child of children) child.kill('SIGKILL');
              process.exit(0);
            };
            next();
          `);
          const { started, error } = JSON.parse(loop.output.trim()) as { started: number; error: string };
          expect(error).toBe('EAGAIN');
          expect(started).toBeGreaterThan(0);
          expect(started).toBeLessThan(48);
          const hog = await limited(
            'const kept = []; for (let i = 0; i < 80; i++) kept.push(Buffer.alloc(10 * 1024 * 1024, 1)); console.log("ALLOCATED")',
          );
          expect(hog.output).not.toContain('ALLOCATED');
          expect(hog.status === 0).toBe(false);
        },
        60_000,
      );

      // #102: bubblewrap with network shares the host's network namespace, which holds loopback-only services and
      // abstract Unix sockets (X11, some D-Bus setups). The approval card and settings say so; offline they are
      // out of reach. These tests pin that documented behavior until commands get their own namespace (#97).
      it.skipIf(kind !== 'bwrap')(
        'reaches a host loopback-only service and an abstract Unix socket only with network on (#102)',
        async () => {
          const loopback = createServer((socket) => socket.end());
          loopback.listen(0, '127.0.0.1');
          await once(loopback, 'listening');
          const name = `patch-sandbox-test-${randomUUID()}`;
          const abstract = createServer((socket) => socket.end());
          abstract.listen(`\0${name}`);
          await once(abstract, 'listening');
          try {
            const loopbackPort = String((loopback.address() as { port: number }).port);
            const refused = /^(EPERM|EACCES|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENOENT)$/;
            expect((await run('connect', '127.0.0.1', loopbackPort)).error).toMatch(refused);
            expect((await run('connect-abstract', name)).error).toMatch(refused);
            expect(await run('connect', '127.0.0.1', loopbackPort, true)).toEqual({ connected: true });
            expect(await run('connect-abstract', name, '', true)).toEqual({ connected: true });
          } finally {
            loopback.close();
            abstract.close();
          }
        },
      );
    },
  );
}
