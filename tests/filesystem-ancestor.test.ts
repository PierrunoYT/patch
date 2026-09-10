import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Runs once inside the window between a mutation's authorized checks and the
 * syscall that performs it. Node exposes no openat/renameat, so the adapter
 * detects an ancestor swap by identity; forcing the swap here is the only
 * deterministic way to enter that window.
 */
let duringOpen: (() => Promise<void>) | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const hook = duringOpen;
      duringOpen = undefined;
      await hook?.();
      return handle;
    },
  };
});

const { AncestorChangedDuringWriteError, FileSystemAdapter } =
  await import("../src/index.js");

const directories: string[] = [];

afterEach(async () => {
  duringOpen = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-ancestor-"));
  directories.push(root);
  await mkdir(join(root, "pkg"));
  await mkdir(join(root, "decoy"));
  await writeFile(join(root, "pkg", "file.txt"), "original\n");
  await writeFile(join(root, "decoy", "file.txt"), "decoy\n");
  return root;
}

/** Put a different directory at the same path the mutation was authorized for. */
async function swapParent(root: string): Promise<void> {
  await rename(join(root, "pkg"), join(root, "moved"));
  await rename(join(root, "decoy"), join(root, "pkg"));
}

describe("ancestor identity", () => {
  it("refuses a replacement whose containing directory was swapped", async () => {
    const root = await repository();
    const files = await FileSystemAdapter.create(root);
    duringOpen = () => swapParent(root);

    await expect(
      files.writeText("pkg/file.txt", "updated\n"),
    ).rejects.toBeInstanceOf(AncestorChangedDuringWriteError);

    // Neither directory took the write, and no temporary file survived.
    expect(await readFile(join(root, "pkg", "file.txt"), "utf8")).toBe(
      "decoy\n",
    );
    expect(await readFile(join(root, "moved", "file.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(await readdir(join(root, "pkg"))).toEqual(["file.txt"]);
    // Cleanup unlinks by path, which now names the swapped-in directory, so a
    // temporary file can remain in the directory that was moved away. It is
    // always a hidden, uniquely named Patch temporary, never repository
    // content, and it is never renamed over a real file.
    expect((await readdir(join(root, "moved"))).sort()).toEqual([
      expect.stringMatching(/^\.file\.txt\.patch-[0-9a-f-]+\.tmp$/u),
      "file.txt",
    ]);
  });

  it("still replaces a file when its directory is untouched", async () => {
    const root = await repository();
    const files = await FileSystemAdapter.create(root);

    await expect(
      files.writeText("pkg/file.txt", "updated\n"),
    ).resolves.toMatchObject({ dryRun: false });
    expect(await readFile(join(root, "pkg", "file.txt"), "utf8")).toBe(
      "updated\n",
    );
  });
});
