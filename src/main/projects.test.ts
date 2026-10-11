import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore } from './projects';

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'patch-projects-store-')));
  mkdirSync(join(dir, 'Work'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ProjectStore', () => {
  it('knows only folders that are open or in the project list (#282)', () => {
    mkdirSync(join(dir, 'Other'));
    const store = new ProjectStore(join(dir, 'projects.json'));
    expect(store.isKnown(join(dir, 'Work'))).toBe(false);
    store.open(join(dir, 'Work'));
    expect(store.isKnown(join(dir, 'Work', '.'))).toBe(true);
    expect(store.isKnown(join(dir, 'Other'))).toBe(false);
    // Closed but still listed, and remembered after a restart.
    store.close(join(dir, 'Work'));
    expect(store.isKnown(join(dir, 'Work'))).toBe(true);
    expect(new ProjectStore(join(dir, 'projects.json')).isKnown(join(dir, 'Work'))).toBe(true);
    expect(() => store.isKnown(join(dir, 'missing'))).toThrow('Folder not found');
  });

  it.runIf(process.platform === 'win32')('treats the same folder typed with different casing as one project', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    const first = store.open(join(dir, 'Work'));
    const second = store.open(join(dir, 'work'));
    expect(second.path).toBe(first.path);
    expect(store.list()).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('merges projects stored in other casing by an older version', () => {
    const real = join(dir, 'Work');
    const lower = join(dir, 'work');
    writeFileSync(
      join(dir, 'projects.json'),
      JSON.stringify([
        { path: lower, name: 'work', instructions: '', allowedCommands: 'npm test', lastOpened: '2026-10-02' },
        { path: real, name: 'Work', instructions: 'Be brief.', lastOpened: '2026-10-01' },
      ]),
    );
    const store = new ProjectStore(join(dir, 'projects.json'));
    expect(store.list()).toEqual([
      { path: real, name: 'Work', instructions: 'Be brief.', allowedCommands: 'npm test', lastOpened: '2026-10-02' },
    ]);
    expect(store.open(lower).instructions).toBe('Be brief.');
    expect(store.list()).toHaveLength(1);
  });

  it('stores a project under its real path', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    expect(store.open(join(dir, 'Work')).path).toBe(join(dir, 'Work'));
  });
});
