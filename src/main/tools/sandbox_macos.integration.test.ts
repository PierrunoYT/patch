import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxEnv } from './env';
import { buildLaunch, detectSandboxSupport, systemLaunchEnv } from './sandbox';

const support = detectSandboxSupport();
const clangAvailable =
  process.platform === 'darwin' && spawnSync('clang', ['--version'], { stdio: 'ignore', timeout: 8000 }).status === 0;
const available = process.platform === 'darwin' && support.seatbelt && clangAvailable;
const skipReason =
  process.platform !== 'darwin'
    ? 'non-macOS host'
    : !support.seatbelt
      ? 'sandbox-exec unavailable'
      : !clangAvailable
        ? 'clang unavailable'
        : '';

const probeSource = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <semaphore.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (strcmp(argv[1], "lookup") == 0) {
    if (argc < 3) return 64;
    mach_port_t service = MACH_PORT_NULL;
    kern_return_t result = bootstrap_look_up(bootstrap_port, argv[2], &service);
    if (service != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), service);
    printf("{\"entered\":true,\"result\":%d}\n", result);
    return 0;
  }
  if (strcmp(argv[1], "shm") == 0) {
    if (argc < 3) return 64;
    errno = 0;
    int fd = shm_open(argv[2], O_CREAT | O_EXCL | O_RDWR, 0600);
    int saved = errno;
    if (fd >= 0) {
      close(fd);
      shm_unlink(argv[2]);
    }
    printf("{\"entered\":true,\"opened\":%s,\"error\":%d}\n", fd >= 0 ? "true" : "false", saved);
    return 0;
  }
  if (strcmp(argv[1], "sysctl") == 0) {
    if (argc < 3) return 64;
    char value[256];
    size_t size = sizeof(value);
    errno = 0;
    int result = sysctlbyname(argv[2], value, &size, NULL, 0);
    int saved = errno;
    printf("{\"entered\":true,\"read\":%s,\"error\":%d}\n", result == 0 ? "true" : "false", saved);
    return 0;
  }
  if (strcmp(argv[1], "proc") == 0) {
    if (argc < 3) return 64;
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, atoi(argv[2])};
    struct kinfo_proc info;
    size_t size = sizeof(info);
    memset(&info, 0, sizeof(info));
    errno = 0;
    int result = sysctl(mib, 4, &info, &size, NULL, 0);
    int saved = errno;
    int found = result == 0 && size > 0 && info.kp_proc.p_pid == mib[3];
    printf("{\"entered\":true,\"read\":%s,\"error\":%d}\n", found ? "true" : "false", saved);
    return 0;
  }
  if (strcmp(argv[1], "sem") == 0) {
    if (argc < 3) return 64;
    errno = 0;
    sem_t *semaphore = sem_open(argv[2], O_CREAT | O_EXCL, 0600, 1);
    int saved = errno;
    int opened = semaphore != SEM_FAILED;
    if (opened) {
      sem_close(semaphore);
      sem_unlink(argv[2]);
    }
    printf("{\"entered\":true,\"opened\":%s,\"error\":%d}\n", opened ? "true" : "false", saved);
    return 0;
  }
  return 64;
}
`;

const appSource = String.raw`
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  FILE *marker = fopen(argv[1], "w");
  if (marker == NULL) return 1;
  fputs("LAUNCHED", marker);
  return fclose(marker) == 0 ? 0 : 1;
}
`;

const launchServicesName = 'com.apple.coreservices.launchservicesd';
const optionalMachServices = ['com.apple.nsurlsessiond', 'com.apple.nsurlsessiond.agent'];

type ProbeResult = {
  entered: boolean;
  result?: number;
  opened?: boolean;
  read?: boolean;
  error?: number;
};

describe.skipIf(!available)(`real macOS Seatbelt regressions${skipReason ? ` (${skipReason})` : ''}`, () => {
  let fixture: string;
  let home: string;
  let project: string;
  let temp: string;
  let probe: string;
  let app: string;

  const diagnostic = (result: ReturnType<typeof spawnSync>) =>
    `status=${String(result.status)} error=${String(result.error)} stdout=${String(result.stdout)} stderr=${String(result.stderr)}`;

  const runHostProbe = (...args: string[]): ProbeResult => {
    const result = spawnSync(probe, args, { cwd: project, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, diagnostic(result)).toBe(0);
    return JSON.parse(result.stdout.trim()) as ProbeResult;
  };

  const runSandboxed = (file: string, args: string[], network = false) => {
    const command = [file, ...args].join(' ');
    const env = systemLaunchEnv({
      cwd: project,
      home,
      tmp: temp,
      inner: { file, args },
      command,
      containerName: 'unused-seatbelt-test',
      image: '',
    });
    const launch = buildLaunch({ kind: 'seatbelt', network }, env, null);
    return spawnSync(launch.file, launch.args, {
      cwd: project,
      encoding: 'utf8',
      timeout: 15_000,
      env: sandboxEnv(process.env, 'darwin', home, temp),
    });
  };

  const runSandboxedProbe = (args: string[], network = false): ProbeResult => {
    const result = runSandboxed(probe, args, network);
    expect(result.status, diagnostic(result)).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as ProbeResult;
    expect(parsed.entered).toBe(true);
    return parsed;
  };

  const expectBlockedMachLookup = (service: string) => {
    for (const network of [false, true]) {
      const result = runSandboxedProbe(['lookup', service], network);
      expect(result.result, `network=${String(network)} service=${service}`).not.toBe(0);
    }
  };

  beforeAll(() => {
    // Keep HOME outside the broadly writable system temp paths in the production profile.
    fixture = realpathSync(mkdtempSync(join(homedir(), '.patch-macos-sandbox-')));
    home = join(fixture, 'home');
    project = join(fixture, 'project');
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'patch-macos-sandbox-temp-')));
    mkdirSync(home);
    mkdirSync(join(project, '.git'), { recursive: true });

    const probeFile = join(project, 'sandbox-probe.c');
    probe = join(project, 'sandbox-probe');
    writeFileSync(probeFile, probeSource);
    const compiledProbe = spawnSync('clang', [probeFile, '-o', probe], { encoding: 'utf8', timeout: 30_000 });
    expect(compiledProbe.status, diagnostic(compiledProbe)).toBe(0);

    app = join(project, 'PatchSandboxLaunchProbe.app');
    const executable = join(app, 'Contents', 'MacOS', 'PatchSandboxLaunchProbe');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PatchSandboxLaunchProbe</string>
<key>CFBundleIdentifier</key><string>dev.patch.sandbox-launch-probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`,
    );
    const appFile = join(project, 'sandbox-app.c');
    writeFileSync(appFile, appSource);
    const compiledApp = spawnSync('clang', [appFile, '-o', executable], { encoding: 'utf8', timeout: 30_000 });
    expect(compiledApp.status, diagnostic(compiledApp)).toBe(0);
  });

  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    if (temp) rmSync(temp, { recursive: true, force: true });
  });

  it('blocks the confirmed host LaunchServices Mach service with network both off and on', () => {
    expect(runHostProbe('lookup', launchServicesName)).toMatchObject({ entered: true, result: 0 });
    expectBlockedMachLookup(launchServicesName);
  });

  const configuredServices = (process.env.PATCH_MACOS_MACH_SERVICES ?? '')
    .split(/[\r\n,]+/)
    .map((service) => service.trim())
    .filter(Boolean);
  for (const service of [...new Set([...optionalMachServices, ...configuredServices])]) {
    it(`blocks optional host Mach service ${service} when it is registered`, (context) => {
      const control = runHostProbe('lookup', service);
      if (control.result !== 0) context.skip(`host service ${service} is not registered`);
      expectBlockedMachLookup(service);
    });
  }

  it('does not grant arbitrary POSIX shared-memory names', () => {
    const name = `/patch-sandbox-${process.pid}-${Date.now()}`;
    expect(runHostProbe('shm', name)).toMatchObject({ entered: true, opened: true });
    expect(runSandboxedProbe(['shm', name])).toMatchObject({ entered: true, opened: false });
  });

  it.each(['kern.ostype', 'kern.boottime', 'hw.ncpu'])('keeps the %s read needed by command-line programs', (name) => {
    expect(runHostProbe('sysctl', name)).toMatchObject({ entered: true, read: true });
    expect(runSandboxedProbe(['sysctl', name])).toMatchObject({ entered: true, read: true });
  });

  it('does not reveal host processes through kern.proc sysctls', () => {
    const pid = String(process.pid);
    expect(runHostProbe('proc', pid)).toMatchObject({ entered: true, read: true });
    expect(runSandboxedProbe(['proc', pid])).toMatchObject({ entered: true, read: false });
  });

  it('allows the named semaphores Python multiprocessing locks use', () => {
    const name = `/patch-sem-${process.pid}`;
    expect(runHostProbe('sem', name)).toMatchObject({ entered: true, opened: true });
    expect(runSandboxedProbe(['sem', name])).toMatchObject({ entered: true, opened: true });
  });

  it('blocks LaunchServices from starting a disposable application', () => {
    const marker = join(project, 'launch-marker');
    const control = spawnSync('/usr/bin/open', ['-W', '-n', app, '--args', marker], {
      cwd: project,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(control.status, diagnostic(control)).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('LAUNCHED');
    rmSync(marker);

    const denied = runSandboxed('/usr/bin/open', ['-W', '-n', app, '--args', marker]);
    expect(denied.error, diagnostic(denied)).toBeUndefined();
    expect(denied.status, diagnostic(denied)).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  for (const tool of ['node', 'npm', 'git', 'python3', 'cargo', 'clang']) {
    const installed =
      process.platform === 'darwin' &&
      spawnSync('/usr/bin/which', [tool], { stdio: 'ignore', timeout: 8000, env: process.env }).status === 0;
    it.skipIf(!installed)(`runs optional ${tool} smoke test from the sandbox PATH`, () => {
      const result = runSandboxed('/bin/sh', ['-c', `${tool} --version`]);
      expect(result.status, diagnostic(result)).toBe(0);
      expect(`${result.stdout}${result.stderr}`.trim()).not.toBe('');
    });
  }
});
