import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfiguredChecks } from "../src/index.js";

const directories: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-checks-"));
  directories.push(directory);
  return directory;
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("configured lint and test checks", () => {
  it("does not guess package-manager commands when configuration is absent", async () => {
    const directory = await root();
    const marker = join(directory, "guessed");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          lint: nodeCommand(
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'lint')`,
          ),
          test: nodeCommand(
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'test')`,
          ),
        },
      }),
    );

    const checks = createConfiguredChecks({}, { root: directory });

    expect(checks).toEqual({});
    await expect(access(marker)).rejects.toThrow();
  });

  it("runs each configured command at the repository root", async () => {
    const directory = await root();
    const checks = createConfiguredChecks(
      {
        lintCommand: nodeCommand(
          "require('node:fs').writeFileSync('lint-result', process.cwd())",
        ),
        testCommand: nodeCommand(
          "require('node:fs').writeFileSync('test-result', process.cwd())",
        ),
      },
      { root: directory },
    );

    await expect(checks.lint?.({} as never)).resolves.toBeUndefined();
    await expect(checks.test?.({} as never)).resolves.toBeUndefined();
    await expect(
      readFile(join(directory, "lint-result"), "utf8"),
    ).resolves.toBe(directory);
    await expect(
      readFile(join(directory, "test-result"), "utf8"),
    ).resolves.toBe(directory);
  });

  it("returns command output as a reflection diagnostic on failure", async () => {
    const directory = await root();
    const checks = createConfiguredChecks(
      {
        lintCommand: nodeCommand(
          "process.stderr.write('fix this lint error'); process.exitCode = 2",
        ),
      },
      { root: directory },
    );

    await expect(checks.lint?.({} as never)).resolves.toBe(
      "Configured lint command exited with code 2\n\nfix this lint error",
    );
  });
});
