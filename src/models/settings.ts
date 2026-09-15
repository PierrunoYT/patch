import { z } from "zod";

import { EditFormatSchema } from "../edits/types.js";

export const ModelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u);

export const ModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean().default(true),
    systemRole: z.boolean().default(true),
    tools: z.boolean().default(false),
    images: z.boolean().default(false),
    documents: z.boolean().default(false),
    promptCaching: z.boolean().default(false),
    assistantPrefill: z.boolean().default(false),
    reasoningEffort: z.boolean().default(false),
    thinkingTokens: z.boolean().default(false),
  })
  .strict();

export const ModelSettingsSchema = z
  .object({
    name: ModelIdentifierSchema,
    provider: ModelIdentifierSchema,
    editFormat: EditFormatSchema,
    editorEditFormat: EditFormatSchema.optional(),
    weakModel: ModelIdentifierSchema.optional(),
    editorModel: ModelIdentifierSchema.optional(),
    useRepoMap: z.boolean().default(false),
    examplesAsSystem: z.boolean().default(false),
    reminderRole: z.enum(["system", "user"]).default("user"),
    /**
     * Tag a model wraps its reasoning in inside the ordinary content stream, such
     * as `think`. Providers that deliver reasoning as its own stream do not set
     * one.
     */
    reasoningTag: z.string().min(1).optional(),
    /** History budget before completed messages are summarized. */
    maxChatHistoryTokens: z.number().int().positive().default(1024),
    /**
     * `false` sends no temperature, for models that reject it; `true` sends 0,
     * the deterministic default; a number sends that value.
     */
    useTemperature: z
      .union([z.boolean(), z.number().min(0).max(2)])
      .default(true),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    thinkingTokens: z.number().int().min(1024).max(1_000_000).optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    /**
     * Price of an input token served from the provider's cache. Absent means
     * the provider does not discount a cache hit, so the ordinary input price
     * applies.
     */
    cachedInputCostPerMillion: z.number().nonnegative().optional(),
    /**
     * Price of an input token written into the provider's cache, which some
     * providers charge at a premium over an ordinary input token. Absent means
     * the ordinary input price applies.
     */
    cacheWriteCostPerMillion: z.number().nonnegative().optional(),
    capabilities: ModelCapabilitiesSchema.prefault({}),
    extraParameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((model, context) => {
    if (
      model.reasoningEffort !== undefined &&
      !model.capabilities.reasoningEffort
    )
      context.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: "model does not declare reasoning-effort support",
      });
    if (
      model.thinkingTokens !== undefined &&
      !model.capabilities.thinkingTokens
    )
      context.addIssue({
        code: "custom",
        path: ["thinkingTokens"],
        message: "model does not declare thinking-token support",
      });
    if (model.reasoningEffort !== undefined && model.provider !== "openai")
      context.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: "reasoning effort is supported only by the OpenAI adapter",
      });
    if (model.thinkingTokens !== undefined && model.provider !== "anthropic")
      context.addIssue({
        code: "custom",
        path: ["thinkingTokens"],
        message: "thinking tokens are supported only by the Anthropic adapter",
      });
    if (
      model.thinkingTokens !== undefined &&
      model.maxOutputTokens !== undefined &&
      model.thinkingTokens >= model.maxOutputTokens
    )
      context.addIssue({
        code: "custom",
        path: ["thinkingTokens"],
        message: "thinking-token budget must be below maxOutputTokens",
      });
  });

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

/** The temperature a request should carry, or `undefined` to send none. */
export function requestTemperature(model: ModelSettings): number | undefined {
  if (model.reasoningEffort !== undefined || model.thinkingTokens !== undefined)
    return undefined;
  if (model.useTemperature === false) return undefined;
  return model.useTemperature === true ? 0 : model.useTemperature;
}

export function withReasoningControls(
  model: ModelSettings,
  controls: {
    readonly reasoningEffort?: "low" | "medium" | "high" | null | undefined;
    readonly thinkingTokens?: number | null | undefined;
  },
): ModelSettings {
  return ModelSettingsSchema.parse({
    ...model,
    reasoningEffort:
      controls.reasoningEffort === null
        ? undefined
        : (controls.reasoningEffort ?? model.reasoningEffort),
    thinkingTokens:
      controls.thinkingTokens === null
        ? undefined
        : (controls.thinkingTokens ?? model.thinkingTokens),
  });
}
