import { z } from "zod";

import { EditFormatSchema } from "../edits/types.js";

export const ModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean().default(true),
    systemRole: z.boolean().default(true),
    tools: z.boolean().default(false),
    images: z.boolean().default(false),
    documents: z.boolean().default(false),
    promptCaching: z.boolean().default(false),
    assistantPrefill: z.boolean().default(false),
  })
  .strict();

export const ModelSettingsSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    editFormat: EditFormatSchema,
    editorEditFormat: EditFormatSchema.optional(),
    weakModel: z.string().min(1).optional(),
    editorModel: z.string().min(1).optional(),
    useRepoMap: z.boolean().default(false),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    capabilities: ModelCapabilitiesSchema.prefault({}),
    extraParameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
