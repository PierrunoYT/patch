import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { peDigest } from './pe_digest';

const PE = 0x80;
const OPTIONAL = PE + 24;
const CERTIFICATE_ENTRY = OPTIONAL + 112 + 4 * 8;

// A minimal PE32+ image: DOS header, PE signature, optional header with its data directories, then code bytes.
function image(code: Buffer): Buffer {
  const header = Buffer.alloc(OPTIONAL + 112 + 16 * 8);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(PE, 0x3c);
  header.writeUInt32LE(0x00004550, PE);
  header.writeUInt16LE(0x20b, OPTIONAL);
  return Buffer.concat([header, code]);
}

// What signing does to it: a new checksum, zero padding to 8 bytes, and a certificate table appended and recorded.
function sign(unsigned: Buffer): Buffer {
  const optional = unsigned.readUInt32LE(0x3c) + 24;
  const entry = optional + (unsigned.readUInt16LE(optional) === 0x20b ? 112 : 96) + 4 * 8;
  const padded = Buffer.concat([unsigned, Buffer.alloc((8 - (unsigned.length % 8)) % 8)]);
  const certificate = randomBytes(1000);
  const signed = Buffer.concat([padded, certificate]);
  signed.writeUInt32LE(0x1234abcd, optional + 64);
  signed.writeUInt32LE(padded.length, entry);
  signed.writeUInt32LE(certificate.length, entry + 4);
  return signed;
}

describe('peDigest', () => {
  it('stays the same when the image is signed', () => {
    // An odd length, so signing has to pad.
    const unsigned = image(randomBytes(4093));
    expect(peDigest(sign(unsigned))).toBe(peDigest(unsigned));
  });

  it('changes when a code byte changes, signed or not', () => {
    const unsigned = image(randomBytes(4096));
    const changed = Buffer.from(unsigned);
    changed.writeUInt8(changed.readUInt8(changed.length - 10) ^ 0xff, changed.length - 10);
    expect(peDigest(changed)).not.toBe(peDigest(unsigned));
    expect(peDigest(sign(changed))).not.toBe(peDigest(unsigned));
  });

  it('refuses what is not a PE image, or a certificate entry pointing outside it', () => {
    expect(peDigest(Buffer.from('#!/bin/sh\necho hi\n'))).toBeNull();
    const broken = image(randomBytes(64));
    broken.writeUInt32LE(broken.length + 100, CERTIFICATE_ENTRY);
    broken.writeUInt32LE(10, CERTIFICATE_ENTRY + 4);
    expect(peDigest(broken)).toBeNull();
  });

  const helper = join(__dirname, '../../../native/sandbox-helper/target/release/sandbox-helper.exe');
  it.skipIf(!existsSync(helper))('digests the real Windows helper', () => {
    const bytes = readFileSync(helper);
    expect(peDigest(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(peDigest(sign(bytes))).toBe(peDigest(bytes));
  });
});
