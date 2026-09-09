import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EditTransaction,
  FileSystemAdapter,
  WriteAuthorizationError,
  applyAuthorizedEdits,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patch-write-boundary-"));
  directories.push(root);
  await writeFile(join(root, "existing.ts"), "before\n");
  const files = await FileSystemAdapter.create(root);
  const transaction = await EditTransaction.stage(files, {
    operations: [
      {
        kind: "update",
        path: "existing.ts",
        before: "before\n",
        content: "after\n",
      },
      { kind: "create", path: "new.ts", content: "new\n" },
    ],
    shellCommands: [],
  });
  return { root, transaction };
}

describe("applyAuthorizedEdits", () => {
  it("previews, authorizes, checkpoints dirty files, applies, and reports", async () => {
    const { root, transaction } = await fixture();
    const events: string[] = [];

    const result = await applyAuthorizedEdits(transaction, ["existing.ts"], {
      presentPreview: (preview) => {
        events.push(`preview:${preview.changedPaths.join(",")}`);
      },
      authorize: ({ path, reason }) => {
        events.push(`authorize:${reason}:${path}`);
        return true;
      },
      isDirty: (path) => path === "existing.ts",
      checkpointDirty: (paths) => {
        events.push(`checkpoint:${paths.join(",")}`);
        return "checkpoint-sha";
      },
    });

    expect(events).toEqual([
      "preview:existing.ts,new.ts",
      "authorize:new-file:new.ts",
      "checkpoint:existing.ts",
    ]);
    expect(result).toEqual({
      changedPaths: ["existing.ts", "new.ts"],
      checkpoint: "checkpoint-sha",
    });
    await expect(readFile(join(root, "existing.ts"), "utf8")).resolves.toBe(
      "after\n",
    );
    await expect(readFile(join(root, "new.ts"), "utf8")).resolves.toBe("new\n");
  });

  it("does not checkpoint or write when path authorization is denied", async () => {
    const { root, transaction } = await fixture();
    let checkpointed = false;

    await expect(
      applyAuthorizedEdits(transaction, ["existing.ts"], {
        presentPreview: () => undefined,
        authorize: () => false,
        isDirty: () => true,
        checkpointDirty: () => {
          checkpointed = true;
          return undefined;
        },
      }),
    ).rejects.toBeInstanceOf(WriteAuthorizationError);
    expect(checkpointed).toBe(false);
    await expect(readFile(join(root, "existing.ts"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(readFile(join(root, "new.ts"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
