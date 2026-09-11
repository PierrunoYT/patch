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
        {
          path: join("src", "greeter.js"),
          line: 0,
          name: "greet",
          kind: "definition",
        },
        {
          path: join("src", "greeter.js"),
          line: 1,
          name: "Greeter",
          kind: "definition",
        },
        {
          path: join("src", "greeter.js"),
          line: 0,
          name: "format",
          kind: "reference",
        },
        {
          path: join("src", "greeter.js"),
          line: 2,
          name: "greet",
          kind: "reference",
        },
      ]),
    );
  });

  it("falls back to lexical references for unparsed file types", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "notes.md"),
      "# Notes\n\nSee `Greeter` and greet, which is short.\n",
    );
    const extractor = await TagExtractor.create(root);

    const tags = await extractor.extract("notes.md");

    // A file no grammar covers still mentions the symbols a request is about,
    // and those mentions rank the files that define them.
    expect(tags).toContainEqual({
      path: "notes.md",
      line: 0,
      name: "Notes",
      kind: "reference",
    });
    expect(tags.map(({ name }) => name)).toContain("Greeter");
    // Nothing lexical can tell a definition from a mention.
    expect(tags.every((tag) => tag.kind === "reference")).toBe(true);
    // Identifiers are reported once each, at their first line.
    expect(new Set(tags.map(({ name }) => name)).size).toBe(tags.length);
  });

  it("reports nothing for an empty or binary file", async () => {
    const root = await fixture();
    await writeFile(join(root, "empty.md"), "");
    await writeFile(join(root, "blob.bin"), "name\0name\n");
    const extractor = await TagExtractor.create(root);

    await expect(extractor.extract("empty.md")).resolves.toEqual([]);
    await expect(extractor.extract("blob.bin")).resolves.toEqual([]);
  });

  it.each([
    {
      extension: "ts",
      source:
        "export class Greeter {}\nconst value: Greeter = new Greeter();\n",
      definition: "Greeter",
      reference: "Greeter",
    },
    {
      extension: "tsx",
      source:
        "interface Props { name: string }\nexport function Greeting(props: Props) { return <p>{props.name}</p>; }\n",
      definition: "Greeting",
      reference: "Props",
    },
    {
      extension: "py",
      source: "def greet(name):\n    return format(name)\n\ngreet('Ada')\n",
      definition: "greet",
      reference: "format",
    },
    {
      extension: "go",
      source:
        "package main\ntype Greeter struct {}\nfunc greet() { format(); }\nfunc main() { greet() }\n",
      definition: "greet",
      reference: "format",
    },
    {
      extension: "rs",
      source:
        "struct Greeter {}\nfn greet() { format(); }\nfn main() { greet(); }\n",
      definition: "greet",
      reference: "format",
    },
    {
      extension: "java",
      source:
        "public class Greeter {\n  public int greet() { return format(); }\n}\n",
      definition: "greet",
      reference: "format",
    },
    {
      extension: "rb",
      source: "class Greeter\n  def greet\n    format\n  end\nend\n",
      definition: "greet",
      reference: "format",
    },
    {
      extension: "cs",
      // The query captures a constructed type as a reference, not a bare call.
      source:
        "public class Greeter {\n  public object Greet() { return new Format(); }\n}\n",
      definition: "Greet",
      reference: "Format",
    },
    {
      extension: "cpp",
      source: "int format();\nint greet() { return format(); }\n",
      definition: "greet",
      reference: undefined,
    },
    {
      extension: "sh",
      source: "greet() {\n  format\n}\n",
      definition: "greet",
      reference: "format",
    },
  ])(
    "extracts definitions and references from .$extension",
    async ({ extension, source, definition, reference }) => {
      const root = await fixture();
      const path = `src/sample.${extension}`;
      await writeFile(join(root, path), source);

      const tags = await (await TagExtractor.create(root)).extract(path);

      expect(tags).toContainEqual(
        expect.objectContaining({ name: definition, kind: "definition" }),
      );
      // Upstream's C++ query captures definitions only, so some languages
      // contribute no references at all.
      if (reference !== undefined) {
        expect(tags).toContainEqual(
          expect.objectContaining({ name: reference, kind: "reference" }),
        );
      }
    },
  );

  it("rejects paths outside the selected repository root", async () => {
    const root = await fixture();
    await expect(
      (await TagExtractor.create(root)).extract("../outside.js"),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });
});
