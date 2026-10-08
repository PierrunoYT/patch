import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelJsonWrite,
  flushJsonWrites,
  readJson,
  removeStaleTempFiles,
  STALE_TEMP_AGE_MS,
  writeJson,
  writeJsonLater,
} from './json_file';

// Lets a test choose the next temporary name; otherwise the real random UUID is used.
const uuid = vi.hoisted(() => ({ next: null as string | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      const next = uuid.next;
      uuid.next = null;
      return next ?? actual.randomUUID();
    },
  };
});

const FIXED_UUID = '01234567-89ab-cdef-0123-456789abcdef';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-json-'));
});

afterEach(() => {
  uuid.next = null;
  rmSync(dir, { recursive: true, force: true });
});

// Places a symbolic link at `path` pointing at `target`, or returns false where links need privileges (Windows).
function tryLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('writeJson', () => {
  it('uses a random temporary name each time and leaves no temporary file', () => {
    const file = join(dir, 'data.json');
    writeJson(file, { n: 1 });
    writeJson(file, { n: 2 });
    expect(readJson(file, null)).toEqual({ n: 2 });
    expect(readdirSync(dir)).toEqual(['data.json']);
  });

  it('refuses a file or link already at the temporary name instead of writing through it', () => {
    const file = join(dir, 'data.json');
    const temp = `${file}.${FIXED_UUID}.tmp`;
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep');
    if (!tryLink(victim, temp)) writeFileSync(temp, 'keep');

    uuid.next = FIXED_UUID;
    expect(() => writeJson(file, { n: 1 })).toThrow(/EEXIST/);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    // The name belongs to someone else, so it is left in place.
    expect(readFileSync(temp, 'utf8')).toBe('keep');
  });
});

describe('removeStaleTempFiles', () => {
  it('removes temporary files older than the limit and keeps everything else', () => {
    const old = (Date.now() - STALE_TEMP_AGE_MS - 60_000) / 1000;
    const names = {
      staleUuid: `settings.json.${FIXED_UUID}.tmp`,
      stalePid: 'index.json.1234.tmp',
      staleLater: 'chat.json.later.tmp',
      fresh: `projects.json.${FIXED_UUID.replace('0', '1')}.tmp`,
      unrelated: 'notes.tmp',
      data: 'settings.json',
    };
    for (const name of Object.values(names)) writeFileSync(join(dir, name), '{}');
    for (const name of [names.staleUuid, names.stalePid, names.staleLater, names.unrelated, names.data]) {
      utimesSync(join(dir, name), old, old);
    }
    mkdirSync(join(dir, `folder.json.${FIXED_UUID}.tmp`));

    expect(removeStaleTempFiles(dir)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual(
      [names.fresh, names.unrelated, names.data, `folder.json.${FIXED_UUID}.tmp`].sort(),
    );
  });

  it('returns 0 for a missing folder', () => {
    expect(removeStaleTempFiles(join(dir, 'missing'))).toBe(0);
  });
});

describe('readJson', () => {
  it('returns the fallback for a missing file and leaves the folder alone', () => {
    expect(readJson(join(dir, 'missing.json'), { n: 0 })).toEqual({ n: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('sets a file that is not valid JSON aside instead of leaving it to be overwritten', () => {
    const file = join(dir, 'data.json');
    writeFileSync(file, '{"settings": {"theme": "li');
    expect(readJson(file, { n: 0 })).toEqual({ n: 0 });
    expect(existsSync(file)).toBe(false);
    const [copy] = readdirSync(dir);
    expect(copy).toMatch(/^data\.json\.corrupt-\d+$/);
    expect(readFileSync(join(dir, copy!), 'utf8')).toBe('{"settings": {"theme": "li');

    writeJson(file, { n: 1 });
    expect(readdirSync(dir)).toHaveLength(2);
  });
});

describe('writeJsonLater', () => {
  it('writes the file in the background, creating its folder', async () => {
    const file = join(dir, 'nested', 'data.json');
    const done = writeJsonLater(file, { n: 1 });
    expect(existsSync(file)).toBe(false);
    await done;
    expect(readJson(file, null)).toEqual({ n: 1 });
    expect(readdirSync(join(dir, 'nested'))).toEqual(['data.json']);
  });

  it('serializes the value when called, not when the file is written', async () => {
    const file = join(dir, 'data.json');
    const value = { n: 1 };
    const done = writeJsonLater(file, value);
    value.n = 2;
    await done;
    expect(readJson(file, null)).toEqual({ n: 1 });
  });

  it('lands the newest of several writes to one file, and settles them together', async () => {
    const file = join(dir, 'data.json');
    const first = writeJsonLater(file, { n: 1 });
    const second = writeJsonLater(file, { n: 2 });
    const third = writeJsonLater(file, { n: 3 });
    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;
    expect(readJson(file, null)).toEqual({ n: 3 });
    expect(readdirSync(dir)).toEqual(['data.json']);
  });

  it('lets a synchronous write in the meantime win', async () => {
    const file = join(dir, 'data.json');
    const done = writeJsonLater(file, { from: 'later' });
    writeJson(file, { from: 'now' });
    await done;
    expect(readJson(file, null)).toEqual({ from: 'now' });

    // A later write after that is not dropped, even while the replaced one is still finishing.
    const replaced = writeJsonLater(file, { from: 'replaced' });
    writeJson(file, { from: 'now again' });
    const next = writeJsonLater(file, { from: 'next' });
    await Promise.all([replaced, next]);
    expect(readJson(file, null)).toEqual({ from: 'next' });
    expect(readdirSync(dir)).toEqual(['data.json']);
  });

  it('does not write a file whose write was cancelled', async () => {
    const file = join(dir, 'data.json');
    const done = writeJsonLater(file, { n: 1 });
    cancelJsonWrite(file);
    await done;
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a file already at its temporary name and leaves that file alone', async () => {
    const file = join(dir, 'data.json');
    const temp = `${file}.${FIXED_UUID}.tmp`;
    writeFileSync(temp, 'keep');
    uuid.next = FIXED_UUID;
    await expect(writeJsonLater(file, { n: 1 })).rejects.toThrow(/EEXIST/);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(temp, 'utf8')).toBe('keep');
  });

  it('rejects when the file cannot be written, and works again afterwards', async () => {
    // The folder of the file is a file itself.
    writeFileSync(join(dir, 'blocked'), '');
    await expect(writeJsonLater(join(dir, 'blocked', 'data.json'), { n: 1 })).rejects.toThrow();

    const file = join(dir, 'data.json');
    await writeJsonLater(file, { n: 2 });
    expect(readJson(file, null)).toEqual({ n: 2 });
  });
});

describe('flushJsonWrites', () => {
  it('settles only when every background write is on disk and its temporary file is gone', async () => {
    const one = join(dir, 'one', 'data.json');
    const two = join(dir, 'two', 'data.json');
    void writeJsonLater(one, { n: 1 });
    void writeJsonLater(two, { n: 2 });
    // The first write does not finish the second, and a write that fails does not stop the wait.
    writeFileSync(join(dir, 'blocked'), '');
    writeJsonLater(join(dir, 'blocked', 'data.json'), { n: 3 }).catch(() => {});
    expect(existsSync(one)).toBe(false);
    await flushJsonWrites();
    expect(readJson(one, null)).toEqual({ n: 1 });
    expect(readJson(two, null)).toEqual({ n: 2 });
    expect(readdirSync(join(dir, 'one'))).toEqual(['data.json']);
    expect(readdirSync(join(dir, 'two'))).toEqual(['data.json']);
  });

  it('settles at once when nothing is being written', async () => {
    await flushJsonWrites();
    expect(readdirSync(dir)).toEqual([]);
  });
});
