import { describe, expect, it } from "vitest";

import {
  AskEditStrategy,
  buildReadOnlyMediaMessage,
  CoderSession,
  FakeProvider,
  keepPromptCacheAlive,
  ModelSettingsSchema,
} from "../src/index.js";

const model = (capabilities: Record<string, boolean> = {}) =>
  ModelSettingsSchema.parse({
    name: "fake",
    provider: "fake",
    editFormat: "ask",
    capabilities,
  });
const turn = (text: string, reason: "stop" | "length" = "stop") => ({
  actions: [
    { type: "text-delta" as const, text },
    { type: "finish" as const, reason },
  ],
});

describe("capability-aware context", () => {
  it("adds prompt-cache boundaries only when the model supports them", () => {
    const prompt = { system: [{ role: "system" as const, content: "stable" }] };
    const cached = new CoderSession({
      config: { root: "/repo", model: model({ promptCaching: true }) },
      provider: new FakeProvider([]),
      strategy: new AskEditStrategy(),
    }).prepareTurn("now", prompt);
    const plain = new CoderSession({
      config: { root: "/repo", model: model() },
      provider: new FakeProvider([]),
      strategy: new AskEditStrategy(),
    }).prepareTurn("now", prompt);
    expect(cached.request.messages[0]?.content).toEqual([
      { type: "text", text: "stable", cacheControl: { type: "ephemeral" } },
    ]);
    expect(plain.request.messages[0]?.content).toBe("stable");
  });

  it("continues truncated output with assistant prefill when supported", async () => {
    const provider = new FakeProvider([
      turn("first", "length"),
      turn(" second"),
    ]);
    const session = new CoderSession({
      config: { root: "/repo", model: model({ assistantPrefill: true }) },
      provider,
      strategy: new AskEditStrategy(),
    });
    await expect(session.runTurn("answer")).resolves.toMatchObject({
      response: "first second",
    });
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "assistant",
      content: "first",
    });
  });

  it("keeps cache warming bounded and disabled for incapable models", async () => {
    const request = {
      model: "fake",
      messages: [{ role: "user" as const, content: "cached" }],
      extraParameters: {},
    };
    const provider = new FakeProvider([turn(""), turn("")]);
    await expect(
      keepPromptCacheAlive(
        provider,
        model({ promptCaching: true }),
        request,
        2,
      ),
    ).resolves.toBe(2);
    await expect(
      keepPromptCacheAlive(provider, model(), request, 2),
    ).resolves.toBe(0);
    expect(provider.requests).toHaveLength(2);
  });

  it("stops cache warming on cancellation and surfaces provider failures", async () => {
    const request = {
      model: "fake",
      messages: [{ role: "user" as const, content: "cached" }],
      extraParameters: {},
    };
    const controller = new AbortController();
    controller.abort();
    const cancelled = new FakeProvider([]);
    await expect(
      keepPromptCacheAlive(
        cancelled,
        model({ promptCaching: true }),
        request,
        2,
        controller.signal,
      ),
    ).resolves.toBe(0);
    const failed = new FakeProvider([
      {
        actions: [
          {
            type: "error",
            kind: "provider",
            message: "warming failed",
            retryable: false,
          },
        ],
      },
    ]);
    await expect(
      keepPromptCacheAlive(failed, model({ promptCaching: true }), request, 1),
    ).rejects.toThrow("warming failed");
  });

  it("includes only media types declared by model capabilities as read-only context", () => {
    const files = [
      { path: "diagram.png", mediaType: "image/png", data: "aW1n" },
      { path: "spec.pdf", mediaType: "application/pdf", data: "cGRm" },
    ];
    expect(
      buildReadOnlyMediaMessage(files, model({ images: true }))?.content,
    ).toEqual([
      { type: "text", text: "Image file: diagram.png" },
      { type: "image", mediaType: "image/png", data: "aW1n" },
    ]);
    expect(
      buildReadOnlyMediaMessage(files, model({ documents: true }))?.content,
    ).toEqual([
      { type: "text", text: "PDF file: spec.pdf" },
      { type: "document", mediaType: "application/pdf", data: "cGRm" },
    ]);
    expect(buildReadOnlyMediaMessage(files, model())).toBeUndefined();
  });
});
