import { z } from "zod";

import { EditFormatSchema } from "../edits/types.js";

export const SessionConfigPatchSchema = z
  .object({
    model: z.string().min(1).optional(),
    editFormat: EditFormatSchema.optional(),
    streaming: z.boolean().optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "A config patch cannot be empty",
  );

export const CommandEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("submit"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("switch"),
      config: SessionConfigPatchSchema,
      placeholder: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("exit"),
      code: z.number().int().min(0).max(255),
    })
    .strict(),
]);

export type SessionConfigPatch = z.infer<typeof SessionConfigPatchSchema>;
export type CommandEffect = z.infer<typeof CommandEffectSchema>;
