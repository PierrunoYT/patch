import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace';

// cmd.exe does not understand Node's \" quoting, so the command line is passed verbatim.
function shortPath(path: string): string {
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).stdout.trim();
}

describe('Workspace native path canonicalization', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it.skipIf(process.platform !== 'win32')('canonicalizes case variants of existing guarded parents', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-workspace-case-'));
    roots.push(root);
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    const workspace = new Workspace(root);
    expect(workspace.resolve('.GIT/HOOKS/new-hook')).toBe(join(realpathSync.native(root), '.git', 'hooks', 'new-hook'));
  });

  it.skipIf(process.platform !== 'win32')(
    'canonicalizes a Windows 8.3 root alias and missing descendants when an alias is available',
    ({ skip }) => {
      const root = mkdtempSync(join(tmpdir(), 'patch-workspace-long-name-'));
      roots.push(root);
      const shortRoot = shortPath(root);
      if (!shortRoot || shortRoot.toLowerCase() === root.toLowerCase()) skip();

      const workspace = new Workspace(shortRoot);
      const canonicalRoot = realpathSync.native(root);
      expect(workspace.root).toBe(canonicalRoot);
      expect(workspace.resolve('missing/deeper/file.txt')).toBe(join(canonicalRoot, 'missing', 'deeper', 'file.txt'));
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      const shortGit = shortPath(join(root, '.git'));
      expect(workspace.resolve(join(shortGit, 'hooks', 'new-hook'))).toBe(
        join(canonicalRoot, '.git', 'hooks', 'new-hook'),
      );
    },
  );
});
