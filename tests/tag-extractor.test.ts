import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathOutsideRootError, TagExtractor } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-tags-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src"));
  return root;
}

describe("TagExtractor", () => {
  it("extracts JavaScript definitions and references in source order", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "src", "greeter.js"),
      "export function greet(name) { return format(name); }\nclass Greeter {}\ngreet('Ada');\n",
    );

    const extractor = await TagExtractor.create(root);
    const tags = await extractor.extract("src/greeter.js");

    expect(tags).toEqual(
      expect.arrayContaining([
        { path: "src/greeter.js", line: 0, name: "greet", kind: "definition" },
        {
          path: "src/greeter.js",
          line: 1,
          name: "Greeter",
          kind: "definition",
        },
        { path: "src/greeter.js", line: 0, name: "format", kind: "reference" },
        { path: "src/greeter.js", line: 2, name: "greet", kind: "reference" },
      ]),
    );
  });

  it("ignores unsupported file types", async () => {
    const root = await fixture();
    await writeFile(join(root, "notes.md"), "# Notes\n");
    await expect(
      (await TagExtractor.create(root)).extract("notes.md"),
    ).resolves.toEqual([]);
  });

  it("rejects paths outside the selected repository root", async () => {
    const root = await fixture();
    await expect(
      (await TagExtractor.create(root)).extract("../outside.js"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });
});
