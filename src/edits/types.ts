import { z } from "zod";

export const EditFormatSchema = z.enum([
  "ask",
  "help",
  "whole",
  "diff",
  "diff-fenced",
  "editor-whole",
  "editor-diff",
  "editor-diff-fenced",
  "udiff",
  "udiff-simple",
  "patch",
  "architect",
  "context",
]);

const RelativePathSchema = z.string().min(1);

const CreateFileEditSchema = z
  .object({
    kind: z.literal("create"),
    path: RelativePathSchema,
    content: z.string(),
  })
  .strict();

const ReplaceEditSchema = z
  .object({
    kind: z.literal("replace"),
    path: RelativePathSchema,
    search: z.string(),
    replacement: z.string(),
    protocol: z.literal("udiff").optional(),
  })
  .strict();

const RewriteFileEditSchema = z
  .object({
    kind: z.literal("rewrite"),
    path: RelativePathSchema,
    content: z.string(),
  })
  .strict();

const DeleteFileEditSchema = z
  .object({
    kind: z.literal("delete"),
    path: RelativePathSchema,
  })
  .strict();

const MoveFileEditSchema = z
  .object({
    kind: z.literal("move"),
    fromPath: RelativePathSchema,
    path: RelativePathSchema,
    content: z.string().optional(),
  })
  .strict()
  .refine((edit) => edit.fromPath !== edit.path, {
    message: "A move needs distinct source and destination paths",
    path: ["path"],
  });

export const EditSchema = z.union([
  CreateFileEditSchema,
  ReplaceEditSchema,
  RewriteFileEditSchema,
  DeleteFileEditSchema,
  MoveFileEditSchema,
]);

export const EditBatchSchema = z
  .object({
    edits: z.array(EditSchema),
    shellCommands: z.array(z.string().min(1)).default([]),
    fuzz: z.number().int().nonnegative().optional(),
  })
  .strict();

export type EditFormat = z.infer<typeof EditFormatSchema>;
export type Edit = z.infer<typeof EditSchema>;
export type EditBatch = z.infer<typeof EditBatchSchema>;
