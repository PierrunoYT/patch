import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToolError } from './types';
import { isPackagedElectron } from './sandbox_windows';
import type { Workspace } from './workspace';

interface Change {
  path: string;
  before: Buffer | null;
  after: Buffer | null;
}

type Operation =
  { kind: 'read'; path: string } | { kind: 'change'; path: string; before: string | null; after: string | null };

function helperPath(): string {
  const name = process.platform === 'win32' ? 'file-helper.exe' : 'file-helper';
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = isPackagedElectron(process.versions.electron, process.execPath, process.platform);
  // Packaged apps must never fall back to a helper from a checkout or the working directory.
  const paths = packaged
    ? resources
      ? [join(resources, name)]
      : []
    : [
        join(__dirname, '../../native/sandbox-helper/target/release', name),
        join(__dirname, '../../../native/sandbox-helper/target/release', name),
      ];
  const helper = paths.find((path) => existsSync(path));
  if (!helper)
    throw new ToolError(
      'The native file helper was not found. Build it with npm run build:sandbox. No file was changed.',
    );
  return helper;
}

async function execute(workspace: Workspace, operations: Operation[]): Promise<(Buffer | null)[]> {
  const input = JSON.stringify({
    root: workspace.root,
    operations: operations.map((operation) => {
      workspace.resolve(operation.path);
      const absolute = resolve(workspace.root, operation.path);
      let root = workspace.root;
      if (isAbsolute(operation.path)) {
        // An absolute input may spell the root through a system alias (/tmp on macOS, or Windows 8.3).
        // Use its outermost root-equivalent prefix; never canonicalize components below the project root.
        for (let parent = dirname(absolute); parent !== dirname(parent); parent = dirname(parent)) {
          try {
            if (realpathSync.native(parent) === workspace.root) root = parent;
          } catch {
            // Missing parents are created by the native helper, never by a host pathname write.
          }
        }
      }
      // Keep the caller's spelling for the native no-follow walk. Using the canonical target here would erase
      // a link introduced after the approval check, including a link to a protected file inside the project.
      return { ...operation, path: relative(root, absolute).split(sep).join('/') };
    }),
  });
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const output: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => output.push(data));
    // The helper never writes file content to stderr; drain it without logging paths or contents.
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new ToolError('The native file helper failed. Inspect the files before retrying.');
        const result = JSON.parse(Buffer.concat(output).toString('utf8')) as {
          ok: boolean;
          error?: string;
          files: (string | null)[];
        };
        if (!result.ok) throw new ToolError(result.error ?? 'Native file operation refused.');
        resolve(result.files.map((bytes) => (bytes === null ? null : Buffer.from(bytes, 'base64'))));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

// Callers still resolve paths and enforce approval/read-before-edit. The helper independently confines each
// component, compares the expected bytes through an open handle, and never follows a substituted symlink.
export async function readProjectFile(workspace: Workspace, path: string): Promise<Buffer | null> {
  const [bytes] = await execute(workspace, [{ kind: 'read', path }]);
  return bytes ?? null;
}

export async function changeProjectFiles(workspace: Workspace, changes: Change[]): Promise<void> {
  await execute(
    workspace,
    changes.map(({ path, before, after }) => ({
      kind: 'change',
      path,
      before: before?.toString('base64') ?? null,
      after: after?.toString('base64') ?? null,
    })),
  );
}
