import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
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

// Writes via a temporary file and rename so a crash mid-write never leaves a truncated file behind.
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temp, path);
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
export function writeJsonLater(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
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
  // One name per file: writes to a file never overlap, and a temporary file left by a crash is reused.
  const temp = `${path}.later.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    while (write.next !== null) {
      const text = write.next;
      write.next = null;
      write.stale = false;
      await writeFile(temp, text, 'utf8');
      // Checked and renamed in one synchronous step, so nothing newer can land in between.
      if (!write.stale) renameSync(temp, path);
    }
  } finally {
    laterWrites.delete(path);
    rmSync(temp, { force: true });
  }
}

// Drops a write from writeJsonLater that has not landed yet, e.g. because the file is being deleted.
export function cancelJsonWrite(path: string): void {
  const write = laterWrites.get(path);
  if (!write) return;
  write.next = null;
  write.stale = true;
}
