import { z } from "zod";

import type { ModelSettings } from "./settings.js";

/**
 * `inputTokens` is every input token the request is billed for, with
 * `cachedInputTokens` and `cacheWriteTokens` naming the subsets that are priced
 * differently. Providers do not agree on this shape — OpenAI's `prompt_tokens`
 * already includes its cached tokens while Anthropic reports cache reads and
 * cache writes beside a prompt count that excludes both — so each adapter
 * normalizes to this contract rather than each consumer guessing.
 */
export const UsageReportSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().nullable(),
    costSource: z.enum(["provider", "catalog", "unknown"]),
  })
  .strict();

export interface UsageInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly cost?: number | undefined;
}

export type UsageReport = z.infer<typeof UsageReportSchema>;

export function reportUsage(
  model: ModelSettings,
  usage: UsageInput,
): UsageReport {
  const tokens = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
  };
  if (usage.cost !== undefined) {
    return UsageReportSchema.parse({
      ...tokens,
      cost: usage.cost,
      costSource: "provider",
    });
  }
  if (
    model.inputCostPerMillion === undefined ||
    model.outputCostPerMillion === undefined
  ) {
    return UsageReportSchema.parse({
      ...tokens,
      cost: null,
      costSource: "unknown",
    });
  }
  return UsageReportSchema.parse({
    ...tokens,
    cost: catalogCost(model, usage),
    costSource: "catalog",
  });
}

/**
 * Cost from the catalog's prices. Cache reads are usually much cheaper than an
 * ordinary input token and cache writes usually cost more, so a model that
 * prices them separately must not be charged the flat input price for tokens it
 * served from, or wrote to, its cache. A model that prices neither falls back to
 * the input price, which leaves the total unchanged.
 */
function catalogCost(model: ModelSettings, usage: UsageInput): number {
  const inputCost = model.inputCostPerMillion ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const written = Math.min(
    usage.cacheWriteTokens ?? 0,
    usage.inputTokens - cached,
  );
  const uncached = usage.inputTokens - cached - written;
  return (
    (uncached * inputCost +
      cached * (model.cachedInputCostPerMillion ?? inputCost) +
      written * (model.cacheWriteCostPerMillion ?? inputCost) +
      usage.outputTokens * (model.outputCostPerMillion ?? 0)) /
    1_000_000
  );
}
