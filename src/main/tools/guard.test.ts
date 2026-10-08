import { describe, expect, it } from 'vitest';
import { isGuardedPath } from './guard';

describe('isGuardedPath', () => {
  it.each([
    '.env',
    'apps/web/.env.local',
    '.git/config',
    'sub/.git/hooks/pre-commit',
    '.ssh/id_rsa',
    'certs/server.pem',
    'deploy.KEY',
    '.vscode/tasks.json',
    '.claude/settings.json',
    'repo/.GIT/CONFIG',
    'repo/.SSH/ID_RSA',
    'repo/.VSCODE/TASKS.JSON',
    'repo/.BASHRC',
    '.npmrc',
    '.bashrc',
    'data/app.sqlite',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/etc/passwd',
  ])('guards %s', (path) => {
    expect(isGuardedPath(path)).toBe(true);
  });

  it.each([
    'src/app.ts',
    '.env.example',
    'config/.env.sample',
    '.gitignore',
    '.github/workflows/ci.yml',
    'docs/environment.md',
    'AGENTS.md',
    'src/keyboard.ts',
    '.ENV.EXAMPLE',
  ])('does not guard %s', (path) => {
    expect(isGuardedPath(path)).toBe(false);
  });
});
