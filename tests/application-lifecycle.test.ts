import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelCommand from "../src/process/model-command.js";

import {
  ConcreteApplicationService,
  FakeProvider,
  FileSystemAdapter,
  GitRepository,
  RepositoryMap,
  WriteAuthorizationError,
  WriteTextOptionsSchema,
  type ConcreteApplicationDependencies,
} from "../src/index.js";

const executeFile = promisify(execFile);
const directories: string[] = [];
const services: ConcreteApplicationService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "patch-lifecycle-"));
  directories.push(root);
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
  await executeFile("git", ["-C", root, "config", "core.autocrlf", "false"]);
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

const edit = (path: string, before: string, after: string) =>
  `${path}\n\`\`\`txt\n<<<<<<< SEARCH\n${before}\n=======\n${after}\n>>>>>>> REPLACE\n\`\`\`\n`;
const submitOptions = () => ({
  signal: new AbortController().signal,
  emit: () => undefined,
});
async function git(root: string, ...args: string[]) {
  return (await executeFile("git", ["-C", root, ...args])).stdout;
}
async function state(root: string) {
  return {
    head: await git(root, "rev-parse", "HEAD"),
    index: await git(root, "diff", "--cached"),
    worktree: await git(root, "diff"),
    status: await git(root, "status", "--porcelain"),
    selected: await readFile(join(root, "selected.txt"), "utf8"),
    unrelated: await readFile(join(root, "unrelated.txt"), "utf8"),
  };
}
async function dirtyRepository() {
  const root = await repository();
  await writeFile(join(root, "selected.txt"), "dirty\n");
  await writeFile(join(root, "unrelated.txt"), "staged unrelated\n");
  await git(root, "add", "unrelated.txt");
  await writeFile(join(root, "unrelated.txt"), "unstaged unrelated\n");
  return root;
}
async function application(
  root: string,
  provider: FakeProvider,
  dependencies: ConcreteApplicationDependencies = {},
  argv: string[] = [],
) {
  // Repository-map cache persistence is covered separately, not an edit write.
  vi.spyOn(RepositoryMap.prototype, "getMap").mockResolvedValue("");
  const service = await ConcreteApplicationService.create({
    cwd: root,
    home: root,
    environment: {},
    argv: ["--model", "4o", "--file", "selected.txt", ...argv],
    dependencies: { provider, ...dependencies },
  });
  services.push(service);
  return service.createSession({ principal: "test", sessionId: "failure" });
}

describe("application edit lifecycle", () => {
  it.each([
    "denial",
    "stale",
    "preview-cancel",
    "authorization-cancel",
    "truncation",
    "stream-cancel",
    "outside",
    "read-only",
  ])(
    "preserves exact disk/index/HEAD and a reusable queue on %s",
    async (failure) => {
      const root = await dirtyRepository();
      const before = await state(root);
      const controller = new AbortController();
      const text =
        edit("selected.txt", "dirty", "edited") +
        edit(
          failure === "outside"
            ? "../escape.txt"
            : failure === "read-only"
              ? "./unrelated.txt"
              : "new.txt",
          "",
          "new",
        );
      const provider = new FakeProvider([
        {
          actions: [
            { type: "text-delta", text },
            {
              type: "finish",
              reason: failure === "truncation" ? "length" : "stop",
            },
          ],
        },
        {
          actions: [
            { type: "text-delta", text: "recovered" },
            { type: "finish", reason: "stop" },
          ],
        },
      ]);
      const session = await application(
        root,
        provider,
        {
          authorizeWrite: async () => {
            if (failure === "stale")
              await writeFile(join(root, "selected.txt"), "external\n");
            if (failure === "authorization-cancel") controller.abort();
            return failure !== "denial";
          },
        },
        failure === "read-only" ? ["--read-only", "unrelated.txt"] : [],
      );
      await expect(
        session.submit("perform edits", {
          signal: controller.signal,
          emit: (event) => {
            if (
              (failure === "preview-cancel" && event.type === "edit-preview") ||
              (failure === "stream-cancel" && event.type === "text-delta")
            )
              controller.abort();
          },
        }),
      ).rejects.toThrow();
      await expect(readFile(join(root, "new.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (failure === "stale") {
        expect(await readFile(join(root, "selected.txt"), "utf8")).toBe(
          "external\n",
        );
        await writeFile(join(root, "selected.txt"), "dirty\n");
      }
      expect(await state(root)).toEqual(before);
      expect(await session.snapshot()).toMatchObject({
        phase: "interrupted",
        pendingEdits: [],
        messages: [],
        editablePaths: ["selected.txt"],
      });
      await expect(
        session.submit("retry", submitOptions()),
      ).resolves.toMatchObject({ response: "recovered", changedPaths: [] });
      expect(await state(root)).toEqual(before);
    },
  );

  it.each(["write-failure", "between-writes-cancel"])(
    "retains checkpoint and exactly the completed first write on %s",
    async (failure) => {
      const root = await dirtyRepository();
      await writeFile(join(root, "second.txt"), "second base\n");
      await git(root, "add", "second.txt");
      await git(root, "commit", "--quiet", "-m", "second", "--", "second.txt");
      const before = await state(root);
      const controller = new AbortController();
      const original = FileSystemAdapter.prototype.writeText;
      vi.spyOn(FileSystemAdapter.prototype, "writeText").mockImplementation(
        async function (this: FileSystemAdapter, path, content, options) {
          const { dryRun } = WriteTextOptionsSchema.parse(options ?? {});
          if (!dryRun && path === "second.txt" && failure === "write-failure")
            throw new Error("injected second write failure");
          const result = await original.call(this, path, content, options);
          if (
            !dryRun &&
            path === "selected.txt" &&
            failure === "between-writes-cancel"
          )
            controller.abort();
          return result;
        },
      );
      const session = await application(
        root,
        response(
          edit("selected.txt", "dirty", "edited") +
            edit("second.txt", "second base", "second edited"),
        ),
        {},
        ["--file", "second.txt"],
      );
      await expect(
        session.submit("apply", {
          ...submitOptions(),
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "selected.txt"), "utf8")).toBe(
        "edited\n",
      );
      expect(await readFile(join(root, "second.txt"), "utf8")).toBe(
        "second base\n",
      );
      expect(await git(root, "show", "HEAD:selected.txt")).toBe("dirty\n");
      expect(await git(root, "show", "HEAD:second.txt")).toBe("second base\n");
      expect(await git(root, "rev-parse", "HEAD^")).toBe(before.head);
      expect(await git(root, "diff", "--cached")).toBe(before.index);
      expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
        before.unrelated,
      );
      expect(await session.snapshot()).toMatchObject({
        phase: "interrupted",
        pendingEdits: [],
        lastPatchCommit: (await git(root, "rev-parse", "HEAD")).trim(),
      });
      await expect(
        session.submit("/ls", submitOptions()),
      ).resolves.toMatchObject({
        response: expect.stringContaining("second.txt"),
      });
    },
  );

  it.each(["checkpoint", "lint", "test"])(
    "keeps completed Git work and accepts the next turn after cancellation at %s",
    async (boundary) => {
      const root = await dirtyRepository();
      const before = await state(root);
      const controller = new AbortController();
      const original = GitRepository.prototype.commit;
      vi.spyOn(GitRepository.prototype, "commit").mockImplementation(
        async function (this: GitRepository, request) {
          const result = await original.call(this, request);
          if (
            boundary === "checkpoint" &&
            request.message === "Checkpoint before Patch edits"
          )
            controller.abort();
          return result;
        },
      );
      const provider = new FakeProvider([
        {
          actions: [
            {
              type: "text-delta",
              text: edit("selected.txt", "dirty", "edited"),
            },
            { type: "finish", reason: "stop" },
          ],
        },
        {
          actions: [
            { type: "text-delta", text: "recovered" },
            { type: "finish", reason: "stop" },
          ],
        },
      ]);
      const session = await application(root, provider, {}, [
        "--lint-cmd",
        'node -e "process.exit(0)"',
        "--test-cmd",
        'node -e "process.exit(0)"',
      ]);
      await expect(
        session.submit("edit", {
          signal: controller.signal,
          emit: (event) => {
            if (event.type === `${boundary}-start`) controller.abort();
          },
        }),
      ).rejects.toThrow();
      const content = boundary === "checkpoint" ? "dirty\n" : "edited\n";
      expect(await readFile(join(root, "selected.txt"), "utf8")).toBe(content);
      expect(await git(root, "show", "HEAD:selected.txt")).toBe(content);
      expect(await git(root, "diff", "--cached")).toBe(before.index);
      expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
        before.unrelated,
      );
      expect(await session.snapshot()).toMatchObject({
        phase: "interrupted",
        pendingEdits: [],
        lastPatchCommit: (await git(root, "rev-parse", "HEAD")).trim(),
      });
      await expect(
        session.submit("recover", submitOptions()),
      ).resolves.toMatchObject({ response: "recovered", changedPaths: [] });
      expect(
        provider.requests[1]?.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(content),
        ),
      ).toBe(true);
    },
  );

  it("uses the live editable selection for write authorization after drop and add", async () => {
    const root = await dirtyRepository();
    const before = await state(root);
    const text = edit("selected.txt", "dirty", "edited");
    const provider = new FakeProvider(
      [text, text].map((text) => ({
        actions: [
          { type: "text-delta", text },
          { type: "finish", reason: "stop" },
        ],
      })),
    );
    const session = await application(root, provider);
    await session.submit("/drop selected.txt", submitOptions());
    await expect(session.submit("edit", submitOptions())).rejects.toThrow(
      WriteAuthorizationError,
    );
    expect(await state(root)).toEqual(before);
    await session.submit("/add selected.txt", submitOptions());
    await session.submit("edit", submitOptions());
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("edited\n");
    expect(await git(root, "diff", "--cached")).toBe(before.index);
  });

  it("corrects a failing test, then passes against the committed correction", async () => {
    const root = await dirtyRepository();
    const before = await state(root);
    const provider = new FakeProvider(
      [
        edit("selected.txt", "dirty", "interim"),
        edit("selected.txt", "interim", "final"),
      ].map((text) => ({
        actions: [
          { type: "text-delta", text },
          { type: "finish", reason: "stop" },
        ],
      })),
    );
    const command = `node -e "const fs=require('fs');const cp=require('child_process');const a=fs.readFileSync('selected.txt','utf8');if(a!==cp.execFileSync('git',['show','HEAD:selected.txt'],{encoding:'utf8'})||a!=='final\\n')process.exit(8)"`;
    const session = await application(root, provider, {}, [
      "--test-cmd",
      command,
    ]);
    await expect(session.submit("fix", submitOptions())).resolves.toMatchObject(
      { changedPaths: ["selected.txt"] },
    );
    expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("final\n");
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("final\n");
    expect(await git(root, "diff", "--cached")).toBe(before.index);
    expect(await session.snapshot()).toMatchObject({
      phase: "waiting",
      reflectionCount: 1,
      pendingEdits: [],
    });
  });

  it("reflects failing configured tests against refreshed disk and stops at the shared bound", async () => {
    const root = await dirtyRepository();
    const before = await state(root);
    const provider = new FakeProvider(
      ["one", "two", "three", "four"].map((after, i, values) => ({
        actions: [
          {
            type: "text-delta",
            text: edit(
              "selected.txt",
              i === 0 ? "dirty" : values[i - 1]!,
              after,
            ),
          },
          { type: "finish", reason: "stop" },
        ],
      })),
    );
    const session = await application(root, provider, {}, [
      "--test-cmd",
      'node -e "process.exit(9)"',
    ]);
    await expect(session.submit("fix", submitOptions())).rejects.toMatchObject({
      name: "ReflectionLimitError",
      diagnostic: expect.stringContaining("code 9"),
    });
    expect(provider.requests).toHaveLength(4);
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("four\n");
    expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("four\n");
    expect(await git(root, "diff", "--cached")).toBe(before.index);
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
      before.unrelated,
    );
    expect(await session.snapshot()).toMatchObject({
      phase: "interrupted",
      pendingEdits: [],
      lastPatchCommit: (await git(root, "rev-parse", "HEAD")).trim(),
    });
    await session.submit("/undo", submitOptions());
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("three\n");
    expect(await git(root, "diff", "--cached")).toBe(before.index);
  }, 15_000);

  it.each(["denied", "nonzero", "timed-out", "cancelled", "truncated"])(
    "retains the edited commit and unrelated index for a %s command",
    async (outcome) => {
      const root = await dirtyRepository();
      const before = await state(root);
      const controller = new AbortController();
      const original = modelCommand.executeModelCommands;
      vi.spyOn(modelCommand, "executeModelCommands").mockImplementation(
        (commands, options, dependencies) =>
          original(
            commands,
            {
              ...options,
              timeoutMs: outcome === "timed-out" ? 100 : 5000,
              maxOutputBytes: 20,
            },
            dependencies,
          ),
      );
      const command =
        outcome === "timed-out"
          ? 'node -e "setTimeout(()=>{},10000)"'
          : outcome === "truncated"
            ? `node -e "process.stdout.write('z'.repeat(100))"`
            : `node -e "require('fs').writeFileSync('.git/ran','yes');process.exit(4)"`;
      const session = await application(
        root,
        response(
          edit("selected.txt", "dirty", "edited") +
            `\`\`\`sh\n${command}\n\`\`\``,
        ),
        {
          approveCommand: () => {
            if (outcome === "cancelled") controller.abort();
            return outcome !== "denied";
          },
        },
      );
      const pending = session.submit("apply", {
        ...submitOptions(),
        signal: controller.signal,
      });
      if (outcome === "cancelled") await expect(pending).rejects.toThrow();
      else
        await expect(pending).resolves.toMatchObject({
          commands: [
            {
              status:
                outcome === "truncated" || outcome === "nonzero"
                  ? "completed"
                  : outcome,
              ...(outcome === "truncated"
                ? { stdout: "z".repeat(20), truncated: true }
                : {}),
            },
          ],
        });
      expect(await git(root, "show", "HEAD:selected.txt")).toBe("edited\n");
      expect(await readFile(join(root, "selected.txt"), "utf8")).toBe(
        "edited\n",
      );
      expect(await git(root, "diff", "--cached")).toBe(before.index);
      expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
        before.unrelated,
      );
      if (outcome !== "nonzero")
        await expect(readFile(join(root, ".git/ran"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      else expect(await readFile(join(root, ".git/ran"), "utf8")).toBe("yes");
      await session.submit("/undo", submitOptions());
      expect(await git(root, "show", "HEAD:selected.txt")).toBe("dirty\n");
      expect(await git(root, "diff", "--cached")).toBe(before.index);
    },
  );

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
