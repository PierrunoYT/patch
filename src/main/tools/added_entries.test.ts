import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddedEntries } from './added_entries';

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

// Used for the Windows sandbox only; recursive watching elsewhere starts too slowly for these short waits.
describe.skipIf(process.platform !== 'win32')('AddedEntries', () => {
  let root: string;
  let entries: AddedEntries;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-added-'));
    entries = new AddedEntries();
  });
  afterEach(() => {
    entries.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('starts watching with the first command and reports what was added since, once', async () => {
    expect(entries.take(root)).toEqual([]);
    await settle();
    writeFileSync(join(root, 'moved.txt'), 'x');
    await settle();
    expect(entries.take(root)).toEqual([join(root, 'moved.txt')]);
    expect(entries.take(root)).toEqual([]);
  });

  it('reports a folder rather than what is inside it, and leaves out what is gone again', async () => {
    entries.take(root);
    await settle();
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'folder', 'inner.txt'), 'x');
    writeFileSync(join(root, 'brief.txt'), 'x');
    rmSync(join(root, 'brief.txt'));
    await settle();
    expect(entries.take(root)).toEqual([join(root, 'folder')]);
  });

  it('leaves out an entry that only changed', async () => {
    writeFileSync(join(root, 'existing.txt'), 'old');
    entries.take(root);
    await settle();
    writeFileSync(join(root, 'existing.txt'), 'new content');
    await settle();
    expect(entries.take(root)).toEqual([]);
  });

  it('starts over for another project', async () => {
    entries.take(root);
    await settle();
    writeFileSync(join(root, 'a.txt'), 'x');
    await settle();
    const other = mkdtempSync(join(tmpdir(), 'patch-added-other-'));
    try {
      expect(entries.take(other)).toEqual([]);
      expect(entries.take(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
