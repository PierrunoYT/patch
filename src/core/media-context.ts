/** Capability-aware image/PDF context adapted from aider/coders/base_coder.py. */

import type { ModelSettings } from "../models/settings.js";
import type { ChatMessage, MessageContentPart } from "./messages.js";

export interface ReadOnlyMedia {
  readonly path: string;
  readonly mediaType: string;
  readonly data: string;
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
