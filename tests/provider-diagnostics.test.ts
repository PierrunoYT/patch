import { describe, expect, it } from "vitest";

import {
  ModelSettingsSchema,
  ProviderConfigurationError,
  assertProviderReady,
  diagnoseProvider,
} from "../src/index.js";

describe("provider diagnostics", () => {
  it("names a missing provider credential without exposing values", () => {
    const model = ModelSettingsSchema.parse({
      name: "gpt-test",
      provider: "openai",
      editFormat: "diff",
    });
    const secret = "do-not-print-this-key";
    const result = diagnoseProvider(model, {
      environment: { OTHER_KEY: secret },
    });

    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "missing-credential",
          environmentVariable: "OPENAI_API_KEY",
          message: "Provider openai requires OPENAI_API_KEY",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("distinguishes model and adapter capability failures", () => {
    const model = ModelSettingsSchema.parse({
      name: "openai-custom",
      provider: "openai",
      editFormat: "diff",
      capabilities: { streaming: true, documents: true, tools: false },
    });
    const result = diagnoseProvider(model, {
      credentialPresent: true,
      require: { documents: true, tools: true },
    });

    expect(result.diagnostics).toEqual([
      {
        code: "provider-capability",
        capability: "documents",
        message: "Provider adapter openai does not support documents",
      },
      {
        code: "model-capability",
        capability: "tools",
        message: "Model openai-custom does not declare tools support",
      },
    ]);
  });

  it("accepts explicit credentials and throws structured preflight failures", () => {
    const model = ModelSettingsSchema.parse({
      name: "claude-test",
      provider: "anthropic",
      editFormat: "diff",
      capabilities: { streaming: true, promptCaching: true },
    });

    expect(() =>
      assertProviderReady(model, {
        credentialPresent: true,
        require: { streaming: true, promptCaching: true },
      }),
    ).not.toThrow();
    expect(() => assertProviderReady(model)).toThrow(
      ProviderConfigurationError,
    );
  });
});
