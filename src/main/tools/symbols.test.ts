import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShellRunner } from './shell';
import { findDefinitionTool, findReferencesTool, symbolAt } from './symbols';
import type { AgentTool, ToolContext } from './types';
import { Workspace } from './workspace';

let root: string;
let context: ToolContext;

async function call(tool: AgentTool, input: unknown): Promise<string> {
  const result = await tool.run(tool.schema!.parse(input), context);
  return result.content as string;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-symbols-'));
  const workspace = new Workspace(root);
  context = {
    workspace,
    signal: new AbortController().signal,
    readFiles: new Map(),
    shell: new ShellRunner(() => workspace.root),
    browser: null,
    codeSearch: null,
    webSearch: null,
    onProgress: () => {},
  };
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'runner.ts'),
    [
      '// spawn is called by run',
      'export class Runner {',
      '  private count = 0;',
      '  async spawn(command: string): Promise<number> {',
      '    return this.count++;',
      '  }',
      '}',
      'export function helper(): void {}',
      'export const LIMIT = 5;',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      "import { Runner } from './runner';",
      '// Runner is documented elsewhere',
      'const r = new Runner();',
      'await r.spawn("ls");',
      'const text = "spawnable";',
    ].join('\n'),
  );
  writeFileSync(join(root, 'tool.py'), 'class Parser:\n    def parse(self, text):\n        return text\n');
  writeFileSync(join(root, 'other.ts'), 'export class Other {\n  spawn(): void {}\n}\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('find_definition', () => {
  it('finds a class, a function, a constant and a method with its signature', async () => {
    expect(await call(findDefinitionTool, { symbol: 'Runner' })).toContain(
      'src/runner.ts:2\n  2: export class Runner {',
    );
    expect(await call(findDefinitionTool, { symbol: 'helper' })).toContain('src/runner.ts:8');
    expect(await call(findDefinitionTool, { symbol: 'LIMIT' })).toContain('src/runner.ts:9');
    expect(await call(findDefinitionTool, { symbol: 'spawn', path: 'src/runner.ts' })).toContain(
      '4: async spawn(command: string): Promise<number> {',
    );
  });

  it('skips comments, strings and calls', async () => {
    const out = await call(findDefinitionTool, { symbol: 'spawn' });
    expect(out).not.toContain('use.ts');
    expect(out).not.toContain('// spawn is called');
  });

  it('prefers files that mention the class of Class.method', async () => {
    const out = await call(findDefinitionTool, { symbol: 'Runner.spawn' });
    expect(out).toContain('src/runner.ts:4');
    expect(out).not.toContain('other.ts');
  });

  it('finds Python definitions and reports a miss', async () => {
    expect(await call(findDefinitionTool, { symbol: 'parse' })).toContain('tool.py:2');
    expect(await call(findDefinitionTool, { symbol: 'missing' })).toContain('No definition of missing');
  });

  it('rejects what is not a symbol name', async () => {
    await expect(call(findDefinitionTool, { symbol: 'a b' })).rejects.toThrow('Not a symbol name');
  });
});

describe('find_references', () => {
  it('lists whole-word uses, skips comments and strings that only contain the name, and marks declarations', async () => {
    const out = await call(findReferencesTool, { symbol: 'Runner' });
    expect(out).toContain("src/use.ts:1: import { Runner } from './runner';");
    expect(out).toContain('src/use.ts:3: const r = new Runner();');
    expect(out).toContain('src/runner.ts:2: export class Runner { [definition]');
    expect(out).not.toContain('documented elsewhere');
    const spawns = await call(findReferencesTool, { symbol: 'spawn' });
    expect(spawns).toContain('src/use.ts:4');
    expect(spawns).not.toContain('spawnable');
    expect(spawns).not.toContain('// spawn is called');
  });

  it('takes a place instead of a name', async () => {
    expect(await call(findReferencesTool, { path: 'src/use.ts', line: 4, column: 6 })).toContain('src/use.ts:4');
    await expect(call(findReferencesTool, { path: 'src/use.ts' })).rejects.toThrow('Give either symbol');
    await expect(call(findReferencesTool, { path: 'src/use.ts', line: 99 })).rejects.toThrow('no line 99');
  });

  it('says so when nothing uses the name', async () => {
    expect(await call(findReferencesTool, { symbol: 'nothingHere' })).toContain('No references to nothingHere');
  });

  it('caps the matches per file', async () => {
    writeFileSync(join(root, 'many.ts'), Array.from({ length: 30 }, () => 'target();').join('\n'));
    const out = await call(findReferencesTool, { symbol: 'target' });
    expect(out.split('\n').filter((line) => line.startsWith('many.ts:'))).toHaveLength(20);
    expect(out).toContain('more in: many.ts');
  });
});

describe('symbolAt', () => {
  it('picks the identifier at a column, else the longest', () => {
    expect(symbolAt('const value = compute(a);', 15)).toBe('compute');
    expect(symbolAt('const value = compute(a);')).toBe('compute');
    expect(symbolAt('  ', undefined)).toBeNull();
  });
});
