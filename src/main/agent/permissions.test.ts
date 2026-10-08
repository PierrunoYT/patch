import { describe, expect, it, vi } from 'vitest';
import type { PermissionRule } from '@shared/settings';
import { decidePermission, delegateCommand, globMatch, ruleMatches } from './permissions';

describe('globMatch', () => {
  it('matches * across any text and ? for one character', () => {
    expect(globMatch('git push*', 'git push origin main')).toBe(true);
    expect(globMatch('mcp__*', 'mcp__fs__read')).toBe(true);
    expect(globMatch('read_?ile', 'read_file')).toBe(true);
    expect(globMatch('git push*', 'echo git push')).toBe(false);
  });

  it('treats regular-expression characters literally', () => {
    expect(globMatch('a.b(c)', 'a.b(c)')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('src/**/*.ts', 'src/a/b.ts')).toBe(true);
  });
});

describe('ruleMatches', () => {
  const rule: PermissionRule = {
    tool: ['edit_file', 'write_file'],
    matches: { path: ['src/*', 'lib/*'] },
    action: 'reject',
  };

  it('needs the tool and every matcher to match', () => {
    expect(ruleMatches(rule, 'edit_file', { path: 'src/a.ts' }, 'thread')).toBe(true);
    expect(ruleMatches(rule, 'write_file', { path: 'lib/a.ts' }, 'thread')).toBe(true);
    expect(ruleMatches(rule, 'edit_file', { path: 'docs/a.md' }, 'thread')).toBe(false);
    expect(ruleMatches(rule, 'edit_file', {}, 'thread')).toBe(false);
    expect(ruleMatches(rule, 'grep', { path: 'src/a.ts' }, 'thread')).toBe(false);
  });

  it('honours the context filter', () => {
    const subagentOnly: PermissionRule = { tool: '*', action: 'reject', context: 'subagent' };
    expect(ruleMatches(subagentOnly, 'grep', {}, 'subagent')).toBe(true);
    expect(ruleMatches(subagentOnly, 'grep', {}, 'thread')).toBe(false);
  });
});

describe('decidePermission', () => {
  const rules: PermissionRule[] = [
    { tool: 'run_command', matches: { command: 'git push*' }, action: 'reject', message: 'no pushing' },
    { tool: 'run_command', matches: { command: 'git *' }, action: 'allow' },
    { tool: 'mcp__*', action: 'ask' },
    { tool: 'fetch_url', action: 'delegate', to: 'checker' },
  ];

  it('returns the first matching rule, or null', async () => {
    expect(await decidePermission(rules, 'run_command', { command: 'git push' }, 'thread')).toEqual({
      action: 'reject',
      message: 'no pushing',
    });
    expect(await decidePermission(rules, 'run_command', { command: 'git status' }, 'thread')).toMatchObject({
      action: 'allow',
    });
    expect(await decidePermission(rules, 'mcp__fs__read', {}, 'thread')).toMatchObject({ action: 'ask' });
    expect(await decidePermission(rules, 'run_command', { command: 'ls' }, 'thread')).toBeNull();
  });

  it('asks the delegate program with the call and uses its answer', async () => {
    const delegate = vi.fn(async () => 'allow\n');
    const input = { url: 'https://example.com' };
    expect(await decidePermission(rules, 'fetch_url', input, 'subagent', delegate)).toEqual({ action: 'allow' });
    expect(delegate).toHaveBeenCalledWith('checker', JSON.stringify({ tool: 'fetch_url', input, context: 'subagent' }));
  });

  it('rejects when the delegate fails or answers nonsense', async () => {
    const failing = async () => {
      throw new Error('boom');
    };
    expect(await decidePermission(rules, 'fetch_url', {}, 'thread', failing)).toMatchObject({ action: 'reject' });
    expect(await decidePermission(rules, 'fetch_url', {}, 'thread', async () => 'maybe')).toMatchObject({
      action: 'reject',
    });
  });

  it('runs a real program without a shell', async () => {
    const program = process.execPath;
    const decision = await decidePermission(
      [{ tool: '*', action: 'delegate', to: program }],
      'x',
      {},
      'thread',
      undefined,
    );
    // node with no script and piped stdin evaluates the JSON as code and fails, which must reject.
    expect(decision?.action).toBe('reject');
  });

  it('runs a program with arguments given as [program, ...args]', async () => {
    // The script reads the JSON call from stdin and allows only fetch_url calls in a thread.
    const script =
      "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>{const c=JSON.parse(s);" +
      "process.stdout.write(c.tool==='fetch_url'&&c.context===process.argv[1]?'allow\\n':'reject\\n')})";
    const rule: PermissionRule = { tool: '*', action: 'delegate', to: [process.execPath, '-e', script, 'thread'] };
    expect(await decidePermission([rule], 'fetch_url', { url: 'x' }, 'thread')).toEqual({ action: 'allow' });
    expect(await decidePermission([rule], 'grep', {}, 'thread')).toMatchObject({ action: 'reject' });
  });

  it('treats a string "to" as one program name, never split at spaces', async () => {
    const decision = await decidePermission(
      [{ tool: '*', action: 'delegate', to: `${process.execPath} -e "console.log('allow')"` }],
      'x',
      {},
      'thread',
    );
    expect(decision?.action).toBe('reject');
  });

  it('names the whole command line when the program fails', async () => {
    const failing = async () => {
      throw new Error('boom');
    };
    const rule: PermissionRule = { tool: '*', action: 'delegate', to: ['node', 'check.js', 'a b'] };
    expect(await decidePermission([rule], 'x', {}, 'thread', failing)).toEqual({
      action: 'reject',
      message: 'The permission program "node check.js "a b"" failed: boom',
    });
  });
});

describe('delegateCommand', () => {
  const options = { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true };

  it('spawns the program directly with its arguments', () => {
    expect(delegateCommand(['node', 'check.js', '--strict'], 'linux')).toEqual({
      file: 'node',
      args: ['check.js', '--strict'],
      options,
    });
    expect(delegateCommand('C:\\Program Files\\check.exe', 'win32')).toEqual({
      file: 'C:\\Program Files\\check.exe',
      args: [],
      options,
    });
    expect(delegateCommand('/opt/my tools/check', 'linux')).toEqual({ file: '/opt/my tools/check', args: [], options });
  });

  it('runs .cmd and .bat programs through cmd.exe on Windows, quoting every part', () => {
    expect(delegateCommand(['C:\\tools\\check.cmd', 'a b', 'x&y'], 'win32', undefined, {})).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\tools\\check.cmd" "a b" "x&y""'],
      options: { ...options, windowsVerbatimArguments: true },
    });
    // A bare name is looked up first, so `npx` is recognised as npx.cmd.
    const resolve = (program: string) => (program === 'npx' ? 'C:\\node\\npx.cmd' : program);
    expect(delegateCommand(['npx', 'checker'], 'win32', resolve, { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\node\\npx.cmd" "checker""'],
      options: { ...options, windowsVerbatimArguments: true },
    });
    expect(delegateCommand('check.BAT', 'win32', undefined, {}).args).toEqual(['/d', '/s', '/c', '""check.BAT""']);
    // Elsewhere a .cmd name is just a program.
    expect(delegateCommand(['x.cmd', 'a'], 'linux').file).toBe('x.cmd');
  });

  it.each(['50%', '!x!', 'say "hi"', 'a\nb', 'a\rb'])('refuses to pass %j to a .cmd program', (arg) => {
    expect(() => delegateCommand(['check.cmd', arg], 'win32')).toThrow(/cmd\.exe cannot pass/);
  });
});
