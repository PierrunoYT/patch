import { z } from "zod";

const PathListSchema = z.array(z.string().min(1));

export const RepositoryStatusSchema = z
  .object({
    root: z.string().min(1),
    head: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    trackedPaths: PathListSchema,
    stagedPaths: PathListSchema,
    modifiedPaths: PathListSchema,
    untrackedPaths: PathListSchema,
  })
  .strict();

export const DiffResultSchema = z
  .object({
    patch: z.string(),
    paths: PathListSchema,
  })
  .strict();

export const CommitRequestSchema = z
  .object({
    paths: PathListSchema.min(1),
    message: z.string().min(1),
    verify: z.boolean().default(true),
    attribution: z
      .object({
        authorName: z.string().min(1).optional(),
        committerName: z.string().min(1).optional(),
        coAuthor: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CommitResultSchema = z
  .object({
    commit: z.string().min(1),
    message: z.string().min(1),
    paths: PathListSchema.min(1),
  })
  .strict();

export interface Repository {
  readonly root: string;
  status(): Promise<RepositoryStatus>;
  diff(paths?: string[]): Promise<DiffResult>;
  isIgnored(path: string): Promise<boolean>;
  isDirty(path?: string): Promise<boolean>;
  commit(request: CommitRequest): Promise<CommitResult | undefined>;
}

export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;
export type DiffResult = z.infer<typeof DiffResultSchema>;
export type CommitRequest = z.infer<typeof CommitRequestSchema>;
export type CommitResult = z.infer<typeof CommitResultSchema>;
