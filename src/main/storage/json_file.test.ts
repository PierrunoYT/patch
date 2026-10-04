import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cancelJsonWrite, readJson, writeJson, writeJsonLater } from './json_file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-json-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

  it('rejects when the file cannot be written, and works again afterwards', async () => {
    // The folder of the file is a file itself.
    writeFileSync(join(dir, 'blocked'), '');
    await expect(writeJsonLater(join(dir, 'blocked', 'data.json'), { n: 1 })).rejects.toThrow();

    const file = join(dir, 'data.json');
    await writeJsonLater(file, { n: 2 });
    expect(readJson(file, null)).toEqual({ n: 2 });
  });
});
