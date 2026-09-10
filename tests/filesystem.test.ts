import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemAdapter,
  PathOutsideRootError,
  TextDecodingError,
  TextEncodingError,
  UnsafeFileMetadataError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-filesystem-"));
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

describe("FileSystemAdapter", () => {
  it("normalizes reads and preserves CRLF and file permissions on replacement", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "source file.ts");
    const lfPath = join(root, "lf.ts");
    await writeFile(path, "first\r\nsecond\r\n");
    await writeFile(lfPath, "first\nsecond\n");
    await chmod(path, 0o640);
    const files = await FileSystemAdapter.create(root);

    await expect(files.readText("source file.ts")).resolves.toMatchObject({
      content: "first\nsecond\n",
      encoding: "utf-8",
      lineEnding: "crlf",
    });
    await expect(
      files.writeText("source file.ts", "updated\ntext\n"),
    ).resolves.toMatchObject({
      lineEnding: "crlf",
      dryRun: false,
    });
    await files.writeText("lf.ts", "updated\ntext\n");

    expect(await readFile(path, "utf8")).toBe("updated\r\ntext\r\n");
    expect(await readFile(lfPath, "utf8")).toBe("updated\ntext\n");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o640);
    }
    expect((await readdir(root)).sort()).toEqual(["lf.ts", "source file.ts"]);
  });

  it("writes configured line endings to new nested files", async () => {
    const root = await temporaryDirectory();
    const files = await FileSystemAdapter.create(root, { lineEndings: "crlf" });

    const result = await files.writeText("new/nested.txt", "one\ntwo\n");

    expect(result).toMatchObject({ lineEnding: "crlf", dryRun: false });
    expect(await readFile(join(root, "new", "nested.txt"), "utf8")).toBe(
      "one\r\ntwo\r\n",
    );
  });

  it("supports configured encodings and preserves a byte-order mark", async () => {
    const root = await temporaryDirectory();
    const latinPath = join(root, "latin.txt");
    const bomPath = join(root, "bom.txt");
    await writeFile(latinPath, Buffer.from("café\n", "latin1"));
    await writeFile(
      bomPath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("before\n")]),
    );

    const latinFiles = await FileSystemAdapter.create(root, {
      encoding: "latin1",
      lineEndings: "lf",
    });
    expect((await latinFiles.readText("latin.txt")).content).toBe("café\n");
    await latinFiles.writeText("latin.txt", "déjà\n");
    expect(await readFile(latinPath)).toEqual(Buffer.from("déjà\n", "latin1"));

    const utf8Files = await FileSystemAdapter.create(root);
    expect((await utf8Files.readText("bom.txt")).byteOrderMark).toBe(true);
    await utf8Files.writeText("bom.txt", "after\n");
    expect(await readFile(bomPath)).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("after\n")]),
    );

    const utf16Files = await FileSystemAdapter.create(root, {
      encoding: "utf-16le",
      lineEndings: "lf",
    });
    await utf16Files.writeText("utf16.txt", "snowman: ☃\n");
    expect(await readFile(join(root, "utf16.txt"))).toEqual(
      Buffer.from("snowman: ☃\n", "utf16le"),
    );
    expect((await utf16Files.readText("utf16.txt")).content).toBe(
      "snowman: ☃\n",
    );
  });

  it("validates decoding and refuses content unsupported by the encoding", async () => {
    const root = await temporaryDirectory();
    const malformedPath = join(root, "malformed.txt");
    const latinPath = join(root, "latin.txt");
    await writeFile(malformedPath, Buffer.from([0xc3, 0x28]));
    await writeFile(latinPath, "unchanged\n");

    const utf8Files = await FileSystemAdapter.create(root);
    await expect(utf8Files.readText("malformed.txt")).rejects.toBeInstanceOf(
      TextDecodingError,
    );

    const latinFiles = await FileSystemAdapter.create(root, {
      encoding: "latin1",
    });
    await expect(
      latinFiles.writeText("latin.txt", "price: €\n"),
    ).rejects.toBeInstanceOf(TextEncodingError);
    expect(await readFile(latinPath, "utf8")).toBe("unchanged\n");
    await expect(
      latinFiles.writeText("missing/file.txt", "price: €\n"),
    ).rejects.toBeInstanceOf(TextEncodingError);
    await expect(lstat(join(root, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("computes a dry run without creating a file or its parents", async () => {
    const root = await temporaryDirectory();
    const files = await FileSystemAdapter.create(root, { lineEndings: "lf" });

    await expect(
      files.writeText("missing/preview.txt", "preview\n", { dryRun: true }),
    ).resolves.toMatchObject({
      lineEnding: "lf",
      bytesWritten: Buffer.byteLength("preview\n"),
      dryRun: true,
    });
    await expect(lstat(join(root, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks containment before reads, dry runs, and writes", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "target.txt"), "unchanged\n");
    await symlink(outside, join(root, "escape"), "dir");
    const files = await FileSystemAdapter.create(root);

    await expect(files.readText("escape/target.txt")).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
    await expect(
      files.writeText("escape/target.txt", "changed\n", { dryRun: true }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(
      files.writeText("escape/target.txt", "changed\n"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe(
      "unchanged\n",
    );
  });

  it("keeps ownership and permissions across a replacement", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "owned.txt");
    await writeFile(path, "before\n");
    await chmod(path, 0o600);
    const before = await stat(path);
    const files = await FileSystemAdapter.create(root);

    await files.writeText("owned.txt", "after\n");

    const after = await stat(path);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(await readFile(path, "utf8")).toBe("after\n");
  });

  it("rejects replacement and deletion when a file has another hard link", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    const target = join(root, "target.txt");
    const outsideAlias = join(parent, "outside.txt");
    await mkdir(root);
    await writeFile(target, "shared\n");
    await link(target, outsideAlias);
    const files = await FileSystemAdapter.create(root);

    await expect(files.writeText("target.txt", "changed\n")).rejects.toThrow(
      UnsafeFileMetadataError,
    );
    await expect(files.deleteFile("target.txt")).rejects.toThrow(
      UnsafeFileMetadataError,
    );
    expect(await readFile(target, "utf8")).toBe("shared\n");
    expect(await readFile(outsideAlias, "utf8")).toBe("shared\n");
    expect(await readdir(root)).toEqual(["target.txt"]);
  });
});
