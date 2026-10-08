import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { ToolError } from './types';

// Fingerprint of a file's bytes (text is hashed as UTF-8, which is how the file tools write it).
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export const MAX_READ_BYTES = 512 * 1024;

// Validate the complete byte buffer before decoding; replacement decoding would silently lose original bytes.
export function requireUtf8ForEdit(bytes: Buffer, path: string): Buffer {
  if (!isUtf8(bytes)) throw new ToolError(`${path} is not UTF-8; editing it would rewrite other bytes.`);
  return bytes;
}

// A file is treated as binary if its first 8 KB contain a NUL byte.
export async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

// "cat -n" style numbering so the model can refer to lines.
export function withLineNumbers(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(firstLine + index).padStart(width, ' ')}\t${line}`).join('\n');
}

export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
