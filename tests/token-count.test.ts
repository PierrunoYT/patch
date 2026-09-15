import { describe, expect, it } from "vitest";

import {
  ModelSettingsSchema,
  conservativeMessageTokens,
  countMessageTokens,
  countTextTokens,
} from "../src/index.js";

describe("countMessageTokens", () => {
  it("uses the OpenAI model encoding for supported text-only models", () => {
    const model = ModelSettingsSchema.parse({
      name: "gpt-4o",
      provider: "openai",
      editFormat: "diff",
    });
    const messages = [{ role: "user" as const, content: "Hello 👋 世界" }];

    const result = countMessageTokens(messages, model);

    expect(result).toMatchObject({
      method: "model-tokenizer",
      tokenizer: "o200k_base",
    });
    expect(result.tokens).toBeGreaterThan(3);
  });

  it("uses a UTF-8 byte upper bound for unknown models and multimodal messages", () => {
    const model = ModelSettingsSchema.parse({
      name: "custom",
      provider: "anthropic",
      editFormat: "diff",
    });
    const messages = [{ role: "user" as const, content: "世界世界" }];

    expect(countMessageTokens(messages, model)).toEqual({
      tokens: conservativeMessageTokens(messages),
      method: "conservative",
    });
    expect(conservativeMessageTokens(messages)).toBe(
      4 + Buffer.byteLength("user\n世界世界", "utf8"),
    );

    const openAi = ModelSettingsSchema.parse({
      name: "gpt-4o",
      provider: "openai",
      editFormat: "diff",
    });
    const multimodal = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "inspect" },
          { type: "image" as const, mediaType: "image/png", data: "aW1n" },
        ],
      },
    ];
    expect(countMessageTokens(multimodal, openAi)).toEqual({
      tokens: conservativeMessageTokens(multimodal),
      method: "conservative",
    });
  });
});

describe("countTextTokens", () => {
  it("uses the selected OpenAI tokenizer for repository-map text", () => {
    const model = ModelSettingsSchema.parse({
      name: "gpt-4o",
      provider: "openai",
      editFormat: "diff",
    });

    expect(countTextTokens("Hello 👋 世界", model)).toMatchObject({
      method: "model-tokenizer",
      tokenizer: "o200k_base",
    });
  });

  it("uses the UTF-8 byte upper bound for other models", () => {
    const model = ModelSettingsSchema.parse({
      name: "claude",
      provider: "anthropic",
      editFormat: "diff",
    });

    expect(countTextTokens("A世界", model)).toEqual({
      tokens: 7,
      method: "conservative",
    });
  });
});
