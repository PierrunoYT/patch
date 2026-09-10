import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { EOL } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { isMissingPathError, SafePathResolver } from "./safe-path.js";

export const TextEncodingSchema = z.enum(["utf-8", "utf-16le", "latin1"]);
export const LineEndingSchema = z.enum(["lf", "crlf"]);
export const LineEndingPolicySchema = z.enum(["preserve", "lf", "crlf"]);

export const FileSystemOptionsSchema = z
  .object({
    encoding: TextEncodingSchema.default("utf-8"),
    lineEndings: LineEndingPolicySchema.default("preserve"),
  })
  .strict();

export const WriteTextOptionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
  })
  .strict();

export type TextEncoding = z.infer<typeof TextEncodingSchema>;
export type LineEnding = z.infer<typeof LineEndingSchema>;
export type LineEndingPolicy = z.infer<typeof LineEndingPolicySchema>;
export type FileSystemOptions = z.infer<typeof FileSystemOptionsSchema>;
export type WriteTextOptions = z.infer<typeof WriteTextOptionsSchema>;

export interface TextFile {
  path: string;
  content: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  byteOrderMark: boolean;
}

export interface WriteTextResult {
  path: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  bytesWritten: number;
  dryRun: boolean;
}

export interface DeleteFileResult {
  path: string;
  dryRun: boolean;
}

interface PreparedWrite {
  bytes: Buffer;
  lineEnding: LineEnding;
  existing: boolean;
  identity?: FileIdentity;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly links: number;
  readonly size: number;
  readonly modified: number;
  readonly changed: number;
}

export class TextDecodingError extends Error {
  override readonly name = "TextDecodingError";
  readonly path: string;
  readonly encoding: TextEncoding;

  constructor(path: string, encoding: TextEncoding, cause: unknown) {
    super(`Unable to decode ${path} as ${encoding}`, { cause });
    this.path = path;
    this.encoding = encoding;
  }
}

export class TextEncodingError extends Error {
  override readonly name = "TextEncodingError";
  readonly encoding: TextEncoding;

  constructor(encoding: TextEncoding) {
    super(`Content cannot be represented as ${encoding}`);
    this.encoding = encoding;
  }
}

export class PathChangedDuringWriteError extends Error {
  override readonly name = "PathChangedDuringWriteError";

  constructor(target: string) {
    super(`Path changed while preparing an atomic write: ${target}`);
  }
}

export class UnsafeFileMetadataError extends Error {
  override readonly name = "UnsafeFileMetadataError";
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Refusing to mutate ${path}: ${reason}`);
    this.path = path;
  }
}

function fileIdentity(information: Stats): FileIdentity {
  return {
    device: information.dev,
    inode: information.ino,
    mode: information.mode,
    links: information.nlink,
    size: information.size,
    modified: information.mtimeMs,
    changed: information.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

function validateMutationTarget(path: string, information: Stats): void {
  if (!information.isFile()) {
    throw new UnsafeFileMetadataError(path, "the target is not a regular file");
  }
  if (information.nlink !== 1) {
    throw new UnsafeFileMetadataError(
      path,
      `the target has ${String(information.nlink)} hard links`,
    );
  }
}

function defaultLineEnding(): LineEnding {
  return EOL === "\r\n" ? "crlf" : "lf";
}

function hasByteOrderMark(bytes: Buffer, encoding: TextEncoding): boolean {
  if (encoding === "utf-8") {
    return bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  }
  if (encoding === "utf-16le") {
    return bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]));
  }
  return false;
}

function decode(bytes: Buffer, path: string, encoding: TextEncoding): string {
  try {
    if (encoding === "latin1") {
      return bytes.toString("latin1");
    }

    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TextDecodingError(path, encoding, error);
  }
}

function encode(
  content: string,
  encoding: TextEncoding,
  byteOrderMark: boolean,
): Buffer {
  const bufferEncoding =
    encoding === "utf-8"
      ? "utf8"
      : encoding === "utf-16le"
        ? "utf16le"
        : encoding;
  const encoded = Buffer.from(content, bufferEncoding);
  if (decode(encoded, "generated content", encoding) !== content) {
    throw new TextEncodingError(encoding);
  }

  if (!byteOrderMark || encoding === "latin1") {
    return encoded;
  }

  const mark =
    encoding === "utf-8"
      ? Buffer.from([0xef, 0xbb, 0xbf])
      : Buffer.from([0xff, 0xfe]);
  return Buffer.concat([mark, encoded]);
}

function detectLineEnding(content: string): LineEnding | undefined {
  const firstNewline = /\r\n|\r|\n/.exec(content)?.[0];
  if (firstNewline === undefined) {
    return undefined;
  }
  return firstNewline === "\r\n" ? "crlf" : "lf";
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n|\r|\n/g, "\n");
}

function applyLineEnding(content: string, lineEnding: LineEnding): string {
  const normalized = normalizeLineEndings(content);
  return lineEnding === "crlf"
    ? normalized.replaceAll("\n", "\r\n")
    : normalized;
}

export class FileSystemAdapter {
  readonly root: string;
  readonly encoding: TextEncoding;
  readonly lineEndings: LineEndingPolicy;
  readonly #paths: SafePathResolver;

  private constructor(paths: SafePathResolver, options: FileSystemOptions) {
    this.#paths = paths;
    this.root = paths.root;
    this.encoding = options.encoding;
    this.lineEndings = options.lineEndings;
  }

  static async create(
    root: string,
    options: unknown = {},
  ): Promise<FileSystemAdapter> {
    return new FileSystemAdapter(
      await SafePathResolver.create(root),
      FileSystemOptionsSchema.parse(options),
    );
  }

  async readText(target: string): Promise<TextFile> {
    const path = await this.#paths.resolve(target);
    const bytes = await readFile(path);
    const byteOrderMark = hasByteOrderMark(bytes, this.encoding);
    const decoded = decode(bytes, path, this.encoding);

    return {
      path,
      content: normalizeLineEndings(decoded),
      encoding: this.encoding,
      lineEnding: detectLineEnding(decoded) ?? defaultLineEnding(),
      byteOrderMark,
    };
  }

  async writeText(
    target: string,
    content: string,
    options: unknown = {},
  ): Promise<WriteTextResult> {
    const { dryRun } = WriteTextOptionsSchema.parse(options);
    const initialPath = await this.#paths.resolve(target);
    const preview = await this.#prepareWrite(initialPath, content);

    if (dryRun) {
      return {
        path: initialPath,
        encoding: this.encoding,
        lineEnding: preview.lineEnding,
        bytesWritten: preview.bytes.length,
        dryRun: true,
      };
    }

    const parent = dirname(initialPath);
    await this.#paths.resolve(parent);
    await mkdir(parent, { recursive: true });

    const path = await this.#paths.resolve(target);
    if (path !== initialPath) {
      throw new PathChangedDuringWriteError(target);
    }

    const prepared = await this.#prepareWrite(path, content);
    const mode =
      prepared.identity === undefined ? 0o666 : prepared.identity.mode & 0o777;
    const temporaryPath = await this.#paths.resolve(
      join(parent, `.${basename(path)}.patch-${randomUUID()}.tmp`),
    );

    try {
      const handle = await open(temporaryPath, "wx", mode);
      try {
        await handle.writeFile(prepared.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.#assertStableTarget(target, path, prepared.identity);
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return {
      path,
      encoding: this.encoding,
      lineEnding: prepared.lineEnding,
      bytesWritten: prepared.bytes.length,
      dryRun: false,
    };
  }

  async deleteFile(
    target: string,
    options: unknown = {},
  ): Promise<DeleteFileResult> {
    const { dryRun } = WriteTextOptionsSchema.parse(options);
    const initialPath = await this.#paths.resolve(target);
    const information = await stat(initialPath);
    validateMutationTarget(target, information);
    const identity = fileIdentity(information);
    if (!dryRun) {
      const path = await this.#paths.resolve(target);
      if (path !== initialPath) {
        throw new PathChangedDuringWriteError(target);
      }
      await this.#assertStableTarget(target, path, identity);
      await unlink(path);
    }
    return { path: initialPath, dryRun };
  }

  async #prepareWrite(path: string, content: string): Promise<PreparedWrite> {
    const existing = await this.#readExisting(path);
    const lineEnding =
      this.lineEndings === "preserve"
        ? (existing?.lineEnding ?? defaultLineEnding())
        : this.lineEndings;
    return {
      bytes: encode(
        applyLineEnding(content, lineEnding),
        this.encoding,
        existing?.byteOrderMark ?? false,
      ),
      lineEnding,
      existing: existing !== undefined,
      ...(existing === undefined ? {} : { identity: existing.identity }),
    };
  }

  async #readExisting(
    path: string,
  ): Promise<(TextFile & { readonly identity: FileIdentity }) | undefined> {
    try {
      const before = await stat(path);
      validateMutationTarget(path, before);
      const bytes = await readFile(path);
      const after = await stat(path);
      const identity = fileIdentity(before);
      if (!sameIdentity(identity, fileIdentity(after))) {
        throw new PathChangedDuringWriteError(path);
      }
      const decoded = decode(bytes, path, this.encoding);
      return {
        path,
        content: normalizeLineEndings(decoded),
        encoding: this.encoding,
        lineEnding: detectLineEnding(decoded) ?? defaultLineEnding(),
        byteOrderMark: hasByteOrderMark(bytes, this.encoding),
        identity,
      };
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async #assertStableTarget(
    target: string,
    path: string,
    expected: FileIdentity | undefined,
  ): Promise<void> {
    if ((await this.#paths.resolve(target)) !== path) {
      throw new PathChangedDuringWriteError(target);
    }
    try {
      const information = await stat(path);
      validateMutationTarget(target, information);
      if (
        expected === undefined ||
        !sameIdentity(expected, fileIdentity(information))
      ) {
        throw new PathChangedDuringWriteError(target);
      }
    } catch (error) {
      if (isMissingPathError(error) && expected === undefined) return;
      throw error;
    }
  }
}
