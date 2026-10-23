import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGuardedPath } from './guard';
import {
  createdProtectedEntries,
  isProtectedConfigName,
  notePatchWrite,
  patchWriteMark,
  protectedConfigPaths,
  protectedConfigSnapshot,
  quarantineCreatedProtectedEntries,
  settleCreatedProtectedEntries,
  writtenByPatchSince,
} from './sandbox_config';

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
    '.pre-commit-config.yaml',
    'lefthook.yml',
    '.simple-git-hooks.json',
    '.yarnrc.yml',
    '.gitlab-ci.yml',
    '.circleci',
    'Jenkinsfile',
    '.devcontainer',
    'work.code-workspace',
    'GEMINI.md',
    '.cursorrules',
    '.roo',
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
    '.pre-commit-config.yaml',
    'lefthook.yml',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    '.devcontainer/devcontainer.json',
    'my.code-workspace',
    'GEMINI.md',
    '.cursorrules',
    '.roo/rules.md',
  ])('is asked about by the edit tools: %s', (path) => {
    expect(isProtectedConfigName(path.split('/')[0]!)).toBe(true);
    expect(isGuardedPath(path)).toBe(true);
  });
});

describe('entries a command creates (#262)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-sandbox-created-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds protected names that were absent, including case variants', () => {
    mkdirSync(join(root, '.github'));
    const before = protectedConfigSnapshot(root);
    mkdirSync(join(root, '.VSCode'));
    writeFileSync(join(root, '.mcp.json'), '{}');
    mkdirSync(join(root, 'src'));
    expect(createdProtectedEntries(root, before).sort()).toEqual(['.VSCode', '.mcp.json']);
  });

  it('does not report entries that were already there, whatever their case', () => {
    mkdirSync(join(root, '.vscode'));
    const before = protectedConfigSnapshot(root);
    expect(createdProtectedEntries(root, before)).toEqual([]);
  });

  it('moves what was created aside, keeping its content, under a name nothing reads (#276)', () => {
    const before = protectedConfigSnapshot(root);
    mkdirSync(join(root, '.vscode'));
    writeFileSync(join(root, '.vscode', 'tasks.json'), '{}');
    const moved = quarantineCreatedProtectedEntries(root, createdProtectedEntries(root, before));
    const target = moved.get('.vscode')!;
    expect(target).toMatch(/^\.vscode\.patch-quarantine-/);
    expect(isProtectedConfigName(target)).toBe(false);
    expect(readdirSync(root)).toEqual([target]);
    expect(readFileSync(join(root, target, 'tasks.json'), 'utf8')).toBe('{}');
  });

  it('moves a created entry aside once no other command runs, and only reports it before', () => {
    const before = protectedConfigSnapshot(root);
    const mark = patchWriteMark();
    writeFileSync(join(root, 'AGENTS.md'), 'planted');
    expect(settleCreatedProtectedEntries(root, before, mark, false)).toMatch(/another command is still running/);
    expect(readdirSync(root)).toEqual(['AGENTS.md']);
    expect(settleCreatedProtectedEntries(root, before, mark, true)).toMatch(/Patch moved AGENTS\.md to AGENTS\.md\./);
    expect(readdirSync(root)).toEqual([expect.stringMatching(/^AGENTS\.md\.patch-quarantine-/)]);
    expect(settleCreatedProtectedEntries(root, before, mark, true)).toBe('');
  });

  it('leaves an entry the edit tools wrote to while the command ran, with a note (#276)', () => {
    const before = protectedConfigSnapshot(root);
    const mark = patchWriteMark();
    mkdirSync(join(root, '.vscode'));
    writeFileSync(join(root, '.vscode', 'launch.json'), '{}');
    notePatchWrite(root, '.vscode/launch.json');
    notePatchWrite(root, 'src/other.ts');
    mkdirSync(join(root, '.github'));
    const note = settleCreatedProtectedEntries(root, before, mark, true);
    expect(note).toMatch(/\.vscode appeared while the command ran, and the edit tools wrote to it too/);
    expect(note).toMatch(/Patch moved \.github to \.github\.patch-quarantine-/);
    expect(existsSync(join(root, '.vscode', 'launch.json'))).toBe(true);
    expect(existsSync(join(root, '.github'))).toBe(false);
  });

  it('does not count an edit made before the command started', () => {
    notePatchWrite(root, join(root, 'CLAUDE.md'));
    const before = protectedConfigSnapshot(root);
    const mark = patchWriteMark();
    writeFileSync(join(root, 'CLAUDE.md'), 'planted');
    expect(writtenByPatchSince(root, 'claude.md', mark)).toBe(false);
    expect(settleCreatedProtectedEntries(root, before, mark, true)).toMatch(/Patch moved CLAUDE\.md/);
  });
});
