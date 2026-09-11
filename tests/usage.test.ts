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

  it("prices cache reads and cache writes apart from ordinary input", () => {
    const model = ModelSettingsSchema.parse({
      name: "cached",
      provider: "anthropic",
      editFormat: "diff",
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      cachedInputCostPerMillion: 0.3,
      cacheWriteCostPerMillion: 3.75,
    });
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 600_000,
      cacheWriteTokens: 200_000,
    };

    // 200k uncached at 3, 600k cached at 0.30, 200k written at 3.75.
    expect(reportUsage(model, usage)).toMatchObject({
      cost: 0.6 + 0.18 + 0.75,
      costSource: "catalog",
      cachedInputTokens: 600_000,
      cacheWriteTokens: 200_000,
    });
    // The whole point of the discount: the same request costs less when more
    // of it is served from the cache.
    expect(
      reportUsage(model, {
        ...usage,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }).cost,
    ).toBe(3);
  });

  it("charges the input price when a model prices no cache", () => {
    const model = ModelSettingsSchema.parse({
      name: "flat",
      provider: "openai",
      editFormat: "diff",
      inputCostPerMillion: 2,
      outputCostPerMillion: 6,
    });

    // Cached tokens are a subset of the input count, so an unpriced cache must
    // leave the total exactly where it was rather than dropping those tokens.
    expect(
      reportUsage(model, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 400_000,
      }).cost,
    ).toBe(2);
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
