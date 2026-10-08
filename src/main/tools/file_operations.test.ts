import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeProjectFiles, readProjectFile } from './file_operations';
import { Workspace } from './workspace';
import { readFileTool, writeFileTool, editFileTool } from './files';
import { applyPatchTool } from './apply_patch';
import { EditBackups } from './edit_backups';
import { sha256 } from './text_files';
import type { ToolContext } from './types';

describe('native project file operations (#144)', () => {
  let fixture: string;
  let project: string;
  let outside: string;
  let workspace: Workspace;
  let context: ToolContext;
  const bytes = (value: string) => Buffer.from(value);

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'patch-file-ops-'));
    project = join(fixture, 'project');
    outside = join(fixture, 'outside');
    mkdirSync(join(project, 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(project, 'sub/x.txt'), 'inside\n');
    writeFileSync(join(outside, 'x.txt'), 'outside\n');
    workspace = new Workspace(project);
    context = { workspace, readFiles: new Map(), signal: new AbortController().signal } as ToolContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('creates, updates and deletes through the real helper, preserving exact bytes', async () => {
    const content = Buffer.from([0xff, 0x00, 0x0d, 0x0a]);
    await changeProjectFiles(workspace, [
      { path: 'nested/deeper/new.bin', before: null, after: content },
      { path: 'sub/x.txt', before: bytes('inside\n'), after: bytes('changed\r\n') },
    ]);
    expect(await readProjectFile(workspace, 'nested/deeper/new.bin')).toEqual(content);
    expect(readFileSync(join(project, 'sub/x.txt'))).toEqual(bytes('changed\r\n'));
    await changeProjectFiles(workspace, [{ path: 'nested/deeper/new.bin', before: content, after: null }]);
    expect(existsSync(join(project, 'nested/deeper/new.bin'))).toBe(false);
  });

  it('accepts absolute root aliases without erasing links below that root', async () => {
    const alias = join(fixture, 'root-alias');
    symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readProjectFile(workspace, join(alias, 'sub/x.txt'))).toEqual(bytes('inside\n'));
    await changeProjectFiles(workspace, [
      { path: join(alias, 'new/deeper.txt'), before: null, after: bytes('absolute alias') },
    ]);
    expect(readFileSync(join(project, 'new/deeper.txt'), 'utf8')).toBe('absolute alias');
    symlinkSync(project, join(project, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      changeProjectFiles(workspace, [
        { path: join(alias, 'loop/sub/x.txt'), before: bytes('inside\n'), after: bytes('bad') },
      ]),
    ).rejects.toThrow();
    expect(readFileSync(join(project, 'sub/x.txt'), 'utf8')).toBe('inside\n');
  });

  it('checks the entire batch before changing the first file', async () => {
    await expect(
      changeProjectFiles(workspace, [
        { path: 'sub/x.txt', before: bytes('inside\n'), after: bytes('changed') },
        { path: 'missing.txt', before: bytes('not missing'), after: null },
      ]),
    ).rejects.toThrow(/changed before/);
    expect(readFileSync(join(project, 'sub/x.txt'), 'utf8')).toBe('inside\n');
  });

  it('independently rejects traversal, parent links and hard-linked write targets', async () => {
    await expect(
      changeProjectFiles(workspace, [{ path: '../outside/x.txt', before: bytes('outside\n'), after: null }]),
    ).rejects.toThrow();
    symlinkSync(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      changeProjectFiles(workspace, [{ path: 'link/x.txt', before: bytes('outside\n'), after: bytes('bad') }]),
    ).rejects.toThrow();
    linkSync(join(outside, 'x.txt'), join(project, 'hard.txt'));
    await expect(
      changeProjectFiles(workspace, [{ path: 'hard.txt', before: bytes('outside\n'), after: bytes('bad') }]),
    ).rejects.toThrow(/hard-linked/);
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('outside\n');
  });

  it.each(['write', 'edit', 'patch', 'undo'] as const)(
    'does not follow a parent swapped after resolution during %s',
    async (kind) => {
      await readFileTool.run({ path: 'sub/x.txt' }, context);
      const backups = new EditBackups(join(fixture, 'backups'));
      const chat = '11111111-1111-1111-1111-111111111111';
      backups.record(chat, 'tool', { path: 'sub/x.txt', before: bytes('original\n'), afterHash: sha256('inside\n') });
      const resolve = workspace.resolve.bind(workspace);
      let swapped = false;
      vi.spyOn(workspace, 'resolve').mockImplementation((path) => {
        const result = resolve(path);
        if (!swapped) {
          swapped = true;
          renameSync(join(project, 'sub'), join(project, 'held'));
          symlinkSync(outside, join(project, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
        }
        return result;
      });
      const run =
        kind === 'write'
          ? writeFileTool.run({ path: 'sub/x.txt', content: 'changed\n' }, context)
          : kind === 'edit'
            ? editFileTool.run({ path: 'sub/x.txt', old_string: 'inside', new_string: 'changed' }, context)
            : kind === 'patch'
              ? applyPatchTool.run({ patch: '*** Begin Patch\n*** Delete File: sub/x.txt\n*** End Patch' }, context)
              : backups.undo(chat, 'tool', workspace);
      await expect(run).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('outside\n');
      expect(readFileSync(join(project, 'held/x.txt'), 'utf8')).toBe('inside\n');
    },
  );

  it.each(['write', 'edit', 'patch', 'undo'] as const)(
    'does not erase an in-project protected link introduced after approval during %s',
    async (kind) => {
      mkdirSync(join(project, '.git'));
      writeFileSync(join(project, '.git/x.txt'), 'inside\n');
      await readFileTool.run({ path: 'sub/x.txt' }, context);
      await readFileTool.run({ path: '.git/x.txt' }, context);
      expect(writeFileTool.mustAsk?.({ path: 'sub/x.txt', content: 'changed\n' }, context)).toBe(false);
      const backups = new EditBackups(join(fixture, 'backups'));
      const chat = '11111111-1111-1111-1111-111111111111';
      backups.record(chat, 'tool', { path: 'sub/x.txt', before: bytes('original\n'), afterHash: sha256('inside\n') });
      renameSync(join(project, 'sub'), join(project, 'held'));
      symlinkSync(join(project, '.git'), join(project, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
      const run =
        kind === 'write'
          ? writeFileTool.run({ path: 'sub/x.txt', content: 'changed\n' }, context)
          : kind === 'edit'
            ? editFileTool.run({ path: 'sub/x.txt', old_string: 'inside', new_string: 'changed' }, context)
            : kind === 'patch'
              ? applyPatchTool.run({ patch: '*** Begin Patch\n*** Delete File: sub/x.txt\n*** End Patch' }, context)
              : backups.undo(chat, 'tool', workspace);
      await expect(run).rejects.toThrow();
      expect(readFileSync(join(project, '.git/x.txt'), 'utf8')).toBe('inside\n');
      expect(readFileSync(join(project, 'held/x.txt'), 'utf8')).toBe('inside\n');
    },
  );
});
