import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHunks, applyPatchTool, invalidWindowsName, parsePatch } from './apply_patch';
import { EditBackups } from './edit_backups';
import { writeFileTool } from './files';
import { commandStopsSettled, ShellRunner } from './shell';
import type { ToolContext } from './types';
import { Workspace } from './workspace';

let root: string;
let context: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-patch-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'alpha\nbeta\n');
  const workspace = new Workspace(root);
  context = {
    workspace,
    signal: new AbortController().signal,
    readFiles: new Map([
      [join(workspace.root, 'src', 'a.ts'), null],
      [join(workspace.root, 'src', 'b.ts'), null],
    ]),
    shell: new ShellRunner(() => workspace.root),
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
});

afterEach(async () => {
  context.shell.stopAll();
  // Stops run in the background (#112); on Windows the folder stays busy until they finish.
  await commandStopsSettled();
  rmSync(root, { recursive: true, force: true });
});

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
const run = (text: string) => applyPatchTool.run(applyPatchTool.schema!.parse({ patch: text }), context);
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('parsePatch', () => {
  it('parses add, delete, update and move', () => {
    const ops = parsePatch(
      patch(
        '*** Add File: n.txt',
        '+hello',
        '*** Delete File: old.txt',
        '*** Update File: a.ts',
        '*** Move to: b.ts',
        '@@ fn',
        ' keep',
        '-gone',
        '+new',
        '*** End of File',
      ),
    );
    expect(ops.map((op) => op.kind)).toEqual(['add', 'delete', 'update']);
    expect(ops[2]).toMatchObject({ moveTo: 'b.ts', hunks: [{ anchor: 'fn', atEnd: true }] });
  });

  it.each([
    ['missing begin', 'nothing\n*** End Patch'],
    ['missing end', '*** Begin Patch\n*** Add File: a\n+x'],
    ['no files', '*** Begin Patch\n*** End Patch'],
    ['add line without +', patch('*** Add File: a', 'x')],
    ['bad hunk line', patch('*** Update File: a', '@@', '?x')],
  ])('rejects %s', (_name, text) => {
    expect(() => parsePatch(text)).toThrow();
  });
});

describe('applyHunks', () => {
  const hunk = (anchor: string | null, ...lines: string[]) => ({
    anchor,
    atEnd: false,
    lines: lines.map((line) => ({ prefix: line[0] as ' ' | '-' | '+', text: line.slice(1) })),
  });

  it("keeps the file's own context lines when the hunk matched loosely (#246)", () => {
    // A BOM on the first line, which trim() would drop.
    const bom = applyHunks('﻿first\nsecond\n', [hunk(null, ' first', '-second', '+SECOND')], 'f');
    expect(bom).toBe('﻿first\nSECOND\n');
    // A tab-indented context line matched by spaces stays a tab.
    expect(applyHunks('\tindented\nold\n', [hunk(null, '     indented', '-old', '+new')], 'f')).toBe(
      '\tindented\nnew\n',
    );
    // Trailing spaces on a context line survive.
    expect(applyHunks('keep  \nold\n', [hunk(null, ' keep', '-old', '+new')], 'f')).toBe('keep  \nnew\n');
  });

  it('applies several hunks in order and keeps the final newline', () => {
    expect(applyHunks('a\nb\nc\nd\n', [hunk(null, '-a', '+A'), hunk(null, ' c', '-d', '+D')], 'f')).toBe(
      'A\nb\nc\nD\n',
    );
  });

  it('keeps CRLF line endings', () => {
    expect(applyHunks('a\r\nb\r\n', [hunk(null, '-b', '+B')], 'f')).toBe('a\r\nB\r\n');
  });

  it('keeps each line ending in a file that mixes CRLF and LF', () => {
    expect(applyHunks('a\r\nb\nc\n', [hunk(null, '-b', '+B')], 'f')).toBe('a\r\nB\nc\n');
    expect(applyHunks('a\r\nb\nc\r\n', [hunk(null, ' a', '+x', ' b', '+y', ' c')], 'f')).toBe('a\r\nx\r\nb\ny\nc\r\n');
    expect(applyHunks('a\nb\r\n', [hunk(null, ' b', '+c')], 'f')).toBe('a\nb\r\nc\r\n');
  });

  it('keeps a missing final newline when lines are added after the last line', () => {
    expect(applyHunks('a\r\nb', [hunk(null, ' b', '+c')], 'f')).toBe('a\r\nb\r\nc');
  });

  it('uses an anchor to choose between repeated blocks', () => {
    const content = 'fn a\nx\nfn b\nx\n';
    expect(applyHunks(content, [hunk('fn b', '-x', '+y')], 'f')).toBe('fn a\nx\nfn b\ny\n');
    expect(() => applyHunks(content, [hunk(null, '-x', '+y')], 'f')).toThrow('matches 2 places');
  });

  it('tolerates whitespace differences but not different text', () => {
    expect(applyHunks('  a  \nb\n', [hunk(null, '-a', '+z')], 'f')).toBe('z\nb\n');
    expect(() => applyHunks('a\n', [hunk(null, '-nope', '+z')], 'f')).toThrow('does not match');
  });

  it('appends an unanchored insertion after earlier hunks', () => {
    expect(applyHunks('a\nb\nc\n', [hunk(null, '-a', '+A'), hunk(null, '+last')], 'f')).toBe('A\nb\nc\nlast\n');
  });

  it('inserts at the end of the file', () => {
    expect(applyHunks('a\nb\n', [{ anchor: null, atEnd: true, lines: [{ prefix: '+', text: 'c' }] }], 'f')).toBe(
      'a\nb\nc\n',
    );
  });
});

describe('invalidWindowsName (#242)', () => {
  it.each([
    'newdir/what?.txt',
    'a<b.txt',
    'pipe|name',
    'dir/con',
    'NUL.txt',
    'lpt1.log',
    'trailing.',
    'space ',
    'x/y:z',
  ])('refuses %j', (rel) => {
    expect(invalidWindowsName(rel)).not.toBeNull();
  });

  it.each(['src/a.ts', 'console.log', 'nul-test.ts', '.env.example', 'dir.v2/file'])('accepts %j', (rel) => {
    expect(invalidWindowsName(rel)).toBeNull();
  });
});

describe('apply_patch tool', () => {
  // Both failed only while the patch was written, after src/a.ts had already changed (#242).
  it.skipIf(process.platform !== 'win32')(
    'refuses a new file Windows cannot create before changing anything',
    async () => {
      await expect(
        run(patch('*** Update File: src/a.ts', '@@', '-one', '+ONE', '*** Add File: newdir/what?.txt', '+x')),
      ).rejects.toThrow('does not allow');
      expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
      expect(existsSync(join(root, 'newdir'))).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'refuses the same new file named twice in different case before changing anything',
    async () => {
      await expect(
        run(
          patch(
            '*** Update File: src/a.ts',
            '@@',
            '-one',
            '+ONE',
            '*** Add File: b.txt',
            '+x',
            '*** Add File: B.txt',
            '+y',
          ),
        ),
      ).rejects.toThrow('appears twice');
      expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
      expect(existsSync(join(root, 'b.txt'))).toBe(false);
    },
  );

  it.each([false, true])('rejects non-UTF-8 updates (move=%s) before applying any file', async (move) => {
    const file = join(root, 'src', 'b.ts');
    const bytes = Buffer.from('caf\xe9\nalpha\n', 'latin1');
    writeFileSync(file, bytes);
    const text = patch(
      '*** Update File: src/a.ts',
      '@@',
      '-one',
      '+ONE',
      '*** Update File: src/b.ts',
      ...(move ? ['*** Move to: src/c.ts'] : []),
      '@@',
      '-alpha',
      '+ALPHA',
    );
    await expect(applyPatchTool.preview!({ patch: text }, context)).rejects.toThrow('src/b.ts is not UTF-8');
    await expect(run(text)).rejects.toThrow('editing it would rewrite other bytes');
    expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
    expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(join(root, 'src', 'c.ts'))).toBe(false);
  });

  it('preserves valid UTF-8 outside an updated hunk', async () => {
    const before = '\uFEFFcafé 日本語 😀 \uFFFD\nalpha\n';
    writeFileSync(join(root, 'src', 'b.ts'), before);
    await run(patch('*** Update File: src/b.ts', '@@', '-alpha', '+ALPHA'));
    expect(readFileSync(join(root, 'src', 'b.ts'))).toEqual(Buffer.from(before.replace('alpha', 'ALPHA')));
  });

  it('changes several files at once', async () => {
    const result = await run(
      patch(
        '*** Update File: src/a.ts',
        '@@',
        ' one',
        '-two',
        '+TWO',
        '*** Add File: src/new.ts',
        '+export {};',
        '*** Update File: src/b.ts',
        '*** Move to: src/c.ts',
        '@@',
        '-alpha',
        '+ALPHA',
      ),
    );
    expect(read('src/a.ts')).toBe('one\nTWO\nthree\nfour\n');
    expect(read('src/new.ts')).toBe('export {};\n');
    expect(read('src/c.ts')).toBe('ALPHA\nbeta\n');
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false);
    expect(result.content).toContain('Moved src/b.ts to src/c.ts');
    expect(result.summary).toBe('Patched 3 files');
  });

  describe('Undo (#197)', () => {
    const chatId = '11111111-1111-1111-1111-111111111111';
    const multiFile = () =>
      patch(
        '*** Update File: src/a.ts',
        '@@',
        ' one',
        '-two',
        '+TWO',
        '*** Add File: src/new.ts',
        '+export {};',
        '*** Update File: src/b.ts',
        '*** Move to: src/c.ts',
        '@@',
        '-alpha',
        '+ALPHA',
      );
    const record = async (text: string) => {
      const backups = new EditBackups(join(root, '.backups'));
      const result = await run(text);
      expect(result.undo).toBeDefined();
      backups.record(chatId, 'p1', result.undo!);
      return backups;
    };

    it('puts every file of a patch back, including added and moved files', async () => {
      const backups = await record(multiFile());
      const result = await backups.undo(chatId, 'p1', context.workspace);

      expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
      expect(read('src/b.ts')).toBe('alpha\nbeta\n');
      expect(existsSync(join(root, 'src', 'new.ts'))).toBe(false);
      expect(existsSync(join(root, 'src', 'c.ts'))).toBe(false);
      expect(result).toMatchObject({ path: 'src/a.ts', action: 'restored' });
      expect(result.others).toEqual([
        { path: 'src/new.ts', action: 'deleted' },
        { path: 'src/c.ts', action: 'deleted' },
        { path: 'src/b.ts', action: 'restored' },
      ]);
      expect(result.absolutes).toHaveLength(4);
    });

    it('restores a deleted file', async () => {
      const backups = await record(
        patch('*** Delete File: src/b.ts', '*** Update File: src/a.ts', '@@', '-one', '+ONE'),
      );
      await backups.undo(chatId, 'p1', context.workspace);
      expect(read('src/b.ts')).toBe('alpha\nbeta\n');
      expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
    });

    it('changes nothing when any file of the patch was changed since', async () => {
      const backups = await record(multiFile());
      writeFileSync(join(root, 'src', 'c.ts'), 'edited by the user\n');

      await expect(backups.undo(chatId, 'p1', context.workspace)).rejects.toThrow(/src\/c\.ts was changed/);
      expect(read('src/a.ts')).toBe('one\nTWO\nthree\nfour\n');
      expect(read('src/new.ts')).toBe('export {};\n');
      expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false);
    });

    it('refuses when a file the patch deleted was created again', async () => {
      const backups = await record(
        patch('*** Delete File: src/b.ts', '*** Update File: src/a.ts', '@@', '-one', '+ONE'),
      );
      writeFileSync(join(root, 'src', 'b.ts'), 'new content\n');

      await expect(backups.undo(chatId, 'p1', context.workspace)).rejects.toThrow(/src\/b\.ts was created again/);
      expect(read('src/b.ts')).toBe('new content\n');
      expect(read('src/a.ts')).toBe('ONE\ntwo\nthree\nfour\n');
    });

    it('undoes a patch that only deletes a file', async () => {
      const backups = await record(patch('*** Delete File: src/b.ts'));
      await expect(backups.undo(chatId, 'p1', context.workspace)).resolves.toMatchObject({
        path: 'src/b.ts',
        action: 'restored',
      });
      expect(read('src/b.ts')).toBe('alpha\nbeta\n');
    });
  });

  it.each(['src/a.ts', './src/a.ts', 'src/../src/a.ts'])(
    'treats a move to the same resolved path as an update: %s',
    async (target) => {
      const text = patch('*** Update File: src/a.ts', `*** Move to: ${target}`, '@@', '-one', '+ONE');
      const preview = await applyPatchTool.preview!({ patch: text }, context);
      expect(preview.title).toBe('Updated src/a.ts');
      expect(preview.diff).toContain('+ONE');
      const result = await run(text);
      expect(read('src/a.ts')).toBe('ONE\ntwo\nthree\nfour\n');
      expect(result.content).toContain('Updated src/a.ts');
      expect(context.readFiles.has(join(context.workspace.root, 'src', 'a.ts'))).toBe(true);
    },
  );

  it('still rejects a second update after a same-path move without writing either', async () => {
    await expect(
      run(
        patch(
          '*** Update File: src/a.ts',
          '*** Move to: ./src/a.ts',
          '@@',
          '-one',
          '+ONE',
          '*** Update File: src/a.ts',
          '@@',
          '-two',
          '+TWO',
        ),
      ),
    ).rejects.toThrow('appears twice');
    expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
  });

  it('records what it wrote, so write_file can replace patched, added and moved files without a new read', async () => {
    // a.ts and b.ts start with an unknown hash (a chat saved by an older version): patching still works.
    await run(
      patch(
        '*** Update File: src/a.ts',
        '@@',
        '-one',
        '+ONE',
        '*** Add File: src/new.ts',
        '+export {};',
        '*** Update File: src/b.ts',
        '*** Move to: src/c.ts',
        '@@',
        '-alpha',
        '+ALPHA',
      ),
    );
    for (const path of ['src/a.ts', 'src/new.ts', 'src/c.ts']) {
      const input = writeFileTool.schema!.parse({ path, content: 'replaced\n' });
      await writeFileTool.preview!(input, context);
      await writeFileTool.run(input, context);
      expect(read(path)).toBe('replaced\n');
    }
  });

  it('deletes a file that was read', async () => {
    await run(patch('*** Delete File: src/b.ts'));
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false);
  });

  it('changes nothing when one file fails', async () => {
    await expect(
      run(patch('*** Update File: src/a.ts', '@@', '-one', '+1', '*** Update File: src/b.ts', '@@', '-missing', '+x')),
    ).rejects.toThrow('does not match');
    expect(read('src/a.ts')).toBe('one\ntwo\nthree\nfour\n');
  });

  it('requires files to be read and refuses to overwrite or escape the project', async () => {
    await expect(run(patch('*** Add File: src/a.ts', '+x'))).rejects.toThrow('already exists');
    await expect(run(patch('*** Add File: ../outside.txt', '+x'))).rejects.toThrow('outside the project');
    await expect(run(patch('*** Add File: x.txt', '+a', '*** Add File: x.txt', '+b'))).rejects.toThrow('twice');
    context.readFiles.clear();
    await expect(run(patch('*** Update File: src/a.ts', '@@', '-one', '+1'))).rejects.toThrow('has not been read');
  });

  it('refuses redacted placeholders', async () => {
    await expect(run(patch('*** Add File: k.txt', '+key=[REDACTED:_____]'))).rejects.toThrow('placeholder');
  });

  it('asks in Auto mode when it touches a protected file', () => {
    const ask = (text: string) => applyPatchTool.mustAsk!({ patch: text } as never, context);
    expect(ask(patch('*** Add File: .env', '+A=1'))).toBe(true);
    expect(ask(patch('*** Update File: src/a.ts', '*** Move to: .git/x', '@@', '-one', '+1'))).toBe(true);
    expect(ask(patch('*** Add File: src/x.ts', '+1'))).toBe(false);
  });

  it('previews one combined diff', async () => {
    const preview = await applyPatchTool.preview!(
      { patch: patch('*** Update File: src/a.ts', '@@', '-one', '+1') },
      context,
    );
    expect(preview.title).toBe('Updated src/a.ts');
    expect(preview.diff).toContain('+1');
  });
});
