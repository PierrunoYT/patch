import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EditTransaction,
  FileSystemAdapter,
  PathOutsideRootError,
  StaleFileSnapshotError,
  TextEncodingError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-transaction-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("EditTransaction", () => {
  it("stages without writes and commits create, update, and delete together", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "update.ts"), "before\n");
    await writeFile(join(root, "delete.ts"), "remove\n");
    const files = await FileSystemAdapter.create(root, { lineEndings: "lf" });

    const transaction = await EditTransaction.stage(files, {
      operations: [
        { kind: "create", path: "new/nested.ts", content: "created\n" },
        {
          kind: "update",
          path: "update.ts",
          before: "before\n",
          content: "after\n",
        },
        { kind: "delete", path: "delete.ts", before: "remove\n" },
      ],
      shellCommands: ["npm test\n"],
    });

    await expect(stat(join(root, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "update.ts"), "utf8")).toBe("before\n");
    expect(await readFile(join(root, "delete.ts"), "utf8")).toBe("remove\n");
    expect(transaction.shellCommands).toEqual(["npm test\n"]);

    await transaction.commit();

    expect(await readFile(join(root, "new/nested.ts"), "utf8")).toBe(
      "created\n",
    );
    expect(await readFile(join(root, "update.ts"), "utf8")).toBe("after\n");
    await expect(stat(join(root, "delete.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(transaction.commit()).rejects.toThrow("commits once");
  });

  it("performs no writes when any staged snapshot is stale", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n");
    await writeFile(join(root, "second.ts"), "actual\n");
    const files = await FileSystemAdapter.create(root);

    await expect(
      EditTransaction.stage(files, {
        operations: [
          {
            kind: "update",
            path: "first.ts",
            before: "first\n",
            content: "changed\n",
          },
          {
            kind: "update",
            path: "second.ts",
            before: "stale\n",
            content: "changed\n",
          },
        ],
        shellCommands: [],
      }),
    ).rejects.toBeInstanceOf(StaleFileSnapshotError);
    expect(await readFile(join(root, "first.ts"), "utf8")).toBe("first\n");
  });

  it("performs no writes when encoding or containment validation fails", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.txt"), "first\n", "latin1");
    const files = await FileSystemAdapter.create(root, { encoding: "latin1" });
    const validFirst = {
      kind: "update" as const,
      path: "first.txt",
      before: "first\n",
      content: "changed\n",
    };

    await expect(
      EditTransaction.stage(files, {
        operations: [
          validFirst,
          { kind: "create", path: "new/euro.txt", content: "€\n" },
        ],
        shellCommands: [],
      }),
    ).rejects.toBeInstanceOf(TextEncodingError);
    expect(await readFile(join(root, "first.txt"), "latin1")).toBe("first\n");
    await expect(stat(join(root, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      EditTransaction.stage(files, {
        operations: [
          validFirst,
          { kind: "create", path: "../escape", content: "x" },
        ],
        shellCommands: [],
      }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    expect(await readFile(join(root, "first.txt"), "latin1")).toBe("first\n");
  });

  it("keeps a move source until the destination write succeeds", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "source.ts"), "moved\n");
    await writeFile(join(root, "blocked"), "not a directory\n");
    const files = await FileSystemAdapter.create(root, { lineEndings: "lf" });

    // The resolver emits a move as the source delete followed by the
    // destination create; the destination write here cannot succeed.
    const transaction = await EditTransaction.stage(files, {
      operations: [
        { kind: "delete", path: "source.ts", before: "moved\n" },
        { kind: "create", path: "blocked/destination.ts", content: "moved\n" },
      ],
      shellCommands: [],
    });

    await expect(transaction.commit()).rejects.toThrow();
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe("moved\n");
  });

  it("refuses to delete a move source that the destination write replaced", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "notes.md"), "moved\n");
    const files = await FileSystemAdapter.create(root, { lineEndings: "lf" });
    const operations = [
      { kind: "delete" as const, path: "notes.md", before: "moved\n" },
      {
        kind: "create" as const,
        path: "NOTES.md",
        content: "moved and renamed\n",
      },
    ];

    // On a case-insensitive filesystem both paths are one file, so staging or
    // the pre-delete recheck refuses the batch; on a case-sensitive one both
    // operations run. Neither outcome may leave the content deleted.
    try {
      await (
        await EditTransaction.stage(files, { operations, shellCommands: [] })
      ).commit();
      expect(await readFile(join(root, "NOTES.md"), "utf8")).toBe(
        "moved and renamed\n",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(StaleFileSnapshotError);
      expect(await readFile(join(root, "notes.md"), "utf8")).toBe("moved\n");
    }
  });

  it("revalidates the whole batch before the first committed write", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n");
    await writeFile(join(root, "second.ts"), "second\n");
    const files = await FileSystemAdapter.create(root);
    const transaction = await EditTransaction.stage(files, {
      operations: [
        {
          kind: "update",
          path: "first.ts",
          before: "first\n",
          content: "changed first\n",
        },
        {
          kind: "update",
          path: "second.ts",
          before: "second\n",
          content: "changed second\n",
        },
      ],
      shellCommands: [],
    });
    await writeFile(join(root, "second.ts"), "external change\n");

    await expect(transaction.commit()).rejects.toBeInstanceOf(
      StaleFileSnapshotError,
    );
    expect(await readFile(join(root, "first.ts"), "utf8")).toBe("first\n");
  });
});
