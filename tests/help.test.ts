import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMAND_NAMES, renderHelp } from "../src/index.js";

describe("local help", () => {
  it("lists every supported command without reading documentation", async () => {
    const output = await renderHelp(undefined, {
      documentRoot: join(tmpdir(), "missing-patch-help"),
    });
    for (const command of COMMAND_NAMES)
      expect(output).toContain(`/${command}`);
    expect(output).toContain("/help <query>");
  });

  it("returns bounded deterministic excerpts with source references", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-help-"));
    await writeFile(
      join(root, "commands.md"),
      Array.from({ length: 20 }, (_, index) => `Needle result ${index}`).join(
        "\n",
      ),
    );

    const output = await renderHelp("needle", { documentRoot: root });
    expect(output).toContain("commands.md:1: Needle result 0");
    expect(output).toContain("commands.md:8: Needle result 7");
    expect(output).not.toContain("Needle result 8");
  });

  it("reports no match and missing installed documentation safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-help-empty-"));
    await writeFile(join(root, "commands.md"), "unrelated\n");
    await expect(renderHelp("needle", { documentRoot: root })).resolves.toBe(
      "No installed Patch help matched: needle",
    );
    await expect(
      renderHelp("needle", { documentRoot: join(root, "missing") }),
    ).resolves.toBe(
      "Patch help documents are unavailable in this installation.",
    );
  });
});
