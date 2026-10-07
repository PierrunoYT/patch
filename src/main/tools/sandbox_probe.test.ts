import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSandboxSupport, probeSandboxSupport, refreshSandboxSupport, resetSandboxSupportCache } from './sandbox';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

type Callback = (error: Error | null) => void;
// Probes that have started, by program name; each finishes when the test calls its callback.
let pending: Array<{ file: string; finish: Callback }>;

beforeEach(() => {
  pending = [];
  resetSandboxSupportCache();
  vi.mocked(execFile).mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
    pending.push({ file, finish: callback });
    return {} as never;
  }) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(execFile).mockReset();
});

const programs = () => pending.map((entry) => entry.file);
const finish = (file: string, ok: boolean) =>
  pending.find((entry) => entry.file === file)!.finish(ok ? null : new Error(`${file} failed`));

describe('sandbox support probes (#112)', () => {
  it.each(['win32', 'darwin'] as const)('runs no program for "auto" mode on %s', async (platform) => {
    await refreshSandboxSupport('auto', platform);
    expect(programs()).toEqual([]);
    expect(detectSandboxSupport(platform).container).toBeNull();
  });

  it('probes only bwrap for "auto" mode on Linux', async () => {
    const refreshed = refreshSandboxSupport('auto', 'linux');
    expect(programs()).toEqual(['bwrap']);
    finish('bwrap', true);
    await refreshed;
    expect(detectSandboxSupport('linux')).toMatchObject({ bwrap: true, container: null });
  });

  it('does not block while Docker answers, and reports it once it has', async () => {
    const refreshed = refreshSandboxSupport('container', 'win32');
    // The probe is still running: reading support returns at once, with nothing found yet.
    expect(detectSandboxSupport('win32').container).toBeNull();
    finish('docker', true);
    await refreshed;
    expect(programs()).toEqual(['docker']);
    expect(detectSandboxSupport('win32').container).toBe('docker');
  });

  it('falls back to Podman when Docker is not running', async () => {
    const refreshed = refreshSandboxSupport('container', 'linux');
    finish('docker', false);
    await vi.waitFor(() => expect(programs()).toEqual(['docker', 'podman']));
    finish('podman', true);
    await refreshed;
    expect(detectSandboxSupport('linux').container).toBe('podman');
  });

  it('shares a running probe, caches the result briefly and keeps it while refreshing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = refreshSandboxSupport('container', 'darwin');
    const second = refreshSandboxSupport('container', 'darwin');
    finish('docker', true);
    await Promise.all([first, second]);
    await refreshSandboxSupport('container', 'darwin');
    expect(programs()).toEqual(['docker']);

    vi.setSystemTime(Date.now() + 31_000);
    const refreshed = refreshSandboxSupport('container', 'darwin');
    expect(programs()).toEqual(['docker', 'docker']);
    expect(detectSandboxSupport('darwin').container).toBe('docker');
    pending[1]!.finish(new Error('stopped'));
    await vi.waitFor(() => expect(programs()).toEqual(['docker', 'docker', 'podman']));
    finish('podman', false);
    await refreshed;
    expect(detectSandboxSupport('darwin').container).toBeNull();
  });

  it('probes every program for tests that need the whole picture', async () => {
    const probed = probeSandboxSupport('linux');
    finish('bwrap', false);
    finish('docker', true);
    expect(await probed).toMatchObject({ bwrap: false, container: 'docker' });
  });
});
