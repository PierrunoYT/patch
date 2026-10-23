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
    // Patch's own instructions and files other programs run (#236).
    'AGENTS.md',
    'claude.md',
    '.patch/skills/release.md',
    '.mcp.json',
    '.gemini/settings.json',
    '.zed/settings.json',
    '.continue/config.json',
    '.kilocode/mcp.json',
    '.envrc',
    'services/api/.envrc',
    '.husky/pre-commit',
    '.agents/skills/release.md',
    // Hook managers, package managers, dev containers and other agents (#283).
    '.pre-commit-config.yaml',
    'lefthook.yml',
    '.lefthook.yml',
    '.simple-git-hooks.json',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    '.devcontainer/devcontainer.json',
    'my.code-workspace',
    'GEMINI.md',
    '.cursorrules',
    '.roo/rules.md',
    '.aider.conf.yml',
    // More secret files.
    '.git-credentials',
    'config/prod.env',
    'credentials.json',
    'infra/prod.tfvars',
    'terraform.tfstate',
    'terraform.tfstate.backup',
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
    // Only the project's own instruction files are read into chats.
    'docs/AGENTS.md',
    'src/patch/index.ts',
    'src/keyboard.ts',
    '.ENV.EXAMPLE',
    '.gitlab-ci.yml',
    'Jenkinsfile',
    'docs/GEMINI.md',
    'src/environment.ts',
  ])('does not guard %s', (path) => {
    expect(isGuardedPath(path)).toBe(false);
  });
});
