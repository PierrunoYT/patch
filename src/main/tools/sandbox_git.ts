import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Workspace } from './workspace';

// The first version supports an ordinary repository rooted at the selected project, not gitfiles/worktrees.
// Never create placeholder metadata on the host or silently run an unsupported layout without the sandbox.
export function validateSandboxGit(cwd: string): void {
  const refuse = (reason: string): never => {
    throw new Error(
      `Cannot protect Git metadata: ${reason}. Use the Git panel or request explicit unsandboxed access. The command was not run.`,
    );
  };
  try {
    const workspace = new Workspace(cwd);
    const git = join(workspace.root, '.git');
    const root = lstatSync(git);
    if (!root.isDirectory() || root.isSymbolicLink()) refuse('the project must have its own regular .git directory');
    workspace.resolve('.git');
    if (existsSync(workspace.resolve('.git/commondir'))) refuse('shared Git directories are not supported');
    const pending = [git];
    let entries = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const name of readdirSync(directory)) {
        if (++entries > 100_000) refuse('the metadata tree is too large to validate safely');
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
          refuse('linked Git metadata is not supported');
        workspace.resolve(relative(workspace.root, path));
        if (stat.isDirectory()) pending.push(path);
        else if (!stat.isFile()) refuse('special files in Git metadata are not supported');
      }
    }
    // These can redirect host Git to writable files outside the protected tree. Parse without following includes
    // or invoking repository commands; do not approximate Git's quoting/continuation syntax with a config regex.
    for (const name of ['config', 'config.worktree']) {
      const path = workspace.resolve(`.git/${name}`);
      if (!existsSync(path)) continue;
      const keys = execFileSync('git', ['config', '--file', path, '--no-includes', '--null', '--name-only', '--list'], {
        cwd: workspace.root,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).split('\0');
      if (
        keys.some((key) =>
          /^(include\.|includeif\.|alias\.|filter\.|credential\.|diff\..*\.(command|textconv)$|core\.(worktree|hookspath|fsmonitor|sshcommand|editor|pager|attributesfile)$)/i.test(
            key,
          ),
        )
      )
        refuse('Git configuration includes, command overrides, and external metadata are not supported');
    }
    const hooks = workspace.resolve('.git/hooks');
    if (existsSync(hooks) && readdirSync(hooks).some((name) => !name.endsWith('.sample')))
      refuse('active Git hooks can execute writable project files');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot protect Git metadata:')) throw error;
    refuse('the metadata directory is missing, unreadable, or unsupported');
  }
}
