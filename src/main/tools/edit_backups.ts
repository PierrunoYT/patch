import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UndoResult } from '@shared/ipc';
import { changeProjectFiles, readProjectFile } from './file_operations';
import { sha256 } from './text_files';
import type { EditUndo, FileUndo } from './types';
import type { Workspace } from './workspace';

// Backups kept per chat. Older ones are deleted as new edits come in.
const MAX_BACKUPS_PER_CHAT = 50;
const CHAT_ID = /^[0-9a-f-]{36}$/;

interface StoredFile {
  path: string;
  // Base64 of the file's bytes before the edit, or null when the edit created the file.
  before: string | null;
  // Null when the edit deleted the file.
  afterHash: string | null;
}

interface StoredBackup extends StoredFile {
  // The other files of a multi-file change (apply_patch), missing in backups of single-file edits.
  more?: StoredFile[];
}

const storeFile = (file: FileUndo): StoredFile => ({
  path: file.path,
  before: file.before ? file.before.toString('base64') : null,
  afterHash: file.afterHash,
});

const isStoredFile = (value: unknown): value is StoredFile => {
  const file = value as Partial<StoredFile> | null;
  return (
    typeof file?.path === 'string' &&
    (file.afterHash === null || typeof file.afterHash === 'string') &&
    (file.before === null || typeof file.before === 'string')
  );
};

// Copies of the files that approved edits changed, so an edit can be undone from its card in the chat. One JSON file per
// edit in <dir>/<chat id>/. These are copies of the user's own project files; they stay on this machine and are deleted
// with the chat.
export class EditBackups {
  constructor(private readonly dir: string) {}

  record(chatId: string, toolId: string, edit: EditUndo): void {
    const folder = this.chatFolder(chatId);
    mkdirSync(folder, { recursive: true });
    const stored: StoredBackup = {
      ...storeFile(edit),
      ...(edit.more?.length ? { more: edit.more.map(storeFile) } : {}),
    };
    writeFileSync(this.file(chatId, toolId), JSON.stringify(stored), 'utf8');
    this.prune(folder);
  }

  // Puts the files back as they were before the edit, but only if every one is still exactly as the edit left it, so
  // nothing written since (by the user or by a later edit) is lost. A multi-file change is undone as a whole or not at
  // all. The backup is used up by a successful undo. `absolute` is the first file's path, `absolutes` every file's.
  async undo(
    chatId: string,
    toolId: string,
    workspace: Workspace,
  ): Promise<UndoResult & { absolute: string; absolutes: string[] }> {
    const stored = this.read(chatId, toolId);
    if (!stored) throw new Error('The backup for this edit is no longer available.');

    const files = [stored, ...(stored.more ?? [])];
    const changes: Array<{ path: string; before: Buffer | null; after: Buffer | null }> = [];
    // Every file is checked before any is written.
    for (const file of files) {
      const current = await readProjectFile(workspace, file.path);
      const original = file.before === null ? null : Buffer.from(file.before, 'base64');
      if (file.afterHash === null) {
        if (current !== null) {
          throw new Error(`${file.path} was created again after this edit, so undoing it would overwrite that file.`);
        }
      } else if (current === null) {
        // Already gone: for a file the edit created, the state the user wants is reached.
        if (original !== null) {
          throw new Error(`${file.path} was deleted after this edit, so there is nothing to put back.`);
        }
        continue;
      } else if (sha256(current) !== file.afterHash) {
        throw new Error(
          `${file.path} was changed after this edit, so undoing it would lose those changes. Undo the later edits first, or restore the file with Git.`,
        );
      }
      changes.push({ path: file.path, before: current, after: original });
    }

    if (changes.length > 0) await changeProjectFiles(workspace, changes);
    if (files.some((file) => file.path.endsWith('.gitignore'))) workspace.invalidateIgnoreRules();
    this.forget(chatId, toolId);
    const action = (file: StoredFile) => (file.before === null ? ('deleted' as const) : ('restored' as const));
    const others = (stored.more ?? []).map((file) => ({ path: file.path, action: action(file) }));
    return {
      path: stored.path,
      action: action(stored),
      ...(others.length > 0 ? { others } : {}),
      absolute: workspace.resolve(stored.path),
      absolutes: files.map((file) => workspace.resolve(file.path)),
    };
  }

  deleteChat(chatId: string): void {
    if (CHAT_ID.test(chatId)) rmSync(this.chatFolder(chatId), { recursive: true, force: true });
  }

  deleteAll(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private read(chatId: string, toolId: string): StoredBackup | null {
    if (!CHAT_ID.test(chatId)) return null;
    try {
      const stored = JSON.parse(readFileSync(this.file(chatId, toolId), 'utf8')) as unknown;
      if (!isStoredFile(stored)) return null;
      const { more } = stored as StoredBackup;
      return more === undefined || (Array.isArray(more) && more.every(isStoredFile)) ? (stored as StoredBackup) : null;
    } catch {
      return null;
    }
  }

  private forget(chatId: string, toolId: string): void {
    rmSync(this.file(chatId, toolId), { force: true });
  }

  private chatFolder(chatId: string): string {
    if (!CHAT_ID.test(chatId)) throw new Error('Invalid chat id.');
    return join(this.dir, chatId);
  }

  // The id comes from the model, so it is hashed rather than used as a file name.
  private file(chatId: string, toolId: string): string {
    return join(this.chatFolder(chatId), `${createHash('sha256').update(toolId).digest('hex').slice(0, 40)}.json`);
  }

  private prune(folder: string): void {
    const files = readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, time: statSync(join(folder, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const old of files.slice(MAX_BACKUPS_PER_CHAT)) rmSync(join(folder, old.name), { force: true });
  }
}
