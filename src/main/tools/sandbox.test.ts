import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bwrapArgs,
  buildLaunch,
  containerArgs,
  decideSandbox,
  describeSandbox,
  seatbeltProfile,
  systemLaunchEnv,
  validateSandboxRoot,
  wantsNetwork,
  type LaunchEnv,
  type SandboxConfig,
  type SandboxSupport,
} from './sandbox';

const config: SandboxConfig = { mode: 'auto', network: 'off', image: 'node:lts', allowedHosts: 'registry.npmjs.org' };
const none: SandboxSupport = { bwrap: false, seatbelt: false, appcontainer: null, container: null };

describe('sandbox project root safety (#145)', () => {
  it('rejects roots containing home and sensitive trees while allowing ordinary children and similar siblings', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'patch-root-safety-'));
    try {
      const home = join(fixture, 'home');
      const project = join(home, 'work', 'project');
      const appData = join(home, '.config', 'Patch');
      const sibling = join(home, '.config', 'Patch-safe');
      for (const path of [project, appData, sibling]) mkdirSync(path, { recursive: true });
      expect(validateSandboxRoot(project, home, [appData])).toBe(realpathSync.native(project));
      expect(validateSandboxRoot(sibling, home, [appData])).toBe(realpathSync.native(sibling));
      expect(() => validateSandboxRoot(home, home, [appData])).toThrow(/narrower project root/);
      expect(() => validateSandboxRoot(fixture, home, [appData])).toThrow(/narrower project root/);
      expect(() => validateSandboxRoot(parse(fixture).root, home, [appData])).toThrow(/narrower project root/);
      expect(() => validateSandboxRoot(appData, home, [appData])).toThrow(/narrower project root/);
      expect(() => validateSandboxRoot(join(appData, 'projects', 'one'), home, [appData])).toThrow(/narrower/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('canonicalizes aliases before checking boundaries', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'patch-root-alias-'));
    try {
      const home = join(fixture, 'home');
      const appData = join(home, 'app-data');
      const alias = join(fixture, 'alias');
      mkdirSync(appData, { recursive: true });
      symlinkSync(appData, alias, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => validateSandboxRoot(alias, home, [appData])).toThrow(/Sandbox refused/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects before creating a Git reservation', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'patch-root-side-effect-'));
    try {
      const home = join(fixture, 'home');
      mkdirSync(home);
      await expect(
        systemLaunchEnv({
          cwd: home,
          home,
          tmp: tmpdir(),
          inner: { file: '/bin/sh', args: ['-c', 'true'] },
          command: 'true',
          containerName: 'unused',
          image: 'unused',
        }),
      ).rejects.toThrow(/command was not run/);
      expect(existsSync(join(home, '.git'))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

const env = (existing: string[] = []): LaunchEnv => ({
  cwd: '/home/u/proj',
  home: '/home/u',
  tmp: '/tmp',
  inner: { file: '/bin/bash', args: ['-lc', 'npm test'] },
  command: 'npm test',
  exists: (path) => path === '/home/u/proj/.git' || existing.includes(path),
  protectedPaths: ['/home/u/proj/.git'],
  uid: 1000,
  gid: 1000,
  containerName: 'patch-abc',
  image: 'node:lts',
});

describe('decideSandbox', () => {
  it('uses bubblewrap on Linux and Seatbelt on macOS', () => {
    expect(decideSandbox('ls', config, { ...none, bwrap: true }, {}, 'linux')).toEqual({
      kind: 'bwrap',
      network: false,
    });
    expect(decideSandbox('ls', config, { ...none, seatbelt: true }, {}, 'darwin')).toEqual({
      kind: 'seatbelt',
      network: false,
    });
  });

  it.each(['win32', 'linux', 'darwin'] as const)('fails closed without a native backend on %s', (platform) => {
    const decision = decideSandbox('ls', config, { ...none, container: 'docker' }, {}, platform);
    expect(decision.kind).toBe('unavailable');
    expect(describeSandbox(decision)).toMatch(/Cannot run:.*unsandboxed access.*not run/);
  });

  it('uses the AppContainer helper on Windows and says so', () => {
    const support = { ...none, appcontainer: 'C:\\app\\sandbox-helper.exe' };
    const decision = decideSandbox('ls', config, support, {}, 'win32');
    expect(decision).toEqual({ kind: 'appcontainer', network: false });
    expect(describeSandbox(decision)).toMatch(/Sandboxed \(AppContainer\).*no network/);
    expect(decideSandbox('ls', config, support, { network: true }, 'win32')).toEqual({
      kind: 'appcontainer',
      network: true,
    });
    expect(decideSandbox('ls', config, support, {}, 'linux').kind).toBe('unavailable');
  });

  it('does not run in the AppContainer when sandboxing is off or allowed to be skipped', () => {
    const support = { ...none, appcontainer: 'C:\\app\\sandbox-helper.exe' };
    expect(decideSandbox('ls', { ...config, mode: 'off' }, support, {}, 'win32').kind).toBe('none');
    expect(decideSandbox('ls', config, support, { unsandboxed: true }, 'win32').kind).toBe('none');
  });

  it('prefers the container when that mode is chosen, even on Windows with the helper', () => {
    const support = { ...none, appcontainer: 'C:\\h.exe', container: 'docker' as const };
    expect(decideSandbox('ls', { ...config, mode: 'container' }, support, {}, 'win32').kind).toBe('container');
  });

  it('never turns an AppContainer decision into an unsandboxed command line', () => {
    expect(() => buildLaunch({ kind: 'appcontainer', network: false }, env(), null)).toThrow(/AppContainer/);
  });
  it('fails closed in container mode without an engine', () => {
    const decision = decideSandbox('ls', { ...config, mode: 'container' }, none, {}, 'linux');
    expect(decision.kind).toBe('unavailable');
    expect(describeSandbox(decision)).toMatch(/not run/);
    expect(
      decideSandbox('ls', { ...config, mode: 'container' }, { ...none, container: 'podman' }, {}, 'win32'),
    ).toEqual({
      kind: 'container',
      network: false,
    });
  });

  it('runs without a sandbox only when turned off or allowed once', () => {
    expect(decideSandbox('ls', { ...config, mode: 'off' }, { ...none, bwrap: true }, {}, 'linux').kind).toBe('none');
    const once = decideSandbox('ls', { ...config, mode: 'container' }, none, { unsandboxed: true }, 'linux');
    expect(once.kind).toBe('none');
  });
});

describe('wantsNetwork', () => {
  it('is off by default and on when allowed once or in the settings', () => {
    expect(wantsNetwork('npm i', config, {})).toBe(false);
    expect(wantsNetwork('npm i', config, { network: true })).toBe(true);
    expect(wantsNetwork('npm i', { ...config, network: 'on' }, {})).toBe(true);
  });

  it('filters the allow-list setting by host where bubblewrap and the bridge can enforce it (#97)', () => {
    const list = { ...config, network: 'allow-list' as const };
    const linux: SandboxSupport = { ...none, bwrap: true, netBridge: '/opt/Patch/resources/net-bridge' };
    // Every command, whatever URLs it names: the proxy decides per connection.
    expect(decideSandbox('npm install', list, linux, {}, 'linux')).toEqual({
      kind: 'bwrap',
      network: false,
      filtered: true,
    });
    // An explicit network request stays unrestricted network; other settings and platforms keep the old behavior.
    expect(decideSandbox('npm install', list, linux, { network: true }, 'linux')).toEqual({
      kind: 'bwrap',
      network: true,
    });
    expect(decideSandbox('npm install', { ...list, network: 'off' }, linux, {}, 'linux')).toEqual({
      kind: 'bwrap',
      network: false,
    });
    expect(decideSandbox('npm install', list, { ...linux, netBridge: null }, {}, 'linux')).toEqual({
      kind: 'bwrap',
      network: false,
    });
    expect(decideSandbox('npm install', list, { ...linux, seatbelt: true }, {}, 'darwin')).toMatchObject({
      kind: 'seatbelt',
    });
    expect(describeSandbox({ kind: 'bwrap', network: false, filtered: true })).toContain(
      'network only to the allowed hosts, on ports 80 and 443, through a filtering proxy',
    );
  });

  it('filters the allow-list setting by host in the Windows AppContainer too (#97)', () => {
    const list = { ...config, network: 'allow-list' as const };
    const windows: SandboxSupport = { ...none, appcontainer: 'C:\\Patch\\resources\\sandbox-helper.exe' };
    expect(decideSandbox('npm install', list, windows, {}, 'win32')).toEqual({
      kind: 'appcontainer',
      network: false,
      filtered: true,
    });
    expect(decideSandbox('npm install', list, windows, { network: true }, 'win32')).toEqual({
      kind: 'appcontainer',
      network: true,
    });
    expect(decideSandbox('npm install', { ...list, network: 'off' }, windows, {}, 'win32')).toEqual({
      kind: 'appcontainer',
      network: false,
    });
    // Container mode keeps the approval-based heuristic.
    expect(
      decideSandbox(
        'curl https://registry.npmjs.org/',
        { ...list, mode: 'container', allowedHosts: 'registry.npmjs.org' },
        { ...windows, container: 'docker' },
        {},
        'win32',
      ),
    ).toEqual({ kind: 'container', network: true });
    expect(describeSandbox({ kind: 'appcontainer', network: false, filtered: true })).toContain(
      'network only to the allowed hosts',
    );
  });

  it('mounts the proxy socket and bridge and starts the command through the bridge (#97)', () => {
    const args = bwrapArgs({ ...env(), proxy: { socket: '/tmp/patch-net-x/proxy.sock', bridge: '/opt/b' } }, false);
    expect(args).toContain('--unshare-all');
    expect(args).not.toContain('--share-net');
    expect(args.join(' ')).toContain('--bind /tmp/patch-net-x/proxy.sock /tmp/.patch-proxy.sock');
    expect(args.join(' ')).toContain('--ro-bind /opt/b /tmp/.patch-net-bridge');
    expect(args.join(' ')).toContain('--setenv HTTPS_PROXY http://127.0.0.1:3128');
    const start = args.indexOf('--', args.indexOf('--chdir'));
    expect(args.slice(start + 1, start + 6)).toEqual([
      '/tmp/.patch-net-bridge',
      '3128',
      '/tmp/.patch-proxy.sock',
      '--',
      '/bin/bash',
    ]);
    // The proxy is mounted after /tmp's tmpfs, or the tmpfs would hide it.
    expect(args.indexOf('/tmp/.patch-proxy.sock')).toBeGreaterThan(args.indexOf('--tmpfs'));
    // With unrestricted network there is nothing to filter.
    expect(bwrapArgs({ ...env(), proxy: { socket: '/s', bridge: '/b' } }, true).join(' ')).not.toContain('bridge');
  });

  it('grants the allow-list setting only when every URL in the command is allowed', () => {
    const list = { ...config, network: 'allow-list' as const };
    expect(wantsNetwork('curl https://registry.npmjs.org/x', list, {})).toBe(true);
    expect(wantsNetwork('curl https://registry.npmjs.org/x https://evil.example', list, {})).toBe(false);
    expect(wantsNetwork('curl https://registry.npmjs.org@evil.example/x', list, {})).toBe(false);
    expect(wantsNetwork('npm install', list, {})).toBe(false);
  });
});

describe('bwrapArgs', () => {
  const existing = ['/usr', '/bin', '/etc', '/home/u/.cargo/bin', '/home/u/.gitconfig', '/home/u/proj/.git/hooks'];

  it('hides home, binds the project writable and unshares the network', () => {
    const args = bwrapArgs(env(existing), false);
    expect(args).toContain('--unshare-all');
    expect(args).not.toContain('--share-net');
    expect(args).toContain('--die-with-parent');
    const text = args.join(' ');
    expect(text).toContain('--tmpfs /home/u');
    expect(text).toContain('--ro-bind /usr /usr');
    expect(text).toContain('--ro-bind /home/u/.cargo/bin /home/u/.cargo/bin');
    expect(text).toContain('--bind /home/u/proj /home/u/proj');
    expect(text).toContain('--ro-bind /home/u/proj/.git /home/u/proj/.git');
    expect(text).not.toContain('.ssh');
    expect(text).not.toContain('/lib64');
    expect(args.slice(-3)).toEqual(['/bin/bash', '-lc', 'npm test']);
  });

  it('hides the home folder before opening anything inside it', () => {
    const args = bwrapArgs(env(existing), false);
    expect(args.indexOf('--tmpfs')).toBeLessThan(args.indexOf('/home/u/.cargo/bin'));
    expect(args.lastIndexOf('--tmpfs', args.indexOf('--bind'))).toBeLessThan(args.indexOf('--bind'));
  });

  it('shares the network when asked', () => {
    expect(bwrapArgs(env(), true)).toContain('--share-net');
  });

  it('does not use a shell that lives in the hidden home folder', () => {
    const args = bwrapArgs({ ...env(), inner: { file: '/home/u/.local/bin/fish', args: ['-lc', 'x'] } }, false);
    expect(args).toContain('/bin/bash');
    expect(args).not.toContain('/home/u/.local/bin/fish');
  });
});

describe('seatbeltProfile', () => {
  it('denies by default, hides home, opens the project and denies the network', () => {
    const profile = seatbeltProfile({ ...env(['/home/u/.cargo/bin']) }, false);
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny file-read* (subpath "/home/u"))');
    expect(profile.indexOf('(deny file-read*')).toBeLessThan(
      profile.indexOf('(allow file-read* (subpath "/home/u/proj")'),
    );
    expect(profile).toContain('(subpath "/home/u/.cargo/bin")');
    expect(profile).toMatch(/\(allow file-write\* \(subpath "\/home\/u\/proj"\)/);
    expect(profile).toContain('(deny file-write* (subpath "/home/u/proj/.git"))');
    expect(profile).toContain('(deny file-write-unlink (literal "/home/u/proj"))');
    expect(profile).toContain('(deny file-write-unlink (literal "/home/u"))');
    expect(profile).toContain('(deny file-write-unlink (literal "/home"))');
    const writeGrant = profile.split('\n').find((line) => line.startsWith('(allow file-write*'))!;
    expect(writeGrant).not.toMatch(/subpath "\/(tmp|private\/tmp|private\/var\/folders)"/);
    expect(profile).not.toContain('network');
  });

  it('allows the network when asked and escapes quotes in paths', () => {
    expect(seatbeltProfile(env(), true)).toContain('(allow network*)');
    expect(seatbeltProfile({ ...env(), cwd: '/a"b' }, false)).toContain('(subpath "/a\\"b")');
  });

  it('keeps local Unix sockets denied with network access, except the system name resolver', () => {
    const lines = seatbeltProfile(env(), true).split('\n');
    const allow = lines.indexOf('(allow network*)');
    const deny = lines.indexOf('(deny network-outbound (remote unix-socket))');
    // Later rules win: only the resolver exception may follow the deny.
    expect(allow).toBeGreaterThanOrEqual(0);
    expect(deny).toBeGreaterThan(allow);
    expect(lines.slice(deny + 1).filter((line) => line.startsWith('(allow network'))).toEqual([
      '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    ]);
  });

  it.each([false, true])(
    'allows only named CLI services, never application-launch or URL-session daemons (network=%s)',
    (network) => {
      const profile = seatbeltProfile(env(), network);
      const allowed = profile.split('\n').find((line) => line.startsWith('(allow mach-lookup '))!;
      const names = [...allowed.matchAll(/\(global-name "([^"]+)"\)/g)].map((match) => match[1]);
      expect(names).toEqual([
        'com.apple.system.opendirectoryd.libinfo',
        ...(network
          ? [
              'com.apple.SystemConfiguration.DNSConfiguration',
              'com.apple.SystemConfiguration.configd',
              'com.apple.networkd',
              'com.apple.ocspd',
              'com.apple.trustd.agent',
              'com.apple.TrustEvaluationAgent',
            ]
          : []),
      ]);
      expect(profile).not.toContain('(allow mach-lookup)');
      expect(profile).not.toContain('global-name-prefix');
      expect(allowed).not.toMatch(/launchservices|lsd\.|nsurlsession|appleevent|runningboard|SecurityServer|cfprefsd/i);
      expect(profile).toContain(
        '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb"))',
      );
      expect(profile.trim().endsWith('(deny mach-lookup (xpc-service-name-prefix ""))')).toBe(true);
    },
  );

  it('denies host POSIX shared memory while retaining inherited CLI process execution', () => {
    const profile = seatbeltProfile(env(), false);
    expect(profile).not.toContain('(allow ipc-posix-shm)');
    expect(profile).not.toMatch(/\(allow ipc-posix-shm[^\n]*ipc-posix-name-prefix/);
    expect(profile).toContain('(ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$")');
    expect(profile).toContain('(allow ipc-posix-sem)');
    expect(profile).toContain('(allow process-exec)');
    expect(profile).toContain('(allow process-fork)');
    expect(profile).not.toContain('(allow sysctl-write)');
  });

  it('limits sysctl reads to runtime discovery, never process arguments or environment', () => {
    const profile = seatbeltProfile(env(), false);
    expect(profile).not.toContain('(allow sysctl-read)');
    for (const name of [
      'hw.ncpu',
      'hw.memsize',
      'machdep.cpu.brand_string',
      'kern.ostype',
      'kern.sysv.semmns',
      'vm.loadavg',
      'kern.boottime',
      'kern.osproductversioncompat',
      'sysctl.proc_translated',
    ]) {
      expect(profile).toContain(`(sysctl-name "${name}")`);
    }
    expect(profile).toContain('(sysctl-name-prefix "hw.optional.")');
    expect(profile).not.toContain('kern.procargs');
    expect(profile).not.toContain('(sysctl-name-prefix "kern.proc.")');
  });
});

describe('containerArgs', () => {
  it('refuses commas that would change the bind mount CSV fields', () => {
    expect(() => containerArgs('docker', { ...env(), cwd: '/tmp/project,dst=/other' }, false)).toThrow(/commas/);
  });

  it.each(['docker', 'podman'] as const)(
    'protects the whole Git directory in %s after mounting the project',
    (engine) => {
      const { args } = containerArgs(engine, env(), false);
      const mount = 'type=bind,src=/home/u/proj/.git,dst=/workspace/.git,readonly';
      expect(args).toContain(mount);
      expect(args.indexOf(mount)).toBeGreaterThan(args.indexOf('/home/u/proj:/workspace'));
      expect(args.indexOf(mount)).toBeLessThan(args.indexOf('node:lts'));
    },
  );

  it('mounts only the project, drops privileges and has no network by default', () => {
    const { args, stop } = containerArgs('docker', env(), false);
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args.join(' ')).toContain('--network none');
    expect(args).toContain('--user=1000:1000');
    expect(args.filter((arg) => arg === '-v')).toHaveLength(1);
    expect(args).toContain('/home/u/proj:/workspace');
    expect(args.slice(-4)).toEqual(['node:lts', '/bin/sh', '-c', 'npm test']);
    expect(stop).toEqual({ file: 'docker', args: ['rm', '-f', 'patch-abc'] });
  });

  it('keeps the network with network access and maps users for podman', () => {
    const { args } = containerArgs('podman', env(), true);
    expect(args).not.toContain('--network');
    expect(args).toContain('--userns=keep-id');
  });

  it('passes no host environment variables', () => {
    const { args } = containerArgs('docker', env(), false);
    const names = args.filter((_, i) => args[i - 1] === '-e').map((entry) => entry.split('=')[0]);
    expect(names).toEqual(['HOME', 'CI', 'FORCE_COLOR', 'NO_COLOR']);
  });
});

describe('buildLaunch', () => {
  it('protects the validated reservation even if the mount source disappears after preparation', () => {
    const missing = { ...env(), exists: () => false };
    expect(bwrapArgs(missing, false).join(' ')).toContain('--ro-bind /home/u/proj/.git /home/u/proj/.git');
    expect(containerArgs('docker', missing, false).args).toContain(
      'type=bind,src=/home/u/proj/.git,dst=/workspace/.git,readonly',
    );
  });

  it('protects both a gitfile and the top-level ancestor of its metadata on every backend', () => {
    const input = { ...env(), protectedPaths: ['/home/u/proj/.git', '/home/u/proj/metadata'] };
    expect(bwrapArgs(input, false).join(' ')).toContain('--ro-bind /home/u/proj/metadata /home/u/proj/metadata');
    expect(seatbeltProfile(input, false)).toContain(
      '(deny file-write* (subpath "/home/u/proj/.git") (subpath "/home/u/proj/metadata"))',
    );
    expect(containerArgs('docker', input, false).args).toContain(
      'type=bind,src=/home/u/proj/metadata,dst=/workspace/metadata,readonly',
    );
  });

  it('wraps with the right program', () => {
    expect(buildLaunch({ kind: 'bwrap', network: false }, env(), null).file).toBe('bwrap');
    const seatbelt = buildLaunch({ kind: 'seatbelt', network: false }, env(), null);
    expect(seatbelt.file).toBe('/usr/bin/sandbox-exec');
    expect(seatbelt.args.slice(-3)).toEqual(['/bin/bash', '-lc', 'npm test']);
    expect(buildLaunch({ kind: 'container', network: false }, env(), 'podman').file).toBe('podman');
    expect(buildLaunch({ kind: 'none', network: true }, env(), null)).toEqual({
      file: '/bin/bash',
      args: ['-lc', 'npm test'],
    });
  });

  it('runs bubblewrap in a limited systemd user scope when one is available (#104)', () => {
    const scoped = buildLaunch({ kind: 'bwrap', network: false }, env(), null, {
      scope: true,
      limits: { processes: 64, memoryMb: 512 },
    });
    expect(scoped.file).toBe('systemd-run');
    const bwrap = scoped.args.indexOf('bwrap');
    expect(scoped.args.slice(0, bwrap)).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '-p',
      'TasksMax=64',
      '-p',
      'MemoryMax=512M',
      '-p',
      'MemorySwapMax=0',
      '--',
    ]);
    // The launcher's bus address is passed to systemd-run only, never to the command.
    expect(scoped.launcherEnv).toEqual(['XDG_RUNTIME_DIR']);
    expect(scoped.args.slice(bwrap + 1, bwrap + 3)).toEqual(['--unsetenv', 'XDG_RUNTIME_DIR']);
    expect(scoped.args.slice(bwrap + 3)).toEqual(bwrapArgs(env(), false));
    expect(buildLaunch({ kind: 'bwrap', network: false }, env(), null).launcherEnv).toBeUndefined();
  });

  it('limits container processes and memory with the Windows defaults (#104)', () => {
    const { args } = containerArgs('docker', env(), false);
    expect(args).toEqual(expect.arrayContaining(['--pids-limit=512', '--memory=8192m', '--memory-swap=8192m']));
  });
});

describe('describeSandbox', () => {
  it('names the sandbox and the network state', () => {
    expect(describeSandbox({ kind: 'bwrap', network: false })).toMatch(/bubblewrap.*no network/);
    expect(describeSandbox({ kind: 'container', network: true }, { network: true })).toMatch(
      /allowed for this command/,
    );
    expect(describeSandbox({ kind: 'bwrap', network: true })).toContain(
      'unrestricted network on (not filtered by hostname)',
    );
    expect(describeSandbox({ kind: 'seatbelt', network: true })).toContain(
      'unrestricted network on (not filtered by hostname), but not local Unix sockets.',
    );
    expect(describeSandbox({ kind: 'seatbelt', network: false })).not.toContain('Unix sockets');
    expect(describeSandbox({ kind: 'bwrap', network: false })).not.toContain('Unix sockets');
  });

  it('says that bubblewrap with network reaches local services and abstract sockets', () => {
    for (const access of [{}, { network: true }]) {
      expect(describeSandbox({ kind: 'bwrap', network: true }, access)).toContain(
        'including services on this machine and abstract Unix sockets such as the X11 display.',
      );
    }
    expect(describeSandbox({ kind: 'container', network: true })).not.toContain('services on this machine');
    expect(describeSandbox({ kind: 'appcontainer', network: true })).not.toContain('services on this machine');
  });
});

describe('home credential isolation', () => {
  it('opens tool binaries and caches without opening their credential-bearing parents', () => {
    const input = { ...env(), exists: () => true };
    const args = bwrapArgs(input, false);
    const mounts = args.filter((_, i) => args[i - 1] === '--ro-bind');
    const profile = seatbeltProfile(input, false);
    for (const rel of [
      '.cargo/bin',
      '.cargo/registry',
      '.cargo/git',
      '.m2/repository',
      '.gradle/caches',
      '.gradle/wrapper',
    ]) {
      expect(mounts).toContain(`${input.home}/${rel}`);
      expect(profile).toContain(`(subpath "${input.home}/${rel}")`);
    }
    for (const rel of ['.cargo', '.m2', '.gradle', '.gitconfig', '.config/git']) {
      expect(mounts).not.toContain(`${input.home}/${rel}`);
      expect(profile).not.toContain(`(subpath "${input.home}/${rel}")`);
    }
  });
});
