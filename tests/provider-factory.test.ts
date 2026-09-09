import { describe, expect, it } from "vitest";

import {
  AnthropicProvider,
  ModelSettingsSchema,
  OpenAIProvider,
  ProviderConfigurationError,
  UnsupportedProviderError,
  createProvider,
} from "../src/index.js";

const model = (provider: string) =>
  ModelSettingsSchema.parse({
    name: `${provider}/model`,
    provider,
    editFormat: "diff",
  });

describe("createProvider", () => {
  it("constructs only documented provider adapters", () => {
    expect(createProvider(model("openai"), { apiKey: "key" })).toBeInstanceOf(
      OpenAIProvider,
    );
    expect(
      createProvider(model("anthropic"), { apiKey: "key" }),
    ).toBeInstanceOf(AnthropicProvider);
    expect(createProvider(model("deepseek"), { apiKey: "key" })).toBeInstanceOf(
      OpenAIProvider,
    );
  });

  it("rejects unsupported providers and missing credentials before I/O", () => {
    expect(() => createProvider(model("other"), { apiKey: "key" })).toThrow(
      UnsupportedProviderError,
    );
    expect(() => createProvider(model("openai"))).toThrow(
      ProviderConfigurationError,
    );
  });
});
