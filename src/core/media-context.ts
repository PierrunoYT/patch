/**
 * Capability-aware image/PDF context adapted from aider/coders/base_coder.py at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch as a contained, provider-neutral read-only context helper.
 * Licensed under the Apache License, Version 2.0.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, relative, sep } from "node:path";

import { SafePathResolver } from "../io/safe-path.js";
import type { ModelSettings } from "../models/settings.js";
import type { ChatMessage, MessageContentPart } from "./messages.js";

export const MAX_MEDIA_FILES = 4;
export const MAX_MEDIA_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 10 * 1024 * 1024;

export interface ReadOnlyMedia {
  readonly path: string;
  readonly mediaType: string;
  readonly data: string;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
};

export class MediaContextError extends Error {
  override readonly name = "MediaContextError";
}

export function mediaTypeForPath(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()];
}

function matchesMediaType(bytes: Buffer, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png":
      return (
        bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
        bytes.subarray(-8, -4).toString("ascii") === "IEND"
      );
    case "image/jpeg":
      return (
        bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) &&
        bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
      );
    case "image/webp":
      return (
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
        bytes.length >= 12 &&
        bytes.readUInt32LE(4) + 8 === bytes.length
      );
    case "application/pdf":
      return (
        bytes.subarray(0, 5).toString("ascii") === "%PDF-" &&
        bytes.subarray(Math.max(0, bytes.length - 1024)).includes("%%EOF") &&
        !bytes.includes("/Encrypt")
      );
    default:
      return false;
  }
}

export async function loadReadOnlyMedia(
  root: string,
  target: string,
  signal?: AbortSignal,
): Promise<ReadOnlyMedia> {
  signal?.throwIfAborted();
  const mediaType = mediaTypeForPath(target);
  if (mediaType === undefined) {
    throw new MediaContextError("Unsupported media type");
  }
  const resolver = await SafePathResolver.create(root);
  const absolute = await resolver.resolve(target);
  signal?.throwIfAborted();
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new MediaContextError("Media path is not a file");
    if (metadata.size === 0 || metadata.size > MAX_MEDIA_FILE_BYTES) {
      throw new MediaContextError(
        `Media file must be between 1 and ${MAX_MEDIA_FILE_BYTES} bytes`,
      );
    }
    const bytes = await handle.readFile({ signal });
    signal?.throwIfAborted();
    if (!matchesMediaType(bytes, mediaType)) {
      throw new MediaContextError("Media content does not match its file type");
    }
    return {
      path: relative(resolver.root, absolute).split(sep).join("/"),
      mediaType,
      data: bytes.toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

export function buildReadOnlyMediaMessage(
  files: readonly ReadOnlyMedia[],
  model: ModelSettings,
): ChatMessage | undefined {
  const content: MessageContentPart[] = [];
  for (const file of files) {
    if (file.mediaType.startsWith("image/") && model.capabilities.images) {
      content.push({ type: "text", text: `Image file: ${file.path}` });
      content.push({
        type: "image",
        mediaType: file.mediaType,
        data: file.data,
      });
    } else if (
      file.mediaType === "application/pdf" &&
      model.capabilities.documents
    ) {
      content.push({ type: "text", text: `PDF file: ${file.path}` });
      content.push({
        type: "document",
        mediaType: "application/pdf",
        data: file.data,
      });
    }
  }
  return content.length === 0 ? undefined : { role: "user", content };
}
