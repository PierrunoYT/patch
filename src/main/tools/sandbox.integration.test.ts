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
import { buildLaunch, detectSandboxSupport, systemLaunchEnv } from './sandbox';

// Exercise the production launch builders, never Automatic mode's unsandboxed fallback.
// Container tests use an already-pulled image; tests must not download images or use the internet.
const support = detectSandboxSupport();
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
if (action === 'connect') {
  const socket = net.connect({ host: target, port: Number(value), timeout: 2000 });
  socket.once('connect', () => { report({ connected: true }); socket.destroy(); });
  socket.once('error', (error) => { report({ error: error.code }); socket.destroy(); });
  socket.once('timeout', () => { report({ error: 'ETIMEDOUT' }); socket.destroy(); });
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

      const run = async (action: string, target: string, value = '', network = false) => {
        const command = `${kind === 'container' ? 'node' : './node'} probe.cjs ${[action, target, value].map(quote).join(' ')}`;
        const env = systemLaunchEnv({
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
            env: kind === 'container' ? process.env : { PATH: process.env.PATH, HOME: home },
          });
          return JSON.parse(stdout.trim()) as {
            content?: string;
            written?: boolean;
            connected?: boolean;
            error?: string;
          };
        } finally {
          if (launch.stop) await execute(launch.stop.file, launch.stop.args, { timeout: 10_000 }).catch(() => {});
        }
      };

      beforeAll(async () => {
        // Outside /tmp: Seatbelt intentionally allows writes to the system temp directory.
        home = realpathSync(mkdtempSync(join(homedir(), '.patch-sandbox-test-')));
        project = join(home, 'project');
        temp = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sandbox-temp-')));
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
    },
  );
}
