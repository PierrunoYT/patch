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
  z
    .object({
      type: z.literal("add"),
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({ type: z.literal("drop"), paths: z.array(z.string().min(1)) })
    .strict(),
  z
    .object({
      type: z.literal("read-only"),
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ type: z.literal("ls") }).strict(),
  z.object({ type: z.literal("clear") }).strict(),
  z.object({ type: z.literal("model"), model: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("chat-mode"),
      mode: z.union([EditFormatSchema, z.literal("code")]),
    })
    .strict(),
  z
    .object({
      type: z.literal("run"),
      command: z.string().min(1),
      /** Set by `/run --interactive`; never inferred from the environment. */
      interactive: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("web"), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal("test") }).strict(),
  z.object({ type: z.literal("lint") }).strict(),
  z
    .object({
      type: z.literal("commit"),
      message: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ type: z.literal("undo") }).strict(),
  z.object({ type: z.literal("clipboard-copy") }).strict(),
  z.object({ type: z.literal("clipboard-paste") }).strict(),
]);

export type SessionConfigPatch = z.infer<typeof SessionConfigPatchSchema>;
export type CommandEffect = z.infer<typeof CommandEffectSchema>;
