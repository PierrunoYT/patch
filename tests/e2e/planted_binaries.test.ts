import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitStatus } from '../../src/shared/panels';
import { launchApp, type RunningApp } from './app';

// A repository can commit a program named like one Patch starts by bare name. Windows looks for such a name in the
// working directory before PATH, and an empty PATH entry does the same everywhere, so `git status` on opening the
// project would run the repository's program instead of git (#141).
describe('programs planted in a project', () => {
  let running: RunningApp;
  let project: string;
  let marker: string;
  const savedNoCwdSearch = process.env.NoDefaultCurrentDirectoryInExePath;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-planted-'));
    marker = join(project, 'planted-git-ran');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), '# Demo\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(project, 'notes.txt'), 'untracked\n');

    if (process.platform === 'win32') {
      // Any harmless program shows the problem: if it runs instead of git, the status below is not a repository.
      copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(project, 'git.exe'));
      // The test runner may have it set; the app must set it itself.
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      running = await launchApp();
    } else {
      writeFileSync(join(project, 'git'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
      chmodSync(join(project, 'git'), 0o755);
      // An empty entry means "the working directory" to execvp.
      running = await launchApp({ PATH: `${delimiter}${process.env.PATH ?? ''}` });
    }
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
  });

  afterAll(async () => {
    if (savedNoCwdSearch === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
    else process.env.NoDefaultCurrentDirectoryInExePath = savedNoCwdSearch;
    await running?.close();
    rmSync(project, { recursive: true, force: true });
  });

  it('runs the real git for the Git panel, not the project’s copy', async () => {
    const status = (await running.page.evaluate(() => window.api.invoke('git:status'))) as GitStatus;
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.files.map((file) => file.path)).toContain('notes.txt');
    expect(existsSync(marker)).toBe(false);
  });
});
