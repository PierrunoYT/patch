import { randomUUID } from 'node:crypto';
import {
  closeSync,
  type Dirent,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { appLog } from '../app_log';

// Reads a JSON file, returning `fallback` if it is missing or unreadable. A file that exists but is not valid JSON is
// renamed to `<file>.corrupt-<timestamp>` first, so the next write to the path does not destroy what a hand edit, a
// sync tool or a crash left behind.
export function readJson<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    keepCorruptCopy(path);
    return fallback;
  }
}

function keepCorruptCopy(path: string): void {
  const copy = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, copy);
    appLog.warn('storage', 'A file was not valid JSON and was set aside.', { file: basename(copy) });
  } catch {
    appLog.warn('storage', 'A file was not valid JSON and could not be set aside.', { file: basename(path) });
  }
}

// A random temporary name next to the file. It is created with `wx`, so a file or link already at the name makes the
// write fail instead of being followed or replaced (#124).
function tempName(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

// How a value is written. Large files that nobody reads by hand (chats) are written without indentation.
export interface JsonWriteOptions {
  compact?: boolean;
}

function stringify(value: unknown, options: JsonWriteOptions): string {
  return options.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

// Writes via a temporary file and rename so a crash mid-write never leaves a truncated file behind.
export function writeJson(path: string, value: unknown, options: JsonWriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempName(path);
  // Throws before anything is created when the name is taken; that file is not ours to remove.
  const fd = openSync(temp, 'wx');
  try {
    try {
      writeFileSync(fd, stringify(value, options), 'utf8');
      // On disk before the rename, so a power loss cannot leave an empty file under the real name (#259).
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  // This is the newest content: a write still on its way from writeJsonLater must not replace it.
  cancelJsonWrite(path);
}

interface LaterWrite {
  // The newest content still to write, or null when there is none.
  next: string | null;
  // Set when the content being written was replaced or cancelled, so it is not moved into place.
  stale: boolean;
  done: Promise<void>;
}

// Files with a write from writeJsonLater on its way. One write per file runs at a time.
const laterWrites = new Map<string, LaterWrite>();

// Like writeJson, but only the serializing blocks the caller: the file is written in the background and moved into
// place when it is complete. Writes to one file land in the order they were asked for, and content that a newer
// write replaced before it was written is skipped. A writeJson to the same file in the meantime wins. The promise
// settles when no write to the file is left, and is the same one for calls that join a write already running.
export function writeJsonLater(path: string, value: unknown, options: JsonWriteOptions = {}): Promise<void> {
  const text = stringify(value, options);
  const running = laterWrites.get(path);
  if (running) {
    running.next = text;
    return running.done;
  }
  const write: LaterWrite = { next: text, stale: false, done: Promise.resolve() };
  laterWrites.set(path, write);
  write.done = drain(path, write);
  return write.done;
}

async function drain(path: string, write: LaterWrite): Promise<void> {
  // Writes to a file never overlap, so one random name serves the whole run; it is free again after each rename.
  const temp = tempName(path);
  // False when the name turned out to be taken: that file is not ours to remove.
  let ours = true;
  try {
    await mkdir(dirname(path), { recursive: true });
    while (write.next !== null) {
      const text = write.next;
      write.next = null;
      write.stale = false;
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Checked and renamed in one synchronous step, so nothing newer can land in between.
      if (!write.stale) renameSync(temp, path);
      else rmSync(temp, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') ours = false;
    throw error;
  } finally {
    laterWrites.delete(path);
    // A write that failed half-way may have left the file.
    if (ours) rmSync(temp, { force: true });
  }
}

// Temporary files of writeJson and writeJsonLater: `<name>.json.<random UUID>.tmp`, plus the `.<pid>.tmp` and
// `.later.tmp` names of earlier versions.
const TEMP_FILE = /\.json\.(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|later)\.tmp$/i;

// How old a temporary file must be before start-up cleanup removes it. A write takes milliseconds, so an older file
// belongs to no running write, in this process or another one.
export const STALE_TEMP_AGE_MS = 5 * 60_000;

// Removes temporary files that a crash left between writing and renaming, in `dir` only (not its subfolders). Files
// younger than `maxAgeMs` are kept. Returns how many were removed.
export function removeStaleTempFiles(dir: string, maxAgeMs = STALE_TEMP_AGE_MS, now = Date.now()): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
    const file = join(dir, entry.name);
    try {
      if (now - lstatSync(file).mtimeMs < maxAgeMs) continue;
      rmSync(file, { force: true });
      removed++;
    } catch {
      // Gone already, or not removable: try again on the next start.
    }
  }
  if (removed > 0) appLog.info('storage', 'Removed temporary files left by an interrupted write.', { count: removed });
  return removed;
}

// Settles when no write from writeJsonLater is left, including ones asked for while waiting, e.g. before a folder
// they write into is deleted. Failed writes count as finished: the caller of writeJsonLater gets their errors.
export async function flushJsonWrites(): Promise<void> {
  while (laterWrites.size > 0) await Promise.allSettled([...laterWrites.values()].map((write) => write.done));
}

// Drops a write from writeJsonLater that has not landed yet, e.g. because the file is being deleted.
export function cancelJsonWrite(path: string): void {
  const write = laterWrites.get(path);
  if (!write) return;
  write.next = null;
  write.stale = true;
}
