import { z } from "zod";

import { EditSchema } from "../edits/types.js";
import { ModelSettingsSchema } from "../models/settings.js";
import { ChatMessageSchema } from "./messages.js";

function findDuplicate(paths: string[]): string | undefined {
  const seen = new Set<string>();
  return paths.find((path) => {
    if (seen.has(path)) {
      return true;
    }
    seen.add(path);
    return false;
  });
}

export const SessionPhaseSchema = z.enum([
  "waiting",
  "composing",
  "streaming",
  "reviewing",
  "applying",
  "linting",
  "testing",
  "interrupted",
  "closed",
]);

export const SessionConfigSchema = z
  .object({
    root: z.string().min(1),
    model: ModelSettingsSchema,
    streaming: z.boolean().default(true),
    autoCommit: z.boolean().default(true),
    autoLint: z.boolean().default(true),
    autoTest: z.boolean().default(false),
    maxReflections: z.number().int().nonnegative().default(3),
  })
  .strict();

export const SessionStateSchema = z
  .object({
    config: SessionConfigSchema,
    phase: SessionPhaseSchema,
    messages: z.array(ChatMessageSchema),
    editablePaths: z.array(z.string().min(1)),
    readOnlyPaths: z.array(z.string().min(1)),
    pendingEdits: z.array(EditSchema),
    partialResponse: z.string(),
    reflectionCount: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
    lastPatchCommit: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    for (const key of ["editablePaths", "readOnlyPaths"] as const) {
      const duplicate = findDuplicate(state[key]);
      if (duplicate !== undefined) {
        context.addIssue({
          code: "custom",
          message: `A file list cannot contain duplicate paths: ${duplicate}`,
          path: [key],
        });
      }
    }

    const editable = new Set(state.editablePaths);
    const overlap = state.readOnlyPaths.find((path) => editable.has(path));
    if (overlap !== undefined) {
      context.addIssue({
        code: "custom",
        message: `A path cannot be both editable and read-only: ${overlap}`,
        path: ["readOnlyPaths"],
      });
    }

    if (state.reflectionCount > state.config.maxReflections) {
      context.addIssue({
        code: "custom",
        message: "Reflection count exceeds the configured maximum",
        path: ["reflectionCount"],
      });
    }
  });

export type SessionPhase = z.infer<typeof SessionPhaseSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
