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

  it("labels unknown and multimodal token counts as conservative", () => {
    const model = ModelSettingsSchema.parse({
      name: "custom",
      provider: "anthropic",
      editFormat: "diff",
    });
    const messages = [{ role: "user" as const, content: "12345678" }];

    expect(countMessageTokens(messages, model)).toEqual({
      tokens: conservativeMessageTokens(messages),
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

  it("uses the conservative text estimate for other models", () => {
    const model = ModelSettingsSchema.parse({
      name: "claude",
      provider: "anthropic",
      editFormat: "diff",
    });

    expect(countTextTokens("12345678", model)).toEqual({
      tokens: 2,
      method: "conservative",
    });
  });
});
