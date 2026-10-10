import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGuardedPath } from './guard';
import { isProtectedConfigName, protectedConfigPaths } from './sandbox_config';

describe('protectedConfigPaths', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-sandbox-config-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns the protected entries that exist at the top of the project', () => {
    mkdirSync(join(root, '.vscode'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# rules');
    writeFileSync(join(root, '.mcp.json'), '{}');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{}');
    // Only top-level entries: the whole folder is protected, so nested copies need no entry of their own.
    mkdirSync(join(root, 'src', '.vscode'));
    expect(protectedConfigPaths(root).sort()).toEqual(
      ['.github', '.mcp.json', '.vscode', 'AGENTS.md'].map((name) => join(root, name)).sort(),
    );
  });

  it('matches names without regard to case and keeps the name on disk', () => {
    mkdirSync(join(root, '.VSCode'));
    writeFileSync(join(root, 'claude.md'), '');
    expect(protectedConfigPaths(root).sort()).toEqual([join(root, '.VSCode'), join(root, 'claude.md')].sort());
  });

  it.skipIf(process.platform === 'win32')('leaves out links', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# rules');
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(protectedConfigPaths(root)).toEqual([join(root, 'AGENTS.md')]);
  });

  it('returns nothing for a folder that cannot be read', () => {
    expect(protectedConfigPaths(join(root, 'missing'))).toEqual([]);
  });
});

describe('isProtectedConfigName', () => {
  it.each([
    '.vscode',
    '.idea',
    '.claude',
    '.agents',
    '.patch',
    '.mcp.json',
    'AGENTS.md',
    '.envrc',
    '.husky',
    '.github',
  ])('protects %s', (name) => expect(isProtectedConfigName(name)).toBe(true));

  it.each(['src', '.gitignore', 'package.json', 'README.md', '.env.example'])('leaves %s writable', (name) =>
    expect(isProtectedConfigName(name)).toBe(false),
  );

  // A protected entry must be one the edit tools ask about, so changing it stays possible with the user's approval.
  it.each([
    ...['.agents', '.amp', '.claude', '.codex', '.continue', '.cursor', '.gemini', '.husky', '.idea', '.kilo']
      .concat(['.kilocode', '.patch', '.vscode', '.windsurf', '.zed'])
      .map((name) => `${name}/settings.json`),
    '.mcp.json',
    'AGENTS.md',
    'CLAUDE.md',
    '.envrc',
  ])('is asked about by the edit tools: %s', (path) => {
    expect(isProtectedConfigName(path.split('/')[0]!)).toBe(true);
    expect(isGuardedPath(path)).toBe(true);
  });
});
