import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trustedHelper } from './native_integrity';
import { peDigest } from './pe_digest';

function image(code: Buffer): Buffer {
  const header = Buffer.alloc(0x98 + 112 + 16 * 8);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(0x80, 0x3c);
  header.writeUInt32LE(0x00004550, 0x80);
  header.writeUInt16LE(0x20b, 0x98);
  return Buffer.concat([header, code]);
}

describe('trustedHelper', () => {
  let dir: string;
  let helper: string;
  let bytes: Buffer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-integrity-'));
    helper = join(dir, 'sandbox-helper.exe');
    bytes = image(randomBytes(2048));
    writeFileSync(helper, bytes);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts the helper the app was built with', () => {
    expect(trustedHelper(helper, { 'sandbox-helper.exe': peDigest(bytes)! })).toBe(true);
  });

  it('refuses a replaced helper, and notices a replacement after an earlier check', () => {
    const digests = { 'sandbox-helper.exe': peDigest(bytes)! };
    expect(trustedHelper(helper, digests)).toBe(true);
    writeFileSync(helper, image(randomBytes(4096)));
    expect(trustedHelper(helper, digests)).toBe(false);
  });

  it('refuses a helper with no digest from the build, and a missing one', () => {
    expect(trustedHelper(helper, {})).toBe(false);
    expect(trustedHelper(join(dir, 'file-helper.exe'), { 'file-helper.exe': peDigest(bytes)! })).toBe(false);
  });
});
