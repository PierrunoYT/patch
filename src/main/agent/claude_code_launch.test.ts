import { describe, expect, it } from 'vitest';
import { ANTHROPIC_API_URL } from '../llm/endpoints';
import { claudeCodeEnv, findClaudeCode } from './claude_code_launch';

const existing =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe('findClaudeCode', () => {
  it('uses a configured absolute path, trimmed, when it exists', () => {
    expect(
      findClaudeCode('  C:\\Tools\\claude.exe ', {
        platform: 'win32',
        isFile: existing('C:\\Tools\\claude.exe'),
      }),
    ).toBe('C:\\Tools\\claude.exe');
    expect(findClaudeCode('/opt/claude', { platform: 'linux', isFile: existing('/opt/claude') })).toBe('/opt/claude');
  });

  it('does not use a configured path that is relative, missing or not absolute for the platform', () => {
    const everything = () => true;
    expect(findClaudeCode('claude.exe', { platform: 'win32', isFile: everything })).toBeNull();
    expect(findClaudeCode('./claude', { platform: 'linux', isFile: everything })).toBeNull();
    expect(findClaudeCode('C:\\Tools\\claude.exe', { platform: 'linux', isFile: everything })).toBeNull();
    expect(findClaudeCode('C:\\Tools\\claude.exe', { platform: 'win32', isFile: () => false })).toBeNull();
  });

  it('does not use a Windows path that depends on the current drive or folder', () => {
    const everything = () => true;
    expect(findClaudeCode('\\tools\\claude.exe', { platform: 'win32', isFile: everything })).toBeNull();
    expect(findClaudeCode('/tools/claude.exe', { platform: 'win32', isFile: everything })).toBeNull();
    expect(findClaudeCode('C:tools\\claude.exe', { platform: 'win32', isFile: everything })).toBeNull();
    expect(findClaudeCode('"C:\\Tools\\claude.exe"', { platform: 'win32', isFile: everything })).toBeNull();
  });

  it('accepts a fully qualified drive or UNC path', () => {
    const exists = existing('C:/Tools/claude.exe', '\\\\server\\share\\claude.exe');
    expect(findClaudeCode('C:/Tools/claude.exe', { platform: 'win32', isFile: exists })).toBe('C:/Tools/claude.exe');
    expect(findClaudeCode('\\\\server\\share\\claude.exe', { platform: 'win32', isFile: exists })).toBe(
      '\\\\server\\share\\claude.exe',
    );
  });

  it('searches PATH in order and skips empty, dot and relative entries', () => {
    const env = { Path: ';.;relative\\bin;"C:\\Quoted Tools";C:\\Bin;C:\\Later' };
    const exists = existing(
      '.\\claude.exe',
      'relative\\bin\\claude.exe',
      'C:\\Quoted Tools\\claude.exe',
      'C:\\Bin\\claude.exe',
      'C:\\Later\\claude.exe',
    );
    expect(findClaudeCode('', { platform: 'win32', env, home: 'C:\\Users\\me', isFile: exists })).toBe(
      'C:\\Quoted Tools\\claude.exe',
    );
    expect(
      findClaudeCode('', { platform: 'win32', env: { Path: 'C:\\Bin' }, home: 'C:\\Users\\me', isFile: exists }),
    ).toBe('C:\\Bin\\claude.exe');
  });

  it('uses the PATH folders before the install folders on Linux and macOS', () => {
    const exists = existing('/usr/bin/claude', '/home/me/.local/bin/claude', '/opt/homebrew/bin/claude');
    expect(
      findClaudeCode('', {
        platform: 'linux',
        env: { PATH: '/usr/bin:/home/me/.local/bin' },
        home: '/home/me',
        isFile: exists,
      }),
    ).toBe('/usr/bin/claude');
    expect(findClaudeCode('', { platform: 'linux', env: { PATH: '' }, home: '/home/me', isFile: exists })).toBe(
      '/home/me/.local/bin/claude',
    );
    expect(
      findClaudeCode('', { platform: 'darwin', env: { PATH: '/Applications' }, home: '/Users/me', isFile: exists }),
    ).toBe('/opt/homebrew/bin/claude');
  });

  it('finds the native installer in the home folder when nothing is configured', () => {
    expect(
      findClaudeCode('', {
        platform: 'win32',
        env: {},
        home: 'C:\\Users\\me',
        isFile: existing('C:\\Users\\me\\.local\\bin\\claude.exe'),
      }),
    ).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
  });

  it('looks for the Windows program only as claude.exe, never a shell shim', () => {
    expect(
      findClaudeCode('', {
        platform: 'win32',
        env: {},
        home: 'C:\\Users\\me',
        isFile: existing('C:\\Users\\me\\.local\\bin\\claude.cmd'),
      }),
    ).toBeNull();
  });

  it('returns null when Claude Code is not installed', () => {
    expect(findClaudeCode('', { platform: 'linux', env: {}, home: '/home/me', isFile: () => false })).toBeNull();
  });
});

describe('claudeCodeEnv', () => {
  const base = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://inherited.example', ANTHROPIC_AUTH_TOKEN: 'token' };

  it('keeps Claude Code on its own sign-in when no key is forwarded, and turns off its other traffic', () => {
    expect(claudeCodeEnv(base, null)).toEqual({ ...base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  });

  it('gives the saved key to the configured base URL, replacing an inherited one', () => {
    const env = claudeCodeEnv(base, { key: 'sk-ant-test', baseUrl: 'http://127.0.0.1:9' });
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('sends the saved key to the official API when no base URL is set, not to an inherited one', () => {
    expect(claudeCodeEnv(base, { key: 'sk-ant-test', baseUrl: '' }).ANTHROPIC_BASE_URL).toBe(ANTHROPIC_API_URL);
  });

  it('does not change the environment it was given', () => {
    const input = { PATH: '/bin' };
    claudeCodeEnv(input, { key: 'sk-ant-test', baseUrl: '' });
    expect(input).toEqual({ PATH: '/bin' });
  });
});
