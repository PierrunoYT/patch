import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../tools/shell';
import { CHECK_TIMEOUT_SECONDS, EditChecker, MAX_CHECK_LINES, relevantDiagnostics } from './edit_check';

const result = (output: string, exitCode: number | null = 1, extra: Partial<CommandResult> = {}): CommandResult => ({
  exitCode,
  output,
  timedOut: false,
  aborted: false,
  ...extra,
});

describe('relevantDiagnostics', () => {
  const output = [
    'src/a.ts(3,5): error TS2322: Type string is not assignable.',
    '  Type "x" is not assignable to type number.',
    'src/old.ts(1,1): error TS1005: old problem.',
    '  old note',
    'Found 2 errors.',
  ].join('\n');

  it('keeps the lines about edited files with their indented continuation, and drops the rest', () => {
    expect(relevantDiagnostics(output, ['src/a.ts'], null)).toEqual(output.split('\n').slice(0, 2));
  });

  it('matches Windows separators and letter case', () => {
    expect(relevantDiagnostics('SRC\\A.ts:1:1: error x', ['src/a.ts'], null)).toHaveLength(1);
  });

  it('with a baseline, drops lines it already had and adds new errors in other files', () => {
    const previous = new Set(['src/a.ts(3,5): error TS2322: Type string is not assignable.']);
    const next = `${output}\nsrc/importer.ts(9,1): error TS2305: no exported member.`;
    expect(relevantDiagnostics(next, ['src/a.ts'], previous)).toEqual([
      '  Type "x" is not assignable to type number.',
      'src/old.ts(1,1): error TS1005: old problem.',
      'src/importer.ts(9,1): error TS2305: no exported member.',
    ]);
  });
});

describe('EditChecker', () => {
  const checker = (outputs: CommandResult[]) => {
    const calls: Array<[string, number]> = [];
    const instance = new EditChecker(async (command, timeout) => {
      calls.push([command, timeout]);
      return outputs.shift()!;
    });
    return { instance, calls };
  };
  const signal = new AbortController().signal;

  it('does nothing without a command, edits or after a stop', async () => {
    const { instance, calls } = checker([]);
    expect(await instance.check('  ', ['a.ts'], signal)).toBeNull();
    expect(await instance.check('tsc', [], signal)).toBeNull();
    const stopped = new AbortController();
    stopped.abort();
    expect(await instance.check('tsc', ['a.ts'], stopped.signal)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('reports a clean run in one line', async () => {
    const { instance, calls } = checker([result('', 0)]);
    expect(await instance.check('tsc', ['a.ts'], signal)).toContain('no errors');
    expect(calls).toEqual([['tsc', CHECK_TIMEOUT_SECONDS]]);
  });

  it('reports errors in the edited files, caps them, and reports only new ones the next time', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `a.ts(${i + 1},1): error TS1: bad ${i}`);
    const { instance } = checker([
      result(lines.join('\n')),
      result([...lines, 'a.ts(50,1): error TS1: fresh'].join('\n')),
    ]);
    const first = (await instance.check('tsc', ['a.ts'], signal))!;
    expect(first).toContain('exit code 1');
    expect(first).toContain(lines[0]!);
    expect(first).not.toContain(lines[MAX_CHECK_LINES]!);
    expect(first).toContain(`and ${40 - MAX_CHECK_LINES} more lines`);
    const second = (await instance.check('tsc', ['a.ts'], signal))!;
    expect(second).toContain('fresh');
    expect(second).not.toContain('bad 0');
  });

  it('says so when the check fails elsewhere, times out or cannot start, and never throws', async () => {
    const { instance } = checker([
      result('other.ts(1,1): error x', 2),
      result('', null, { timedOut: true }),
      result('spawn failed', null),
    ]);
    expect(await instance.check('tsc', ['a.ts'], signal)).toContain('nothing new about the files you edited');
    expect(await instance.check('tsc', ['a.ts'], signal)).toContain('stopped after');
    expect(await instance.check('tsc', ['a.ts'], signal)).toContain('could not run');
    const broken = new EditChecker(async () => {
      throw new Error('x');
    });
    expect(await broken.check('tsc', ['a.ts'], signal)).toBeNull();
  });
});
