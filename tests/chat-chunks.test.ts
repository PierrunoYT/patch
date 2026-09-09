import { describe, expect, it } from "vitest";

import { ChatChunks } from "../src/index.js";

describe("ChatChunks", () => {
  it("validates roles and emits chunks in upstream order", () => {
    const chunks = new ChatChunks({
      system: [{ role: "system", content: "system" }],
      examples: [{ role: "assistant", content: "examples" }],
      done: [{ role: "assistant", content: "done" }],
      repo: [{ role: "user", content: "repo" }],
      readonlyFiles: [{ role: "user", content: "readonly" }],
      chatFiles: [{ role: "user", content: "editable" }],
      current: [{ role: "tool", toolCallId: "call-1", content: "result" }],
      reminder: [{ role: "system", content: "reminder" }],
    });

    expect(chunks.allMessages().map((message) => message.content)).toEqual([
      "system",
      "examples",
      "readonly",
      "repo",
      "done",
      "editable",
      "result",
      "reminder",
    ]);
  });

  it("defaults omitted chunks to empty and rejects malformed messages", () => {
    expect(
      new ChatChunks({
        current: [{ role: "user", content: "only message" }],
      }).allMessages(),
    ).toEqual([{ role: "user", content: "only message" }]);

    expect(
      () =>
        new ChatChunks({ current: [{ role: "tool", content: "missing id" }] }),
    ).toThrow();
    expect(() => new ChatChunks({ unexpected: [] })).toThrow();
  });

  it("adds fallback cache boundaries without mutating the original chunks", () => {
    const chunks = new ChatChunks({
      system: [{ role: "system", content: "system" }],
      readonlyFiles: [{ role: "user", content: "readonly" }],
      current: [{ role: "user", content: "current" }],
      reminder: [{ role: "system", content: "reminder" }],
    });

    const cached = chunks.withCacheControl();
    const emitted = chunks.allMessages();
    emitted[0]!.content = "mutated copy";

    expect(chunks.allMessages().map((message) => message.content)).toEqual([
      "system",
      "readonly",
      "current",
      "reminder",
    ]);
    expect(cached.allMessages()).toEqual([
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "system",
            cacheControl: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "readonly",
            cacheControl: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: "current" },
      { role: "system", content: "reminder" },
    ]);
    expect(cached.cacheableMessages()).toHaveLength(2);
  });

  it("marks the final text part while preserving rich content", () => {
    const chunks = new ChatChunks({
      chatFiles: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
            { type: "text", text: "file context" },
          ],
        },
      ],
    });

    expect(chunks.withCacheControl().chatFiles).toEqual([
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
          {
            type: "text",
            text: "file context",
            cacheControl: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  it("returns all messages when no cache boundary exists", () => {
    const chunks = new ChatChunks({
      current: [{ role: "user", content: "not cache marked" }],
    });

    expect(chunks.withCacheControl().cacheableMessages()).toEqual([
      { role: "user", content: "not cache marked" },
    ]);
  });
});
