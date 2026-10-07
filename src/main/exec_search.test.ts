import { describe, expect, it } from 'vitest';
import { fixedSearchPath, hardenExecutableSearch } from './exec_search';

describe('fixedSearchPath', () => {
  it('keeps absolute POSIX entries and drops the ones that mean the working directory', () => {
    expect(fixedSearchPath(':/usr/bin:.:bin:/opt/tools/:', 'linux')).toEqual({
      path: '/usr/bin:/opt/tools/',
      dropped: ['', '.', 'bin', ''],
    });
  });

  it('keeps drive and UNC entries on Windows, quoted or not', () => {
    const path = 'C:\\Windows\\system32;"C:\\Program Files\\Git\\cmd";\\\\server\\tools;D:/bin';
    expect(fixedSearchPath(path, 'win32')).toEqual({ path, dropped: [] });
  });

  it('drops empty, relative, drive-relative and root-relative entries on Windows', () => {
    expect(fixedSearchPath('C:\\bin;;.;tools;C:tools;\\tools;..\\x', 'win32')).toEqual({
      path: 'C:\\bin',
      dropped: ['', '.', 'tools', 'C:tools', '\\tools', '..\\x'],
    });
  });
});

describe('hardenExecutableSearch', () => {
  it('turns off the working-directory search on Windows and cleans PATH whatever its spelling', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\bin;.' };
    expect(hardenExecutableSearch(env, 'win32')).toBe(1);
    expect(env).toEqual({ Path: 'C:\\bin', NoDefaultCurrentDirectoryInExePath: '1' });
  });

  it('only cleans PATH elsewhere', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin::/bin' };
    expect(hardenExecutableSearch(env, 'darwin')).toBe(1);
    expect(env).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('leaves a clean PATH as it is and copes with none', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    expect(hardenExecutableSearch(env, 'linux')).toBe(0);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(hardenExecutableSearch({}, 'linux')).toBe(0);
  });
});
