import { z } from "zod";

import type { ModelSettings } from "./settings.js";

export const UsageReportSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().nullable(),
    costSource: z.enum(["provider", "catalog", "unknown"]),
  })
  .strict();

export interface UsageInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
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
    cost:
      (usage.inputTokens * model.inputCostPerMillion +
        usage.outputTokens * model.outputCostPerMillion) /
      1_000_000,
    costSource: "catalog",
  });
}
