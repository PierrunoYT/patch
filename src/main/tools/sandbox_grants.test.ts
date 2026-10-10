import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bwrapArgs, containerArgs, decideSandbox, seatbeltProfile, type LaunchEnv } from './sandbox';
import { describeGrants, grantsKey, resolvePathGrants, type GrantContext } from './sandbox_grants';
import { buildHelperRequest } from './sandbox_windows';
import { runCommandTool, ShellRunner } from './shell';
import type { ToolContext } from './types';

const config = { mode: 'auto' as const, network: 'off' as const, image: 'node:lts', allowedHosts: '' };
const none = { bwrap: false, seatbelt: false, appcontainer: null, container: null };

describe('per-command path grants (#126)', () => {
  let fixture: string;
  let ctx: GrantContext;
  const real = (path: string) => realpathSync.native(path);
  const dir = (name: string) => {
    const path = join(fixture, name);
    mkdirSync(path, { recursive: true });
    return real(path);
  };

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'patch-grants-'));
    const project = dir('home/work/project');
    ctx = {
      cwd: project,
      home: dir('home'),
      protectedPaths: [join(project, '.git')],
      sensitivePaths: [dir('home/app-data')],
    };
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it('canonicalizes, deduplicates and collapses overlaps without widening anything', () => {
    const outer = dir('home/data');
    const inner = dir('home/data/inner');
    const other = dir('home/other');
    mkdirSync(join(inner, 'deep'));
    const grants = resolvePathGrants(
      { readPaths: [inner, join(inner, '..', 'inner'), other, join(other, '.')], writePaths: [outer, inner] },
      ctx,
    );
    expect(grants.write).toEqual([outer]);
    // Inside a write grant, a read grant adds nothing; `other` stays read-only and appears once.
    expect(grants.read).toEqual([other]);
  });

  it('keeps a read grant that contains a write grant, so the narrower write stays writable', () => {
    const outer = dir('home/data');
    const inner = dir('home/data/inner');
    expect(resolvePathGrants({ readPaths: [outer], writePaths: [inner] }, ctx)).toEqual({
      read: [outer],
      write: [inner],
    });
  });

  it('follows links to their real target and never opens a link-only parent', () => {
    const target = dir('home/target');
    const link = join(fixture, 'link');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(resolvePathGrants({ readPaths: [link] }, ctx).read).toEqual([target]);
  });

  it('rejects relative, missing, root, home, project, protected and sensitive paths', () => {
    const file = join(fixture, 'file.txt');
    writeFileSync(file, 'x');
    const bad: Array<[Record<string, string[]>, RegExp]> = [
      [{ readPaths: ['relative/path'] }, /absolute/],
      [{ readPaths: [join(fixture, 'missing')] }, /does not exist/],
      [{ writePaths: [join(fixture, 'missing', 'child.txt')] }, /does not exist/],
      [{ readPaths: [parse(fixture).root] }, /root/],
      [{ readPaths: [ctx.home] }, /home folder/],
      [{ writePaths: [fixture] }, /home folder|project folder/],
      [{ writePaths: [ctx.cwd] }, /project folder/],
      [{ readPaths: [join(ctx.cwd, '..')] }, /project folder/],
      [{ writePaths: [dir('home/work/project/sub')] }, /inside the project/],
      [{ readPaths: [ctx.sensitivePaths[0]!] }, /sensitive/],
    ];
    for (const [request, message] of bad)
      expect(() => resolvePathGrants(request, ctx), JSON.stringify(request)).toThrow(message);
    expect(resolvePathGrants({ readPaths: [file] }, ctx).read).toEqual([real(file)]);
  });

  it('refuses a write grant that overlaps protected paths, even through a link', () => {
    const outside = dir('home/outside');
    const protectedDir = join(outside, 'metadata');
    mkdirSync(protectedDir);
    const guarded = { ...ctx, protectedPaths: [real(protectedDir)] };
    expect(() => resolvePathGrants({ writePaths: [outside] }, guarded)).toThrow(/protected/);
    const link = join(fixture, 'metadata-link');
    symlinkSync(protectedDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolvePathGrants({ writePaths: [link] }, guarded)).toThrow(/protected/);
    expect(resolvePathGrants({ readPaths: [protectedDir] }, guarded).read).toEqual([real(protectedDir)]);
  });

  it('binds approval to the exact canonical set', () => {
    const a = dir('home/a');
    const b = dir('home/b');
    const first = resolvePathGrants({ readPaths: [a] }, ctx);
    expect(grantsKey(first)).toBe(grantsKey(resolvePathGrants({ readPaths: [join(a, '.')] }, ctx)));
    expect(grantsKey(first)).not.toBe(grantsKey(resolvePathGrants({ readPaths: [b] }, ctx)));
    expect(grantsKey(first)).not.toBe(grantsKey(resolvePathGrants({ writePaths: [a] }, ctx)));
    expect(describeGrants({ read: [a], write: [b] })).toMatch(
      /Read-only access to: .*a\. Read and write access to: .*b\./,
    );
  });

  describe('backends', () => {
    const grants = { read: ['/srv/read'], write: ['/srv/write'] };
    const env: LaunchEnv = {
      cwd: '/proj',
      home: '/home/u',
      tmp: '/tmp',
      inner: { file: '/bin/bash', args: ['-c', 'x'] },
      command: 'x',
      exists: () => false,
      protectedPaths: ['/proj/.git'],
      containerName: 'c',
      image: 'img',
      grants,
    };

    it('bubblewrap mounts read grants read-only and write grants writable, before the protected paths', () => {
      const args = bwrapArgs(env, false);
      const at = (flag: string, path: string) => args.findIndex((a, i) => a === flag && args[i + 1] === path);
      expect(at('--ro-bind', '/srv/read')).toBeGreaterThan(-1);
      expect(at('--bind', '/srv/write')).toBeGreaterThan(-1);
      expect(at('--bind', '/srv/write')).toBeLessThan(at('--ro-bind', '/proj/.git'));
      expect(args).not.toContain('--share-net');
      expect(bwrapArgs({ ...env, grants: undefined }, false)).not.toContain('/srv/read');
    });

    it('Seatbelt opens reads and writes for the grants only, and still denies protected writes last', () => {
      const profile = seatbeltProfile({ ...env }, false);
      expect(profile).toMatch(/\(allow file-read\* [^\n]*\(subpath "\/srv\/read"\)[^\n]*\(subpath "\/srv\/write"\)/);
      const write = profile.split('\n').find((line) => line.startsWith('(allow file-write*'))!;
      expect(write).toContain('/srv/write');
      expect(write).not.toContain('/srv/read');
      expect(profile.indexOf('(deny file-write* (subpath "/proj/.git"))')).toBeGreaterThan(profile.indexOf(write));
      expect(profile).not.toContain('(allow network*)');
    });

    it('a container mounts grants at their path and rejects what it cannot mount', () => {
      const { args } = containerArgs('docker', env, false);
      expect(args).toContain('type=bind,src=/srv/read,dst=/srv/read,readonly');
      expect(args).toContain('type=bind,src=/srv/write,dst=/srv/write');
      expect(args).toContain('none');
      expect(() => containerArgs('docker', { ...env, grants: { read: ['C:\\data'], write: [] } }, false)).toThrow(
        /POSIX path/,
      );
      expect(() => containerArgs('docker', { ...env, grants: { read: ['/a,b'], write: [] } }, false)).toThrow(
        /POSIX path/,
      );
    });

    it('the Windows policy adds the grants to this run only and keeps protected paths denied', () => {
      const request = buildHelperRequest({
        id: 1,
        shell: { file: 'powershell.exe', args: [] },
        cwd: 'C:\\p',
        env: { SystemRoot: 'C:\\Windows' },
        network: false,
        home: 'C:\\Users\\u',
        exists: () => false,
        protectedPaths: ['C:\\p\\.git'],
        grants: { read: ['D:\\read'], write: ['D:\\write'] },
      });
      expect(request.readWrite).toEqual(['C:\\p', 'D:\\write']);
      expect(request.readOnly).toEqual(['D:\\read', 'C:\\p\\.git']);
      expect(request.denyWrite).toEqual(['C:\\p\\.git']);
      expect(request.network).toBe(false);
    });

    it('refuses grants a backend cannot honour: unsandboxed and a disabled sandbox', () => {
      const access = { readPaths: ['/x'] };
      expect(decideSandbox('x', config, none, { ...access, unsandboxed: true }, 'linux').kind).toBe('unavailable');
      expect(decideSandbox('x', { ...config, mode: 'off' }, none, access, 'linux').kind).toBe('unavailable');
      expect(decideSandbox('x', config, { ...none, bwrap: true }, access, 'linux')).toEqual({
        kind: 'bwrap',
        network: false,
      });
      // A missing native backend still fails closed.
      expect(decideSandbox('x', config, none, access, 'linux').kind).toBe('unavailable');
    });
  });

  describe('the run_command tool', () => {
    it('always asks for new grants, whatever the mode, and they never turn on the network', () => {
      const shell = new ShellRunner(
        () => ctx.cwd,
        () => config,
        () => none,
      );
      const context = { shell } as ToolContext;
      expect(runCommandTool.mustAsk?.({ command: 'x', read_paths: [fixture] }, context)).toBe(true);
      expect(runCommandTool.mustAsk?.({ command: 'x', write_paths: [fixture] }, context)).toBe(true);
      expect(runCommandTool.mustAsk?.({ command: 'x', read_paths: [] }, context)).toBe(false);
      expect(shell.describe('x', { readPaths: [fixture] }).text).not.toMatch(/unrestricted network/);
    });

    it('shows the effective scope on the card and does not run a declined or invalid request', async () => {
      const outside = dir('home/shared');
      const shell = new ShellRunner(
        () => ctx.cwd,
        () => config,
        () => ({ ...none, bwrap: true, seatbelt: true, appcontainer: 'unused-helper.exe' }),
      );
      const context = { shell } as ToolContext;
      const input = { command: 'ls', read_paths: [join(outside, '.')] };
      const preview = await runCommandTool.preview?.(input, context);
      expect(preview?.note).toContain(`Read-only access to: ${outside}`);
      expect(preview?.note).toContain('Network access is unchanged');
      await expect(
        runCommandTool.preview?.({ command: 'ls', read_paths: [parse(outside).root] }, context),
      ).rejects.toThrow(/root/);
      const unsandboxed = await shell.run('echo no', { access: { unsandboxed: true, readPaths: [outside] } });
      expect(unsandboxed.output).toMatch(/cannot be combined with unsandboxed/);
      expect(unsandboxed.sandbox).toBeUndefined();
    });

    it('does not start a command whose paths changed after approval', async () => {
      const a = dir('home/a');
      const b = dir('home/b');
      const link = join(fixture, 'switch');
      symlinkSync(a, link, process.platform === 'win32' ? 'junction' : 'dir');
      const shell = new ShellRunner(
        () => ctx.cwd,
        () => config,
        () => ({ ...none, bwrap: true, seatbelt: true, appcontainer: 'unused-helper.exe' }),
      );
      const approved = grantsKey(await shell.resolveGrants({ readPaths: [link] }));
      rmSync(link, { recursive: true, force: true });
      symlinkSync(b, link, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await shell.run('echo no', { access: { readPaths: [link], approvedGrants: approved } });
      expect(result.output).toMatch(/resolve differently/);
      expect(result.exitCode).toBeNull();
    });
  });
});
