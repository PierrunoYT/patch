import { describe, expect, it } from 'vitest';
import { sandboxEnv, scrubEnv } from './env';

describe('scrubEnv', () => {
  it('removes credential-like variables and keeps the rest', () => {
    const out = scrubEnv({
      PATH: '/bin',
      HOME: '/h',
      OPENAI_API_KEY: 'x',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'x',
      DEEZER_ARL_TOKEN: 'x',
      DB_PASSWORD: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      SSH_AUTH_SOCK: '/s',
      SESSIONNAME: 'Console',
      TAURI_SIGNING_PRIVATE_KEY: 'x',
      ComSpec: 'cmd',
    });
    expect(Object.keys(out).sort()).toEqual(['ComSpec', 'HOME', 'PATH', 'SESSIONNAME', 'SSH_AUTH_SOCK']);
  });
});

describe('sandboxEnv', () => {
  const host = {
    PATH: '/bin',
    JAVA_HOME: '/java',
    GOROOT: '/go',
    GOPATH: '/go-work',
    RUSTUP_HOME: '/rustup',
    HOME: '/host-home',
    TMPDIR: '/host-temp',
    DATABASE_URL: 'postgres://user:dummy-password@localhost/db',
    PATCH_PRIVATE_VALUE: 'dummy-secret',
    OPENAI_API_KEY: 'dummy-key',
    SSH_AUTH_SOCK: '/agent',
    GPG_TTY: '/tty',
    KEYCHAIN_PATH: '/keychain',
    XAUTHORITY: '/display',
    DISPLAY: ':0',
    NODE_OPTIONS: '--require /host-startup.cjs',
    PYTHONPATH: '/host-python',
    BASH_ENV: '/host-startup.sh',
    ENV: '/host-startup.sh',
    LD_PRELOAD: '/host.so',
    DYLD_INSERT_LIBRARIES: '/host.dylib',
    JAVA_TOOL_OPTIONS: '-javaagent:/host.jar',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    TZ: 'UTC',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    LOCALAPPDATA: 'C:\\Users\\host\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\host',
    TEMP: 'C:\\host-temp',
    TMP: 'C:\\host-temp',
    PSModulePath: 'C:\\host-modules',
  };

  it.each(['linux', 'darwin'] as const)('allows only runtime locations and locale on %s', (platform) => {
    expect(sandboxEnv(host, platform, '/sandbox-home', '/sandbox-temp')).toEqual({
      PATH: '/bin',
      JAVA_HOME: '/java',
      GOROOT: '/go',
      GOPATH: '/go-work',
      RUSTUP_HOME: '/rustup',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      TZ: 'UTC',
      HOME: '/sandbox-home',
      TMPDIR: '/sandbox-temp',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
  });

  it('handles Windows names case-insensitively and sets profile/temp paths deliberately', () => {
    expect(
      sandboxEnv({ ...host, PATH: undefined, Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' }, 'win32', 'C:\\home', 'C:\\tmp'),
    ).toEqual({
      PATH: 'C:\\tools',
      JAVA_HOME: '/java',
      GOROOT: '/go',
      GOPATH: '/go-work',
      RUSTUP_HOME: '/rustup',
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      LOCALAPPDATA: 'C:\\Users\\host\\AppData\\Local',
      PATHEXT: '.EXE;.CMD',
      HOME: 'C:\\home',
      USERPROFILE: 'C:\\home',
      TMPDIR: 'C:\\tmp',
      TEMP: 'C:\\tmp',
      TMP: 'C:\\tmp',
      PSMODULEPATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    });
  });

  it('supplies only built-in Windows PowerShell modules, even when host module paths are explicitly requested', () => {
    const out = sandboxEnv(
      { systemroot: 'D:\\Windows', PSModulePath: 'C:\\private-modules', PSMODULEPATH: 'C:\\other-modules' },
      'win32',
      'C:\\home',
      'C:\\tmp',
      { envAllowList: 'PSModulePath' },
    );
    expect(out.PSMODULEPATH).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    expect(out).not.toHaveProperty('PSModulePath');
    expect(sandboxEnv({}, 'win32', 'C:\\home', 'C:\\tmp').PSMODULEPATH).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    );
  });

  it('does not accept Unix case aliases or mutate the host environment', () => {
    const env = { Path: '/not-path', lang: 'private', PATH: undefined, HOME: '/host' };
    expect(sandboxEnv(env, 'linux', '/home', '/tmp')).toEqual({
      HOME: '/home',
      TMPDIR: '/tmp',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    expect(env).toEqual({ Path: '/not-path', lang: 'private', PATH: undefined, HOME: '/host' });
  });

  it.each(['linux', 'darwin', 'win32'] as const)('allows only explicit user grants on %s', (platform) => {
    const out = sandboxEnv({ ...host, CC: 'clang', OTHER_PRIVATE_VALUE: 'private' }, platform, '/home', '/tmp', {
      envAllowList:
        ' CC \nDATABASE_URL\nPATCH_PRIVATE_VALUE\nnot=a-name\nNODE_OPTIONS\nSSH_AUTH_SOCK\nBASH_ENV\nLD_PRELOAD\nHOME\nTMPDIR',
      path: ' /trusted/tools ',
    });
    expect(out).toMatchObject({
      CC: 'clang',
      DATABASE_URL: host.DATABASE_URL,
      PATCH_PRIVATE_VALUE: host.PATCH_PRIVATE_VALUE,
      PATH: '/trusted/tools',
      HOME: '/home',
      TMPDIR: '/tmp',
    });
    for (const key of ['NODE_OPTIONS', 'SSH_AUTH_SOCK', 'BASH_ENV', 'LD_PRELOAD', 'OTHER_PRIVATE_VALUE']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('blocks known runtime/startup and agent handles even when explicitly listed', () => {
    const names = [
      'NODE_PATH',
      'ENV',
      'SHELLOPTS',
      'BASHOPTS',
      'ZDOTDIR',
      'DYLD_INSERT_LIBRARIES',
      'JAVA_TOOL_OPTIONS',
      'JDK_JAVA_OPTIONS',
      '_JAVA_OPTIONS',
      'PYTHONPATH',
      'PERL5OPT',
      'RUBYOPT',
      'GIT_CONFIG_COUNT',
      'PSModulePath',
      'GPG_TTY',
      'KEYCHAIN_PATH',
      'XAUTHORITY',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'DBUS_SESSION_BUS_ADDRESS',
    ];
    expect(
      sandboxEnv(Object.fromEntries(names.map((name) => [name, 'blocked'])), 'linux', '/home', '/tmp', {
        envAllowList: names.join('\n'),
      }),
    ).toEqual({ HOME: '/home', TMPDIR: '/tmp', GIT_CONFIG_GLOBAL: '/dev/null' });
  });
});
