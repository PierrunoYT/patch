import { describe, expect, it } from "vitest";

import { ModelSettingsSchema, reportUsage } from "../src/index.js";

describe("reportUsage", () => {
  it("estimates catalog cost independently from asymmetric token counts", () => {
    const model = ModelSettingsSchema.parse({
      name: "priced",
      provider: "openai",
      editFormat: "diff",
      inputCostPerMillion: 2,
      outputCostPerMillion: 6,
    });

    expect(
      reportUsage(model, { inputTokens: 2_000_000, outputTokens: 500_000 }),
    ).toEqual({
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      cost: 7,
      costSource: "catalog",
    });
  });

  it("labels missing pricing and honors provider-reported cost", () => {
    const model = ModelSettingsSchema.parse({
      name: "unknown-price",
      provider: "anthropic",
      editFormat: "diff",
    });

    expect(reportUsage(model, { inputTokens: 10, outputTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cost: null,
      costSource: "unknown",
    });
    expect(
      reportUsage(model, { inputTokens: 10, outputTokens: 2, cost: 0.004 }),
    ).toMatchObject({ cost: 0.004, costSource: "provider" });
  });
});
