import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globTool } from './glob';
import { applyEdit, editFileTool, grepTool, listDirectoryTool, readFileTool, writeFileTool } from './files';
import { browserTool } from './browser';
import { availableTools } from './registry';
import { backgroundStartup, commandOutputTool, commandStopsSettled, runCommandTool, ShellRunner } from './shell';
import { ToolError, truncateOutput, type AgentTool, type ToolContext } from './types';
import {
  clearFetchCache,
  extractArticle,
  fetchUrlTool,
  fetchWithoutCrossOriginRedirect,
  readBodyCapped,
  relevantLines,
  webTransport,
} from './web';
import { resolver } from './net_address';
import { Workspace } from './workspace';

// Long enough for a Node script to start and print on a busy machine; the real wait is three seconds.
backgroundStartup.waitMs = 1000;

let root: string;
let context: ToolContext;

function makeContext(): ToolContext {
  const workspace = new Workspace(root);
  return {
    workspace,
    signal: new AbortController().signal,
    readFiles: new Map(),
    shell: new ShellRunner(() => workspace.root),
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
}

// Runs a tool the way the agent does: validate the input first.
async function call(tool: AgentTool, input: unknown, ctx = context) {
  return tool.run(tool.schema!.parse(input), ctx);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-tools-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  writeFileSync(join(root, 'src', 'dist.log'), 'ignored');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'const a = 1;');
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  context = makeContext();
});

afterEach(async () => {
  context.shell.stopAll();
  // Stops run in the background (#112); on Windows the folder stays busy until they finish.
  await commandStopsSettled();
  rmSync(root, { recursive: true, force: true });
});

describe('Workspace', () => {
  it('rejects paths outside the project', () => {
    expect(() => context.workspace.resolve('../outside.txt')).toThrow(ToolError);
    expect(() => context.workspace.resolve(join(tmpdir(), 'x.txt'))).toThrow(/outside the project/);
    expect(context.workspace.resolve('src/app.ts')).toBe(join(context.workspace.root, 'src', 'app.ts'));
  });

  it("rejects the project's parent folder itself", () => {
    expect(() => context.workspace.resolve('..')).toThrow(/outside the project/);
    expect(() => context.workspace.resolve('src/../..')).toThrow(/outside the project/);
  });

  // On Windows, path.relative between two drives is an absolute path, not one starting with "..".
  it.runIf(process.platform === 'win32')('rejects a path on another drive', () => {
    const drive = context.workspace.root[0]!.toUpperCase();
    const other = drive === 'Q' ? 'R' : 'Q';
    expect(() => context.workspace.resolve(`${other}:\\outside.txt`)).toThrow(/outside the project/);
  });

  it('follows a folder link for a file that does not exist yet, so nothing is written outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-outside-'));
    try {
      // A junction needs no special rights on Windows; elsewhere it is a plain directory symlink.
      symlinkSync(outside, join(root, 'link'), 'junction');
      expect(() => context.workspace.resolve('link/new.txt')).toThrow(/outside the project/);
      expect(() => context.workspace.resolve('link/deeper/new.txt')).toThrow(/outside the project/);
      await expect(call(writeFileTool, { path: 'link/new.txt', content: 'escaped' })).rejects.toThrow(
        /outside the project/,
      );
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);

      // A link that stays inside the project is fine, and so are new files in new folders.
      symlinkSync(join(root, 'src'), join(root, 'inner'), 'junction');
      expect(context.workspace.resolve('inner/new.ts')).toBe(join(context.workspace.root, 'src', 'new.ts'));
      expect(context.workspace.resolve('brand/new/dir/file.ts')).toBe(
        join(context.workspace.root, 'brand', 'new', 'dir', 'file.ts'),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips .gitignore matches and node_modules when listing', async () => {
    const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
    expect(files).toEqual(['.gitignore', 'src/app.ts']);
  });

  it('applies .patchignore and the older .ccignore, .patchignore last', async () => {
    writeFileSync(join(root, 'src', 'old.ts'), 'const a = 1;');
    writeFileSync(join(root, 'src', 'new.ts'), 'const a = 1;');
    writeFileSync(join(root, '.ccignore'), 'src/old.ts\nsrc/app.ts\n');
    writeFileSync(join(root, '.patchignore'), 'src/new.ts\n!src/app.ts\n');
    const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
    expect(files).toEqual(['.ccignore', '.gitignore', '.patchignore', 'src/app.ts']);
  });

  it.for(['.gitignore', '.ccignore', '.patchignore'])(
    'ignores external %s links without applying their rules',
    async (name, test) => {
      const outside = mkdtempSync(join(tmpdir(), 'cc-ignore-outside-'));
      try {
        const target = join(outside, 'rules');
        writeFileSync(target, 'src/app.ts\n');
        rmSync(join(root, name), { force: true });
        try {
          symlinkSync(target, join(root, name), 'file');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') return test.skip();
          throw error;
        }
        const ordinary = name === '.gitignore' ? '.ccignore' : '.gitignore';
        writeFileSync(join(root, ordinary), '*.log\n');
        const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
        expect(files).toContain('src/app.ts');
        expect(files).not.toContain('src/dist.log');
        expect(files).not.toContain(name);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.each(['.gitignore', '.ccignore', '.patchignore'])(
    'ignores external %s junctions without trying to read them',
    async (name) => {
      const outside = mkdtempSync(join(tmpdir(), 'cc-ignore-junction-'));
      try {
        rmSync(join(root, name), { force: true });
        symlinkSync(outside, join(root, name), 'junction');
        const files = (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));
        expect(files).toContain('src/app.ts');
        expect(files).not.toContain(name);
      } finally {
        rmSync(join(root, name), { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  describe('nested and changing ignore rules', () => {
    const listed = async () => (await context.workspace.listFiles()).map((file) => context.workspace.relative(file));

    beforeEach(() => {
      mkdirSync(join(root, 'pkg', 'dist'), { recursive: true });
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'pkg', 'dist', 'bundle.js'), 'const a = 1;');
      writeFileSync(join(root, 'pkg', 'index.ts'), 'const a = 1;');
      writeFileSync(join(root, 'dist', 'root.js'), 'const a = 1;');
      writeFileSync(join(root, 'pkg', '.gitignore'), 'dist/\n');
    });

    it('scopes a nested .gitignore to its own folder in listFiles, grep, glob and list_directory', async () => {
      const files = await listed();
      expect(files).toContain('pkg/index.ts');
      expect(files).toContain('dist/root.js');
      expect(files).not.toContain('pkg/dist/bundle.js');
      expect(context.workspace.isIgnored(join(context.workspace.root, 'pkg', 'dist', 'bundle.js'), false)).toBe(true);

      const grep = (await call(grepTool, { pattern: 'const a' })).content as string;
      expect(grep).toContain('dist/root.js');
      expect(grep).not.toContain('pkg/dist');
      const glob = (await call(globTool, { pattern: '*.js' })).content as string;
      expect(glob.split('\n')).toEqual(['dist/root.js']);
      const dir = (await call(listDirectoryTool, { path: 'pkg' })).content as string;
      expect(dir.split('\n')).toEqual(['.gitignore', 'index.ts']);
      const recursive = (await call(listDirectoryTool, { path: 'pkg/dist', recursive: true })).content as string;
      expect(recursive).toBe('(empty)');
    });

    it('honors .git/info/exclude when .git is a folder', async () => {
      mkdirSync(join(root, '.git', 'info'), { recursive: true });
      writeFileSync(join(root, '.git', 'info', 'exclude'), 'pkg/index.ts\n');
      expect(await listed()).not.toContain('pkg/index.ts');
    });

    it('picks up a root .gitignore changed on disk without being told', async () => {
      expect(await listed()).toContain('dist/root.js');
      writeFileSync(join(root, '.gitignore'), '*.log\n/dist/\n');
      expect(await listed()).not.toContain('dist/root.js');
      expect(context.workspace.isIgnored(join(context.workspace.root, 'dist', 'root.js'), false)).toBe(true);
    });

    it('shows files again when a nested .gitignore is deleted', async () => {
      expect(await listed()).not.toContain('pkg/dist/bundle.js');
      rmSync(join(root, 'pkg', '.gitignore'));
      expect(await listed()).toContain('pkg/dist/bundle.js');
    });

    it('picks up a pattern that edit_file adds to .gitignore', async () => {
      expect(await listed()).toContain('pkg/index.ts');
      await call(readFileTool, { path: '.gitignore' });
      await call(editFileTool, { path: '.gitignore', old_string: '*.log', new_string: '*.log\npkg/index.ts' });
      expect(await listed()).not.toContain('pkg/index.ts');
    });

    it('lets a nested file re-include a file but not the contents of an excluded folder, like git', async () => {
      writeFileSync(join(root, 'pkg', 'keep.log'), '');
      writeFileSync(join(root, 'pkg', 'other.log'), '');
      writeFileSync(join(root, 'pkg', '.gitignore'), 'dist/\n!keep.log\n!dist/bundle.js\n');
      const files = await listed();
      expect(files).toContain('pkg/keep.log');
      expect(files).not.toContain('pkg/other.log');
      expect(files).not.toContain('pkg/dist/bundle.js');
      expect(context.workspace.isIgnored(join(context.workspace.root, 'pkg', 'keep.log'), false)).toBe(false);
      expect(context.workspace.isIgnored(join(context.workspace.root, 'pkg', 'dist', 'bundle.js'), false)).toBe(true);
    });
  });
});

describe('file tools', () => {
  it.each([editFileTool, writeFileTool])(
    '$name refuses non-UTF-8 previews and writes without changing bytes',
    async (tool) => {
      const bytes = Buffer.from('name=caf\xe9\nvalue=old\n', 'latin1');
      const file = join(root, 'legacy.properties');
      writeFileSync(file, bytes);
      await call(readFileTool, { path: 'legacy.properties' });
      const input =
        tool === editFileTool
          ? { path: 'legacy.properties', old_string: 'value=old', new_string: 'value=new' }
          : { path: 'legacy.properties', content: 'value=new\n' };
      await expect(tool.preview!(input as never, context)).rejects.toThrow('legacy.properties is not UTF-8');
      await expect(call(tool, input)).rejects.toThrow('editing it would rewrite other bytes');
      expect(readFileSync(file)).toEqual(bytes);
    },
  );

  it.each([editFileTool, writeFileTool])(
    '$name preserves valid UTF-8 including BOM and replacement characters',
    async (tool) => {
      const file = join(root, 'unicode.txt');
      const before = '\uFEFFcafé 日本語 😀 \uFFFD\nvalue=old\n';
      writeFileSync(file, before);
      await call(readFileTool, { path: 'unicode.txt' });
      const after = before.replace('value=old', 'value=new');
      const input =
        tool === editFileTool
          ? { path: 'unicode.txt', old_string: 'value=old', new_string: 'value=new' }
          : { path: 'unicode.txt', content: after };
      await tool.preview!(input as never, context);
      const result = await call(tool, input);
      expect(readFileSync(file)).toEqual(Buffer.from(after));
      expect(result.undo?.before).toEqual(Buffer.from(before));
    },
  );

  it('reads with line numbers and ranges', async () => {
    const full = await call(readFileTool, { path: 'src/app.ts' });
    expect(full.content).toContain('1\tconst a = 1;');
    const range = await call(readFileTool, { path: 'src/app.ts', offset: 2, limit: 1 });
    expect(range.content.split('\n')[0]).toBe('2\tconst b = 2;');
    expect(range.content).toContain('Showing lines 2-2 of 3');
  });

  it.each(['one\ntwo\n', 'one\r\ntwo\r\n', 'one\ntwo'])(
    'does not count a line terminator as another line',
    async (text) => {
      writeFileSync(join(root, 'lines.txt'), text);
      const result = await call(readFileTool, { path: 'lines.txt' });
      expect(result.content).toBe('1\tone\n2\ttwo');
      expect(result.summary).toBe('Read lines.txt (2 lines)');
      await expect(call(readFileTool, { path: 'lines.txt', offset: 3 })).rejects.toThrow(
        'offset 3 is past the end (2 lines)',
      );
    },
  );

  it('preserves a real final blank line', async () => {
    writeFileSync(join(root, 'blank.txt'), 'one\n\n');
    const result = await call(readFileTool, { path: 'blank.txt' });
    expect(result.content).toBe('1\tone\n2\t');
    expect(result.summary).toBe('Read blank.txt (2 lines)');
  });

  it('counts a single line in the singular', async () => {
    writeFileSync(join(root, 'one.txt'), 'only\n');
    const result = await call(readFileTool, { path: 'one.txt' });
    expect(result.summary).toBe('Read one.txt (1 line)');
    await expect(call(readFileTool, { path: 'one.txt', offset: 2 })).rejects.toThrow(
      'offset 2 is past the end (1 line)',
    );
  });

  it('does not offer a phantom page after exactly 2,000 terminated lines', async () => {
    writeFileSync(join(root, 'page.txt'), 'a\n'.repeat(2000));
    const result = await call(readFileTool, { path: 'page.txt' });
    expect(result.summary).toBe('Read page.txt (2000 lines)');
    expect(result.content).not.toContain('Use offset=2001');
    expect(result.content.split('\n')).toHaveLength(2000);
  });

  it('reads an empty file and rejects offsets beyond it', async () => {
    writeFileSync(join(root, 'empty.txt'), '');
    const result = await call(readFileTool, { path: 'empty.txt' });
    expect(result.content).toBe('');
    expect(result.summary).toBe('Read empty.txt (0 lines)');
    expect(context.readFiles.has(join(context.workspace.root, 'empty.txt'))).toBe(true);
    await expect(call(readFileTool, { path: 'empty.txt', offset: 2 })).rejects.toThrow(
      'offset 2 is past the end (0 lines)',
    );
  });

  it('reads a large file page by page, in whole lines, with nothing missing in between', async () => {
    // 1,500 lines of about 50 characters: too much for one read, well under the 2,000-line default.
    const lines = Array.from({ length: 1500 }, (_, index) => `line ${index + 1}: the quick brown fox jumps over`);
    writeFileSync(join(root, 'big.txt'), lines.join('\n'));

    const seen: string[] = [];
    let offset = 1;
    for (let page = 0; page < 10; page++) {
      const result = await call(readFileTool, { path: 'big.txt', offset });
      const [text, note] = result.content.split('\n\n(');
      expect(text!.length).toBeLessThanOrEqual(30_000);
      seen.push(...text!.split('\n').map((line) => line.split('\t')[1]!));
      if (!note) break;
      const next = Number(/Use offset=(\d+)/.exec(note)![1]);
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }

    // Every line exactly once, in order: no hole in the middle.
    expect(seen).toEqual(lines);
    expect(offset).toBeGreaterThan(1);
  });

  it('honors the requested whole-line limit', async () => {
    writeFileSync(join(root, 'short-lines.txt'), Array.from({ length: 50 }, (_, index) => `${index}`).join('\n'));
    const result = await call(readFileTool, { path: 'short-lines.txt', limit: 10 });
    const [text, note] = result.content.split('\n\n(');
    expect(text!.split('\n').map((line) => line.split('\t')[1])).toEqual(
      Array.from({ length: 10 }, (_, index) => `${index}`),
    );
    expect(Number(/Use offset=(\d+)/.exec(note!)![1])).toBe(11);
  });

  it.each(['x'.repeat(29_998), 'x'.repeat(29_999), `${'x'.repeat(29_997)}😀${'é漢😀'.repeat(20_000)}`])(
    'reconstructs long lines through the returned continuation without losing Unicode',
    async (line) => {
      const original = [line, '', 'last 😀 line'];
      writeFileSync(join(root, 'min.js'), original.join('\n'));
      const reconstructed = ['', '', ''];
      let offset = 1;
      let char_offset = 0;
      for (let page = 0; page < 20; page++) {
        const result = await call(readFileTool, { path: 'min.js', offset, char_offset, limit: 1 });
        const [text, note] = result.content.split('\n\n(');
        expect(text!.length).toBeLessThanOrEqual(30_000);
        for (const numbered of text!.split('\n')) {
          const tab = numbered.indexOf('\t');
          const fragment = numbered.slice(tab + 1);
          expect(fragment).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
          reconstructed[Number(numbered.slice(0, tab)) - 1] += fragment;
        }
        if (!note) break;
        const next = /Use offset=(\d+)(?: and char_offset=(\d+))?/.exec(note)!;
        const nextLine = Number(next[1]);
        const nextChar = Number(next[2] ?? 0);
        expect(nextLine > offset || (nextLine === offset && nextChar > char_offset)).toBe(true);
        offset = nextLine;
        char_offset = nextChar;
      }
      expect(reconstructed).toEqual(original);
    },
  );

  it('validates character offsets and applies them only to the first line', async () => {
    writeFileSync(join(root, 'unicode.txt'), 'a😀b\nnext');
    await expect(call(readFileTool, { path: 'unicode.txt', char_offset: 2 })).rejects.toThrow(/surrogate pair/);
    await expect(call(readFileTool, { path: 'unicode.txt', char_offset: 5 })).rejects.toThrow(/within/);
    const result = await call(readFileTool, { path: 'unicode.txt', char_offset: 3 });
    expect(result.content).toBe('1\tb\n2\tnext');
    const end = await call(readFileTool, { path: 'unicode.txt', char_offset: 4 });
    expect(end.content).toBe('1\t\n2\tnext');
  });

  it('reads a small file whole, with no note', async () => {
    const result = await call(readFileTool, { path: 'src/app.ts' });
    expect(result.content).not.toContain('(Showing');
    expect(result.summary).toBe('Read src/app.ts (3 lines)');
  });

  it('refuses to edit or overwrite a file that was not read', async () => {
    await expect(call(editFileTool, { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' })).rejects.toThrow(
      /src\/app.ts has not been read/,
    );
    await expect(call(writeFileTool, { path: 'src/app.ts', content: 'x' })).rejects.toThrow(/has not been read/);
    // Also rejected while building the approval preview, so the user is never asked to approve it.
    await expect(
      editFileTool.preview?.({ path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' }, context),
    ).rejects.toThrow(/has not been read/);
  });

  it('edits after reading and reports a diff', async () => {
    await call(readFileTool, { path: 'src/app.ts' });
    const result = await call(editFileTool, {
      path: 'src/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 10;',
    });
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toContain('const a = 10;');
    expect(result.content).toContain('+const a = 10;');
  });

  it('creates new files and folders without a prior read', async () => {
    await call(writeFileTool, { path: 'lib/new/util.ts', content: 'export {};\n' });
    expect(readFileSync(join(root, 'lib', 'new', 'util.ts'), 'utf8')).toBe('export {};\n');
  });

  it('keeps what is needed to undo an edit: the exact previous bytes and a fingerprint of the result', async () => {
    const original = readFileSync(join(root, 'src', 'app.ts'));
    await call(readFileTool, { path: 'src/app.ts' });
    const result = await call(editFileTool, {
      path: 'src/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 10;',
    });

    expect(result.undo).toEqual({
      path: 'src/app.ts',
      before: original,
      afterHash: createHash('sha256')
        .update(readFileSync(join(root, 'src', 'app.ts')))
        .digest('hex'),
    });
  });

  it('marks a created file as one that did not exist, and keeps the previous content of an overwritten one', async () => {
    const created = await call(writeFileTool, { path: 'lib/new.ts', content: 'export {};\n' });
    expect(created.undo).toEqual({
      path: 'lib/new.ts',
      before: null,
      afterHash: createHash('sha256').update('export {};\n').digest('hex'),
    });

    const original = readFileSync(join(root, 'src', 'app.ts'));
    await call(readFileTool, { path: 'src/app.ts' });
    const replaced = await call(writeFileTool, { path: 'src/app.ts', content: 'replaced\n' });
    expect(replaced.undo?.before).toEqual(original);
  });

  it('previews writes as a diff', async () => {
    const preview = await writeFileTool.preview!(
      writeFileTool.schema!.parse({ path: 'new.txt', content: 'hello\n' }),
      context,
    );
    expect(preview.title).toBe('Create new.txt');
    expect(preview.diff).toContain('+hello');
  });

  describe('write_file after the file changed', () => {
    // The tools key readFiles by the real path; on macOS the temp folder is behind a link (/var -> /private/var).
    const app = () => join(context.workspace.root, 'src', 'app.ts');

    it('refuses when the user changed the file after it was read, and keeps their edit', async () => {
      await call(readFileTool, { path: 'src/app.ts', offset: 2, limit: 1 });
      writeFileSync(app(), 'user edit\n');
      const input = { path: 'src/app.ts', content: 'agent\n' };
      await expect(writeFileTool.preview!(input, context)).rejects.toThrow(
        'src/app.ts changed since you read it. Read it again first.',
      );
      await expect(call(writeFileTool, input)).rejects.toThrow('changed since you read it');
      expect(readFileSync(app(), 'utf8')).toBe('user edit\n');
    });

    it('refuses when the file changes between the preview and the run', async () => {
      await call(readFileTool, { path: 'src/app.ts' });
      const input = { path: 'src/app.ts', content: 'agent\n' };
      await writeFileTool.preview!(input, context);
      writeFileSync(app(), 'edited while the card was open\n');
      await expect(call(writeFileTool, input)).rejects.toThrow('changed since you read it');
      expect(readFileSync(app(), 'utf8')).toBe('edited while the card was open\n');
    });

    it('writes after the file is read again', async () => {
      await call(readFileTool, { path: 'src/app.ts' });
      writeFileSync(app(), 'user edit\n');
      await call(readFileTool, { path: 'src/app.ts' });
      await call(writeFileTool, { path: 'src/app.ts', content: 'agent\n' });
      expect(readFileSync(app(), 'utf8')).toBe('agent\n');
    });

    it('lets the agent write again what it just wrote or edited without a new read', async () => {
      await call(readFileTool, { path: 'src/app.ts' });
      await call(writeFileTool, { path: 'src/app.ts', content: 'first\n' });
      await call(writeFileTool, { path: 'src/app.ts', content: 'second\n' });
      await call(editFileTool, { path: 'src/app.ts', old_string: 'second', new_string: 'third' });
      await writeFileTool.preview!({ path: 'src/app.ts', content: 'fourth\n' }, context);
      await call(writeFileTool, { path: 'src/app.ts', content: 'fourth\n' });
      expect(readFileSync(app(), 'utf8')).toBe('fourth\n');

      await call(writeFileTool, { path: 'lib/new.ts', content: 'a\n' });
      await call(writeFileTool, { path: 'lib/new.ts', content: 'b\n' });
      expect(readFileSync(join(root, 'lib', 'new.ts'), 'utf8')).toBe('b\n');
    });

    it('asks for a new read of a file read in a chat saved by an older version (unknown hash)', async () => {
      context.readFiles.set(app(), null);
      await expect(call(writeFileTool, { path: 'src/app.ts', content: 'agent\n' })).rejects.toThrow(
        'changed since you read it',
      );
      await call(editFileTool, { path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 10;' });
      expect(readFileSync(app(), 'utf8')).toContain('const a = 10;');
    });
  });

  it('lists a directory without ignored entries', async () => {
    const result = await call(listDirectoryTool, {});
    expect(result.content.split('\n')).toEqual(['src/', '.gitignore']);
  });

  it('greps across non-ignored files', async () => {
    const result = await call(grepTool, { pattern: 'const a' });
    expect(result.content).toBe('src/app.ts:1: const a = 1;');
  });

  it('treats a leading (?i) as ignore_case and explains other invalid patterns', async () => {
    const result = await call(grepTool, { pattern: '(?i)CONST A' });
    expect(result.content).toBe('src/app.ts:1: const a = 1;');
    await expect(call(grepTool, { pattern: 'a(?i)b' })).rejects.toThrow(/set ignore_case instead of an inline flag/);
  });
});

describe('applyEdit', () => {
  it('requires a unique match unless replace_all is set', () => {
    expect(() => applyEdit('x x', { old_string: 'x', new_string: 'y' })).toThrow(/appears 2 times/);
    expect(applyEdit('x x', { old_string: 'x', new_string: 'y', replace_all: true })).toBe('y y');
  });

  it('reports a missing match', () => {
    expect(() => applyEdit('abc', { old_string: 'zzz', new_string: 'y' })).toThrow(/not found/);
  });

  it('matches LF input against CRLF files and keeps CRLF', () => {
    expect(applyEdit('a\r\nb\r\n', { old_string: 'a\nb', new_string: 'c\nd' })).toBe('c\r\nd\r\n');
  });

  it('edits the LF part of a file with mixed line endings and keeps each ending', () => {
    const mixed = 'a\r\nb\r\nc\nd\ne\n';
    expect(applyEdit(mixed, { old_string: 'c\nd', new_string: 'C\nx\nD' })).toBe('a\r\nb\r\nC\nx\nD\ne\n');
    expect(applyEdit(mixed, { old_string: 'a\nb', new_string: 'A\nB' })).toBe('A\r\nB\r\nc\nd\ne\n');
  });

  it('keeps CRLF when a single-line match in a CRLF file gains lines', () => {
    expect(applyEdit('a\r\nb\r\n', { old_string: 'b', new_string: 'b\nc' })).toBe('a\r\nb\r\nc\r\n');
  });

  it('does not interpret $ patterns in the replacement', () => {
    expect(applyEdit('price', { old_string: 'price', new_string: '$&$1' })).toBe('$&$1');
  });
});

describe('browser tool', () => {
  const opened: string[] = [];
  let navigationPolicy: ((url: string) => boolean) | undefined;
  const browser = {
    open: async (url: string, _signal: AbortSignal, policy?: (url: string) => boolean) => {
      opened.push(url);
      navigationPolicy = policy;
      return { url, title: 'T', status: 200, console: [] };
    },
    screenshot: async () => '',
  };

  it('opens http pages and files inside the project', async () => {
    opened.length = 0;
    writeFileSync(join(root, 'index.html'), '<p>hi</p>');
    const ctx = { ...context, browser };
    await call(browserTool, { url: 'http://localhost:3000' }, ctx);
    await call(browserTool, { url: pathToFileURL(join(root, 'index.html')).href }, ctx);
    expect(opened[0]).toBe('http://localhost:3000');
    expect(opened[1]!.toLowerCase()).toContain('index.html');
  });

  it('confines later browser navigation to the approved exact hostname', async () => {
    await call(browserTool, { url: 'https://EXAMPLE.test/start' }, { ...context, browser });
    expect(navigationPolicy?.('https://example.test/next')).toBe(true);
    expect(navigationPolicy?.('https://sub.example.test/')).toBe(false);
    expect(navigationPolicy?.('https://example.test.evil/')).toBe(false);
    expect(navigationPolicy?.('https://example.test@evil.test/')).toBe(false);
  });

  it('confines later browser navigation to the approved scheme and port as well', async () => {
    await call(browserTool, { url: 'https://example.test/start' }, { ...context, browser });
    expect(navigationPolicy?.('https://example.test:443/next')).toBe(true);
    expect(navigationPolicy?.('https://example.test:8443/next')).toBe(false);
    expect(navigationPolicy?.('http://example.test/next')).toBe(false);
    await call(browserTool, { url: 'http://localhost:3000/' }, { ...context, browser });
    expect(navigationPolicy?.('http://localhost:3000/login')).toBe(true);
    expect(navigationPolicy?.('http://localhost:5432/')).toBe(false);
  });

  it('asks before opening a local or private address, even in Auto mode', async () => {
    const check = async (url: string, ctx = context) => {
      const input = browserTool.schema!.parse({ url });
      return { mustAsk: await browserTool.mustAsk!(input, ctx), note: (await browserTool.preview!(input, ctx)).note };
    };
    expect(await check('http://localhost:3000')).toEqual({
      mustAsk: true,
      note: 'browser to a local or private address (localhost); asks even in Auto mode.',
    });
    expect((await check('http://169.254.169.254/')).mustAsk).toBe(true);
    expect((await check('http://[::1]:8080/')).mustAsk).toBe(true);
    expect((await check(pathToFileURL(join(root, 'index.html')).href)).mustAsk).toBe(false);
    const listed = { ...context, allowsNetworkUrl: (url: string) => new URL(url).hostname === 'localhost' };
    expect((await check('http://localhost:3000', listed)).mustAsk).toBe(false);
    vi.spyOn(resolver, 'lookup').mockResolvedValueOnce([{ address: '192.168.1.20', family: 4 }]);
    expect((await check('https://router.example/')).mustAsk).toBe(true);
    vi.spyOn(resolver, 'lookup').mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    expect(await check('https://example.com/')).toEqual({ mustAsk: false, note: undefined });
    vi.restoreAllMocks();
  });

  it('is approval gated and previews the complete URL', async () => {
    const url = 'https://example.test/private?token=value';
    expect(browserTool.requiresApproval).toBe(true);
    expect((await browserTool.preview!({ url }, context)).title).toContain(url);
    expect(fetchUrlTool.requiresApproval).toBe(true);
    expect((await fetchUrlTool.preview!({ url }, context)).title).toContain(url);
  });

  it('refuses file URLs outside the project', async () => {
    opened.length = 0;
    const outside = pathToFileURL(join(root, '..', 'secret.txt')).href;
    await expect(call(browserTool, { url: outside }, { ...context, browser })).rejects.toThrow('outside the project');
    expect(opened).toEqual([]);
  });
});

describe('fetch redirects', () => {
  // Every test host resolves to a public address; the transport records the requests instead of sending them.
  let contacted: string[];
  function serve(respond: (url: URL) => Response) {
    contacted = [];
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    vi.spyOn(webTransport, 'request').mockImplementation(async (url) => {
      contacted.push(url.href);
      return respond(url);
    });
  }
  afterEach(() => vi.restoreAllMocks());

  it('blocks a cross-host redirect before contacting its destination', async () => {
    serve(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/secret' } }));
    await expect(
      fetchWithoutCrossOriginRedirect(new URL('https://allowed.test/start'), new AbortController().signal),
    ).rejects.toThrow(/Blocked redirect.*request that URL separately/);
    expect(contacted).toEqual(['https://allowed.test/start']);
  });

  it.each([
    ['another port', 'https://allowed.test:8443/next'],
    ['plain http', 'http://allowed.test/next'],
  ])('blocks a same-host redirect to %s', async (_name, location) => {
    serve(() => new Response(null, { status: 302, headers: { location } }));
    await expect(
      fetchWithoutCrossOriginRedirect(new URL('https://allowed.test/start'), new AbortController().signal),
    ).rejects.toThrow(/Blocked redirect.*origin/);
    expect(contacted).toEqual(['https://allowed.test/start']);
  });

  it('follows same-host redirects', async () => {
    serve(() =>
      contacted.length === 1 ? new Response(null, { status: 302, headers: { location: '/next' } }) : new Response('ok'),
    );
    expect(
      await (
        await fetchWithoutCrossOriginRedirect(new URL('https://allowed.test/start'), new AbortController().signal)
      ).text(),
    ).toBe('ok');
    expect(contacted).toEqual(['https://allowed.test/start', 'https://allowed.test/next']);
    // Both hops connect to the address resolved once at the start.
    expect(resolver.lookup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webTransport.request).mock.calls.map((args) => args[1])).toEqual([
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '93.184.216.34', family: 4 }],
    ]);
  });
});

describe('shell tools', () => {
  it('returns output and exit code', async () => {
    const result = await call(runCommandTool, { command: 'echo hello-from-shell' });
    expect(result.content).toContain('Exit code: 0');
    expect(result.content).toContain('hello-from-shell');
    expect(result.isError).toBe(false);
  });

  it('flags non-zero exit codes', async () => {
    const result = await call(runCommandTool, { command: 'exit 3' });
    expect(result.content).toContain('Exit code: 3');
    expect(result.isError).toBe(true);
  });

  it('runs in the project root', async () => {
    const command = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
    const result = await call(runCommandTool, { command });
    // The shell may print the long form of a Windows 8.3 short path (RUNNER~1) or the real path of a symlink.
    const output = result.content.toLowerCase();
    const candidates = [context.workspace.root, realpathSync.native(context.workspace.root)];
    expect(candidates.some((path) => output.includes(path.toLowerCase()))).toBe(true);
  });

  it('stops commands that run past the timeout', async () => {
    const shell = new ShellRunner(() => root);
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const started = Date.now();
    const result = await shell.run(command, { timeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('returns when the command exits even if a leftover child keeps the output pipe open', async () => {
    const shell = new ShellRunner(() => tmpdir());
    const command =
      process.platform === 'win32'
        ? `Start-Process node -ArgumentList '-e','setTimeout(()=>{},20000)' -NoNewWindow; Write-Output finished`
        : 'sleep 20 & echo finished';
    const started = Date.now();
    const result = await shell.run(command, { timeoutSeconds: 60 });
    expect(result.output).toContain('finished');
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('stops commands when the chat is stopped', async () => {
    const controller = new AbortController();
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const pending = context.shell.run(command, { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    expect(result.aborted).toBe(true);
  }, 20_000);

  it('does not start a command when the chat was stopped before it could run', async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = join(root, 'should-not-exist.txt');
    const result = await context.shell.run(`node -e "require('fs').writeFileSync('should-not-exist.txt','x')"`, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(result.aborted).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it('starts background commands and reads their output', async () => {
    const command =
      process.platform === 'win32'
        ? 'Write-Output background-ready; Start-Sleep -Seconds 30'
        : 'echo background-ready; sleep 30';
    const started = await call(runCommandTool, { command, background: true });
    expect(started.content).toContain('still running');
    expect(started.content).toContain('background-ready');

    const output = await call(commandOutputTool, { id: 1, stop: true });
    expect(output.content).toContain('Status: stopped');
  }, 20_000);

  // A poll must not put the whole output into the conversation again: only what is new since the last read.
  it('returns only new output on each read of a background command, and all of it with full', async () => {
    const shell = new ShellRunner(() => root);
    // A script file, because the result repeats the command line and must not contain the output words itself.
    writeFileSync(
      join(root, 'bg.js'),
      `process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 2500); setTimeout(() => {}, 30000);`,
    );
    const ctx = { ...context, shell };
    try {
      const started = await call(runCommandTool, { command: 'node bg.js', background: true }, ctx);
      expect(started.content).toContain('first');
      const id = Number(/Started background command (\d+)/.exec(started.content)![1]);

      const idle = await call(commandOutputTool, { id }, ctx);
      expect(idle.content).toContain('(no new output since your last read)');
      expect(idle.content).not.toContain('first');

      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const next = await call(commandOutputTool, { id }, ctx);
      expect(next.content).toContain('second');
      expect(next.content).not.toContain('first');

      const all = await call(commandOutputTool, { id, full: true }, ctx);
      expect(all.content).toContain('first');
      expect(all.content).toContain('second');
    } finally {
      shell.stopAll();
    }
  }, 30_000);

  // #187: a finished command whose output was read is released; another chat cannot see a chat's commands.
  it('drops a finished background command once its output has been read', async () => {
    const shell = new ShellRunner(() => root);
    const ctx = { ...context, shell, chatId: 'chat-a' };
    try {
      const started = await call(runCommandTool, { command: 'node -e "console.log(1)"', background: true }, ctx);
      expect(started.content).toContain('exited with code 0');
      expect(shell.getBackground(1, 'chat-a')).toBeUndefined();
      const gone = await call(commandOutputTool, { id: 1 }, ctx);
      expect(gone.isError).toBe(true);
    } finally {
      shell.stopAll();
    }
  }, 20_000);

  it('keeps a finished background command until its unread output is read, then drops it', async () => {
    const shell = new ShellRunner(() => root);
    const ctx = { ...context, shell, chatId: 'chat-a' };
    try {
      const entry = await shell.startBackground('node -e "console.log(2)"', undefined, {}, 'chat-a');
      await new Promise((resolve) => entry.process.once('close', resolve));
      expect(shell.getBackground(entry.id, 'chat-a')).toBe(entry);
      const read = await call(commandOutputTool, { id: entry.id }, ctx);
      expect(read.content).toContain('exited with code 0');
      expect(shell.getBackground(entry.id, 'chat-a')).toBeUndefined();
    } finally {
      shell.stopAll();
    }
  }, 20_000);

  it('keeps only the newest finished background commands that were never read', async () => {
    const shell = new ShellRunner(() => root);
    try {
      const entries = [];
      for (let i = 0; i < 7; i++) {
        const entry = await shell.startBackground('node -e "console.log(3)"', undefined, {}, 'chat-a');
        await new Promise((resolve) => entry.process.once('close', resolve));
        entries.push(entry);
      }
      expect(entries.map((e) => shell.getBackground(e.id, 'chat-a') !== undefined)).toEqual([
        false,
        false,
        true,
        true,
        true,
        true,
        true,
      ]);
    } finally {
      shell.stopAll();
    }
  }, 30_000);

  it('scopes background command ids to the chat that started them', async () => {
    const shell = new ShellRunner(() => root);
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const a = await shell.startBackground(command, undefined, {}, 'chat-a');
    const b = await shell.startBackground(command, undefined, {}, 'chat-b');
    try {
      expect([a.id, b.id]).toEqual([1, 1]);
      expect(shell.getBackground(1, 'chat-a')).toBe(a);
      expect(shell.getBackground(1, 'chat-b')).toBe(b);
      expect(shell.getBackground(1, 'chat-c')).toBeUndefined();
      expect(shell.getBackground(1)).toBeUndefined();

      const other = await call(commandOutputTool, { id: 1, stop: true }, { ...context, shell, chatId: 'chat-c' });
      expect(other.isError).toBe(true);
      expect(shell.stopBackground(1, 'chat-c')).toBe(false);
      expect(a.exitCode).toBeUndefined();

      expect(shell.stopBackground(1, 'chat-a')).toBe(true);
      expect(shell.getBackground(1, 'chat-b')).toBe(b);
    } finally {
      shell.stopAll();
      // The folder is removed next; wait until the stopped shells have released it.
      await Promise.all(
        [a, b].map((entry) => (entry.exitCode === undefined ? new Promise((r) => entry.process.once('close', r)) : 0)),
      );
    }
  }, 20_000);
});

describe('helpers', () => {
  it('truncates the middle of long output', () => {
    const text = 'a'.repeat(100) + 'b'.repeat(100);
    const result = truncateOutput(text, 50);
    expect(result.startsWith('a'.repeat(25))).toBe(true);
    expect(result.endsWith('b'.repeat(25))).toBe(true);
    expect(result).toContain('150 characters omitted');
  });

  it('extracts readable text from HTML', () => {
    const html = `<html><head><title>Docs</title></head><body><nav>menu</nav><article><h1>Install</h1><p>${'Run npm install to set up the project. '.repeat(20)}</p></article></body></html>`;
    const text = extractArticle(html);
    expect(text).toContain('Run npm install');
  });

  it('only offers tools that are configured', () => {
    const names = (ctx: Partial<ToolContext>) =>
      availableTools({ browser: null, codeSearch: null, webSearch: null, ...ctx }).map((tool) => tool.name);
    expect(names({})).not.toContain('web_search');
    expect(names({})).not.toContain('browser');
    expect(names({ webSearch: { googleApiKey: 'k', googleSearchEngineId: 'c' } })).toContain('web_search');
  });
});

describe('redacted placeholders', () => {
  it('are never written back into a file', async () => {
    await call(readFileTool, { path: 'src/app.ts' });
    await expect(
      call(editFileTool, {
        path: 'src/app.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = "[REDACTED:_____]";',
      }),
    ).rejects.toThrow('placeholder');
    await expect(call(writeFileTool, { path: 'new.txt', content: 'key=[REDACTED:_____]' })).rejects.toThrow(
      'placeholder',
    );
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
  });
});

describe('protected files', () => {
  it('make edits ask even in Auto mode', () => {
    const input = (path: string) => ({ path, content: 'x', old_string: 'a', new_string: 'b' });
    for (const tool of [writeFileTool, editFileTool]) {
      expect(tool.mustAsk!(input('.env') as never, context)).toBe(true);
      expect(tool.mustAsk!(input('.git/config') as never, context)).toBe(true);
      expect(tool.mustAsk!(input('src/app.ts') as never, context)).toBe(false);
    }
  });
});

describe('glob', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    writeFileSync(join(root, 'src', 'deep', 'util.test.ts'), '');
    writeFileSync(join(root, 'src', 'app.test.ts'), '');
    writeFileSync(join(root, 'README.md'), '');
  });

  const names = async (input: object) => ((await call(globTool, input)).content as string).split('\n');

  it('matches by name at any depth and skips ignored files', async () => {
    expect(await names({ pattern: '*.test.ts' })).toEqual(['src/app.test.ts', 'src/deep/util.test.ts']);
    expect(await names({ pattern: '*.log' })).toEqual(['No files match.']);
  });

  it('supports **, ? and alternatives against the whole path', async () => {
    expect(await names({ pattern: 'src/**/*.ts' })).toEqual(['src/app.test.ts', 'src/app.ts', 'src/deep/util.test.ts']);
    expect(await names({ pattern: 'src/*.ts' })).toEqual(['src/app.test.ts', 'src/app.ts']);
    expect(await names({ pattern: '{README,src/app}.{md,ts}' })).toEqual(['README.md', 'src/app.ts']);
    expect(await names({ pattern: 'src/ap?.ts' })).toEqual(['src/app.ts']);
  });

  it('searches inside a folder and pages long results', async () => {
    expect(await names({ pattern: '*.ts', path: 'src/deep' })).toEqual(['src/deep/util.test.ts']);
    const page = await names({ pattern: '*.ts', limit: 1, offset: 1 });
    expect(page[0]).toBe('src/app.ts');
    expect(page[1]).toContain('Use offset=2');
  });

  it('treats backslashes as separators and names a missing folder', async () => {
    expect(await names({ pattern: 'src\\*.ts' })).toEqual(['src/app.test.ts', 'src/app.ts']);
    await expect(call(globTool, { pattern: '*.ts', path: 'nope' })).rejects.toThrow('Not found: nope');
    await expect(call(grepTool, { pattern: 'x', path: 'nope' })).rejects.toThrow('Not found: nope');
  });
});

describe('grep limits', () => {
  it('shows at most 10 matches per file and 200 characters per line', async () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 30 }, (_, i) => `hit ${i}`).join('\n'));
    writeFileSync(join(root, 'wide.txt'), `hit ${'x'.repeat(500)}`);
    const text = (await call(grepTool, { pattern: '^hit ' })).content as string;
    expect(text.split('\n').filter((line) => line.startsWith('many.txt:'))).toHaveLength(10);
    expect(text).toContain('more in: many.txt');
    const wide = text.split('\n').find((line) => line.startsWith('wide.txt:'))!;
    expect(wide.length).toBeLessThan(230);
    expect(wide.endsWith('…')).toBe(true);
  });

  it('stops at 100 matches in total', async () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(root, `f${i}.txt`), Array.from({ length: 10 }, () => 'needle').join('\n'));
    }
    const text = (await call(grepTool, { pattern: 'needle' })).content as string;
    expect(text.split('\n').filter((line) => line.includes(':'))).toHaveLength(100);
    expect(text).toContain('Stopped at 100 matches');
  });

  // A prompt-injected pattern must not freeze the app (#122): it runs in a worker with a time limit.
  it('stops a catastrophically backtracking pattern instead of blocking the main process', async () => {
    writeFileSync(join(root, 'aaa.txt'), `${'a'.repeat(10_000)}!`);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const started = Date.now();
    try {
      const text = (await call(grepTool, { pattern: '(a+)+b', path: 'aaa.txt' })).content as string;
      expect(text).toContain('catastrophic backtracking');
      expect(text).toContain('aaa.txt');
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    // The event loop kept running while the pattern was being tested.
    expect(ticks).toBeGreaterThan(20);
  }, 20_000);

  it('ends a running search at once when the task is stopped', async () => {
    writeFileSync(join(root, 'aaa.txt'), `${'a'.repeat(10_000)}!`);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const text = (
      await call(grepTool, { pattern: '(a+)+b', path: 'aaa.txt' }, { ...context, signal: controller.signal })
    ).content as string;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(text).toContain('No matches.');
  });

  it('times out a glob with too many wildcards', async () => {
    writeFileSync(join(root, 'src', `${'a'.repeat(40)}.ts`), '');
    await expect(call(globTool, { pattern: `${'**a'.repeat(14)}b` })).rejects.toThrow(/Use fewer wildcards/);
  }, 20_000);
});

describe('fetch_url paging, cache and size cap', () => {
  let requests: string[];

  function serve(body: string | (() => Response), type = 'text/plain') {
    requests = [];
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    vi.spyOn(webTransport, 'request').mockImplementation(async (url) => {
      requests.push(url.href);
      return typeof body === 'function' ? body() : new Response(body, { headers: { 'content-type': type } });
    });
  }

  beforeEach(() => clearFetchCache());
  afterEach(() => {
    vi.restoreAllMocks();
    clearFetchCache();
  });

  const fetchText = async (input: object) => (await call(fetchUrlTool, input)).content as string;

  it('returns a long page in parts and reads the next part from the cache', async () => {
    serve('a'.repeat(20_000) + 'b'.repeat(5_000));
    const first = await fetchText({ url: 'https://docs.test/long' });
    expect(first).toContain('Use offset=20000 to read on');
    const second = await fetchText({ url: 'https://docs.test/long', offset: 20_000 });
    expect(second.startsWith('b'.repeat(5_000))).toBe(true);
    expect(second).not.toContain('read on');
    expect(requests).toHaveLength(1);
    await fetchText({ url: 'https://docs.test/long', force_refetch: true });
    expect(requests).toHaveLength(2);
    await expect(fetchText({ url: 'https://docs.test/long', offset: 99_999 })).rejects.toThrow('past the end');
  });

  it('lists the lines that match the objective first on a long page', async () => {
    const filler = Array.from({ length: 2000 }, (_, i) => `filler line number ${i}`).join('\n');
    serve(`${filler}\nThe retry budget is configured with maxRetries.\n${filler}`);
    const text = await fetchText({ url: 'https://docs.test/retry', objective: 'how is the retry budget configured' });
    expect(text.startsWith('Lines most relevant to')).toBe(true);
    expect(text).toContain('The retry budget is configured with maxRetries.');
  });

  it('stops reading a response at the byte cap', async () => {
    const chunk = new Uint8Array(512 * 1024).fill(97);
    let sent = 0;
    serve(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
              sent++;
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        ),
    );
    const text = await fetchText({ url: 'https://docs.test/endless', offset: 0 });
    expect(sent).toBeLessThan(10);
    expect(text).toContain('Use offset=20000 to read on');
    const body = await readBodyCapped(new Response('x'.repeat(100)), 40);
    expect(body).toEqual({ text: 'x'.repeat(40), truncated: true, timedOut: false });
  });

  it('keeps only the most recent pages', async () => {
    serve('x');
    for (let i = 0; i < 25; i++) await fetchText({ url: `https://docs.test/${i}` });
    await fetchText({ url: 'https://docs.test/24' });
    expect(requests).toHaveLength(25);
    await fetchText({ url: 'https://docs.test/0' });
    expect(requests).toHaveLength(26);
  });
});

describe('relevantLines', () => {
  it('ranks lines by shared words and ignores filler words', () => {
    const text = 'nothing here\nretry budget setting\nretry only\nunrelated';
    expect(relevantLines(text, 'the retry budget')).toEqual(['retry budget setting', 'retry only']);
    expect(relevantLines(text, 'the and')).toEqual([]);
  });
});
