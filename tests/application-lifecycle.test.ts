import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  GitRepository,
  WriteAuthorizationError,
} from "../src/index.js";

const executeFile = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "patch-lifecycle-"));
  await executeFile("git", ["init", "--quiet", root]);
  await executeFile("git", ["-C", root, "config", "user.name", "Patch Test"]);
  await executeFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "patch@test.invalid",
  ]);
  await executeFile("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "selected.txt"), "base\n");
  await writeFile(join(root, "unrelated.txt"), "keep\n");
  await executeFile("git", ["-C", root, "add", "."]);
  await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  return root;
}

function response(content: string) {
  return new FakeProvider([
    {
      actions: [
        { type: "text-delta", text: content },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
}

describe("application edit lifecycle", () => {
  it("checkpoints, applies, commits, checks edited disk, approves a command, and preserves unrelated changes", async () => {
    const root = await repository();
    await writeFile(join(root, "selected.txt"), "dirty\n");
    await writeFile(join(root, "unrelated.txt"), "unrelated user work\n");
    const search = "<<<<<<< SEARCH";
    const divider = "=======";
    const replace = ">>>>>>> REPLACE";
    const modelResponse = `selected.txt
\`\`\`txt
${search}
dirty
${divider}
edited
${replace}
\`\`\`
\`\`\`sh
node -e "require('fs').writeFileSync('command-ran.txt','yes')"
\`\`\``;
    const lint = `node -e "if(require('fs').readFileSync('selected.txt','utf8')!=='edited\\n')process.exit(2)"`;
    const test = `node -e "if(require('fs').readFileSync('command-ran.txt','utf8')!=='yes')process.exit(3)"`;
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--model",
        "4o",
        "--file",
        "selected.txt",
        "--lint-cmd",
        lint,
        "--test-cmd",
        test,
      ],
      dependencies: {
        provider: response(modelResponse),
        approveCommand: () => true,
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "lifecycle",
    });
    const events: string[] = [];
    const result = await session.submit("make the change", {
      signal: new AbortController().signal,
      emit: (event) => events.push(event.type),
    });

    expect(result).toMatchObject({
      changedPaths: ["selected.txt"],
      commit: expect.any(String),
      commands: [{ status: "completed", exitCode: 0 }],
    });
    expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
      "unrelated user work\n",
    );
    expect(events.indexOf("edit-preview")).toBeLessThan(
      events.indexOf("lint-start"),
    );
    expect(events.indexOf("lint-complete")).toBeLessThan(
      events.indexOf("command-preview"),
    );
    expect(events.indexOf("command-preview")).toBeLessThan(
      events.indexOf("test-start"),
    );

    const git = await GitRepository.open(root);
    const status = await git.status();
    expect(status.modifiedPaths).toEqual(["unrelated.txt"]);
    const log = (await executeFile("git", ["-C", root, "log", "--format=%s"]))
      .stdout;
    expect(log).toContain("Apply Patch edits");
    expect(log).toContain("Checkpoint before Patch edits");

    await session.submit("/undo", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect((await git.status()).modifiedPaths.sort()).toEqual([
      "selected.txt",
      "unrelated.txt",
    ]);
  });

  it("denies a new path before mutating the filesystem", async () => {
    const root = await repository();
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--model",
        "4o",
        "--edit-format",
        "patch",
        "--file",
        "selected.txt",
      ],
      dependencies: {
        provider: response(
          "*** Begin Patch\n*** Add File: denied.txt\n+must not exist\n*** End Patch",
        ),
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "deny",
    });

    await expect(
      session.submit("create it", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow(WriteAuthorizationError);
    await expect(
      readFile(join(root, "denied.txt"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
