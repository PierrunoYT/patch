import { describe, expect, it } from 'vitest';
import {
  bwrapArgs,
  buildLaunch,
  containerArgs,
  decideSandbox,
  describeSandbox,
  seatbeltProfile,
  wantsNetwork,
  type LaunchEnv,
  type SandboxConfig,
  type SandboxSupport,
} from './sandbox';

const config: SandboxConfig = { mode: 'auto', network: 'off', image: 'node:lts', allowedHosts: 'registry.npmjs.org' };
const none: SandboxSupport = { bwrap: false, seatbelt: false, appcontainer: null, container: null };

const env = (existing: string[] = []): LaunchEnv => ({
  cwd: '/home/u/proj',
  home: '/home/u',
  tmp: '/tmp',
  inner: { file: '/bin/bash', args: ['-lc', 'npm test'] },
  command: 'npm test',
  exists: (path) => path === '/home/u/proj/.git' || existing.includes(path),
  gitPaths: ['/home/u/proj/.git'],
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
    expect(profile).not.toContain('network');
  });

  it('allows the network when asked and escapes quotes in paths', () => {
    expect(seatbeltProfile(env(), true)).toContain('(allow network*)');
    expect(seatbeltProfile({ ...env(), cwd: '/a"b' }, false)).toContain('(subpath "/a\\"b")');
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

  it('limits sysctl reads to runtime discovery, never other processes, their arguments or environment', () => {
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
    expect(profile).not.toContain('kern.proc.');
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
    const input = { ...env(), gitPaths: ['/home/u/proj/.git', '/home/u/proj/metadata'] };
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
