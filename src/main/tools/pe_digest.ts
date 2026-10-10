import { createHash } from 'node:crypto';

// A SHA-256 of a Windows executable that code signing does not change (#149). Signing writes the header checksum and
// the certificate table entry, and appends the certificate (padded to 8 bytes), so those are left out, as Authenticode's
// own image hash leaves them out. A digest taken when the helper is built therefore still matches it after a release
// build signs it. Returns null for a file that is not a PE image.
export function peDigest(bytes: Buffer): string | null {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) return null;
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const checksum = optional + 64;
  // The certificate table is data directory 4; the directories start after 96 (PE32) or 112 (PE32+) bytes.
  const certificateEntry = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  if (certificateEntry + 8 > bytes.length) return null;
  const certificateOffset = bytes.readUInt32LE(certificateEntry);
  const certificateSize = bytes.readUInt32LE(certificateEntry + 4);
  let end = bytes.length;
  if (certificateSize > 0) {
    if (certificateOffset < certificateEntry + 8 || certificateOffset > bytes.length) return null;
    end = certificateOffset;
  }
  // Signing pads the image with zeros to a multiple of 8 before the certificate. Trailing zeros are left out whether or
  // not they are padding, so the digest is the same either way; zeros after the last section never run.
  while (end > certificateEntry + 8 && bytes[end - 1] === 0) end--;
  return createHash('sha256')
    .update(bytes.subarray(0, checksum))
    .update(bytes.subarray(checksum + 4, certificateEntry))
    .update(bytes.subarray(certificateEntry + 8, end))
    .digest('hex');
}
