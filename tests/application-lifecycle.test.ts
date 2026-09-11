import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelCommand from "../src/process/model-command.js";
import { createProgram } from "../src/program.js";

import {
  ConcreteApplicationService,
  FakeProvider,
  FileSystemAdapter,
  GitRepository,
  RepositoryMap,
  TurnPartiallyAppliedError,
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
  await executeFile("git", [
    "-C",
    root,
    "config",
    "core.hooksPath",
    ".git/hooks",
  ]);
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
  it("wires generated commit policy through the executable for checkpoints, edits, and checks", async () => {
    const root = await dirtyRepository();
    const before = await state(root);
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: edit("selected.txt", "dirty", "edited") },
          { type: "finish", reason: "stop" },
          { type: "usage", inputTokens: 20, outputTokens: 10, cost: 0 },
        ],
      },
      ...[
        "chore: save user work",
        "fix: edit selected file",
        "style: lint selected file",
      ].map((text) => ({
        actions: [
          { type: "text-delta", text },
          { type: "finish", reason: "stop" },
          { type: "usage", inputTokens: 100, outputTokens: 10, cost: 0.01 },
        ],
      })),
    ]);
    const lint =
      "node -e \"require('fs').writeFileSync('selected.txt','linted\\n')\"";
    const hook = join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho ran >> .git/hook-runs\n");
    await chmod(hook, 0o755);
    await git(root, "config", "core.hooksPath", ".git/hooks");
    let output = "";
    await createProgram({
      cwd: root,
      environment: {},
      writeOutput: (text) => {
        output += text;
      },
      createApplication: async (options) => {
        const service = await ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: { provider },
        });
        services.push(service);
        return service;
      },
    }).parseAsync(
      [
        "--model",
        "4o",
        "--file",
        "selected.txt",
        "--message",
        "private chat not for commit generation",
        "--no-color",
        "--generate-commit-messages",
        "--git-commit-verify",
        "--commit-author-name",
        "Model Author",
        "--commit-committer-name",
        "Commit Runner",
        "--commit-co-author",
        "Collaborator <co@example.invalid>",
        "--lint-cmd",
        lint,
      ],
      { from: "user" },
    );
    expect(provider.requests).toHaveLength(4);
    for (const request of provider.requests.slice(1)) {
      expect(request.model).toBe("gpt-4o-mini");
      expect(request.maxOutputTokens).toBe(128);
      expect(JSON.stringify(request.messages)).not.toContain(
        "private chat not for commit generation",
      );
      expect(JSON.stringify(request.messages)).not.toContain("unrelated");
    }
    expect(await git(root, "show", "HEAD~2:selected.txt")).toBe("dirty\n");
    expect(await git(root, "show", "HEAD~1:selected.txt")).toBe("edited\n");
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("linted\n");
    expect(await git(root, "show", "-s", "--format=%an|%cn|%s", "HEAD~2")).toBe(
      "Patch Test|Commit Runner|chore: save user work\n",
    );
    expect(await git(root, "show", "-s", "--format=%an|%cn|%s", "HEAD~1")).toBe(
      "Model Author|Commit Runner|fix: edit selected file\n",
    );
    expect(await git(root, "show", "-s", "--format=%B", "HEAD~1")).toContain(
      "Co-authored-by: Collaborator <co@example.invalid>",
    );
    expect(
      await git(root, "show", "-s", "--format=%B", "HEAD~2"),
    ).not.toContain("Co-authored-by");
    expect(await git(root, "show", "-s", "--format=%an|%cn|%s", "HEAD")).toBe(
      "Patch Test|Commit Runner|style: lint selected file\n",
    );
    expect(await readFile(join(root, ".git/hook-runs"), "utf8")).toBe(
      "ran\nran\nran\n",
    );
    expect(await git(root, "diff", "--cached")).toBe(before.index);
    expect(await git(root, "diff", "--", "unrelated.txt")).toContain(
      "unstaged unrelated",
    );
    expect(output).toContain("Commit message:");
    expect(output).toContain("$0.03 session");
  });

  it("uses explicit manual messages without generation or model authorship", async () => {
    const root = await dirtyRepository();
    const provider = new FakeProvider([]);
    const session = await application(root, provider, {}, [
      "--generate-commit-messages",
      "--commit-author-name",
      "Model Author",
      "--commit-committer-name",
      "Commit Runner",
      "--commit-co-author",
      "Collaborator",
    ]);
    await session.submit("/commit User supplied message", submitOptions());
    expect(provider.requests).toHaveLength(0);
    expect(await git(root, "show", "-s", "--format=%an|%cn|%s")).toBe(
      "Patch Test|Commit Runner|User supplied message\n",
    );
    expect(await git(root, "show", "-s", "--format=%B")).not.toContain(
      "Co-authored-by",
    );
    await session.submit("/commit", submitOptions());
    expect(provider.requests).toHaveLength(0);
  });

  it.each(["checkpoint", "after-write"])(
    "honors failing hooks at %s and keeps the session reusable",
    async (phase) => {
      const root =
        phase === "checkpoint" ? await dirtyRepository() : await repository();
      const before = await state(root);
      const hook = join(root, ".git/hooks/pre-commit");
      await writeFile(hook, "#!/bin/sh\nexit 1\n");
      await chmod(hook, 0o755);
      await git(root, "config", "core.hooksPath", ".git/hooks");
      const session = await application(
        root,
        response(
          edit(
            "selected.txt",
            phase === "checkpoint" ? "dirty" : "base",
            "edited",
          ),
        ),
        {},
        ["--git-commit-verify"],
      );
      await expect(session.submit("edit", submitOptions())).rejects.toThrow(
        phase === "checkpoint"
          ? "Git command failed"
          : "The turn already changed selected.txt",
      );
      expect(await git(root, "rev-parse", "HEAD")).toBe(before.head);
      expect(await readFile(join(root, "selected.txt"), "utf8")).toBe(
        phase === "checkpoint" ? "dirty\n" : "edited\n",
      );
      const bypass = await application(root, new FakeProvider([]), {}, [
        "--no-git-commit-verify",
      ]);
      await bypass.submit("/commit explicit recovery", submitOptions());
      await expect(
        session.submit("/ls", submitOptions()),
      ).resolves.toMatchObject({ kind: "command" });
    },
  );

  it.each([
    "empty",
    "multiline",
    "oversized",
    "long-subject",
    "truncated",
    "provider-error",
    "cancelled",
  ])("refuses %s commit generation before staging", async (failure) => {
    const root = await dirtyRepository();
    const before = await state(root);
    const actions =
      failure === "provider-error"
        ? [
            {
              type: "error",
              kind: "provider",
              message: "private provider error",
              retryable: false,
            },
          ]
        : failure === "cancelled"
          ? [{ type: "delay", milliseconds: 10_000 }]
          : [
              {
                type: "text-delta",
                text:
                  failure === "empty"
                    ? ""
                    : failure === "multiline"
                      ? "fix: change\nCo-authored-by: injected"
                      : failure === "oversized"
                        ? "x".repeat(513)
                        : failure === "long-subject"
                          ? "x".repeat(73)
                          : "fix: cut",
              },
              {
                type: "finish",
                reason: failure === "truncated" ? "length" : "stop",
              },
            ];
    const provider = new FakeProvider([{ actions }]);
    const session = await application(root, provider, {}, [
      "--generate-commit-messages",
    ]);
    const controller = new AbortController();
    const pending = session.submit("/commit", {
      signal: controller.signal,
      emit: () => undefined,
    });
    if (failure === "cancelled") {
      await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
      controller.abort(new Error("cancelled by test"));
    }
    await expect(pending).rejects.toThrow(
      failure === "cancelled"
        ? "cancelled by test"
        : "Commit-message generation failed",
    );
    expect(await state(root)).toEqual(before);
    await session.submit("/commit recover explicitly", submitOptions());
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("dirty\n");
  });

  it("honors configured generation when CLI flags are absent and closes the weak provider", async () => {
    const root = await dirtyRepository();
    const weak = response(`"${"x".repeat(72)}"`);
    const close = vi.fn();
    let calls = 0;
    await writeFile(
      join(root, ".patch.conf.yml"),
      "generate-commit-messages: true\n",
    );
    await createProgram({
      cwd: root,
      environment: {},
      writeOutput: () => undefined,
      createApplication: async (options) => {
        const service = await ConcreteApplicationService.create({
          ...options,
          home: root,
          dependencies: {
            createProvider: () =>
              ++calls === 1
                ? new FakeProvider([])
                : { stream: weak.stream.bind(weak), close },
          },
        });
        services.push(service);
        return service;
      },
    }).parseAsync(
      ["--model", "4o", "--file", "selected.txt", "--message", "/commit"],
      { from: "user" },
    );
    expect(weak.requests).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
    expect((await git(root, "show", "-s", "--format=%s")).trim()).toBe(
      "x".repeat(72),
    );
  });

  it("refuses an oversized or newly ignored diff without sending it", async () => {
    const root = await repository();
    const provider = new FakeProvider([]);
    const session = await application(root, provider, {}, [
      "--generate-commit-messages",
    ]);
    await writeFile(join(root, "selected.txt"), "large diff ".repeat(30_000));
    const before = await state(root);
    await expect(session.submit("/commit", submitOptions())).rejects.toThrow(
      "Selected diff is too large",
    );
    expect(await state(root)).toEqual(before);
    await writeFile(join(root, ".aiderignore"), "selected.txt\n");
    await expect(session.submit("/commit", submitOptions())).rejects.toThrow(
      /ignored/u,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("reports surviving edits when commit-message generation fails after a write", async () => {
    const root = await repository();
    const before = await state(root);
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: edit("selected.txt", "base", "edited") },
          { type: "finish", reason: "stop" },
        ],
      },
      { actions: [{ type: "finish", reason: "length" }] },
    ]);
    const session = await application(root, provider, {}, [
      "--generate-commit-messages",
    ]);
    await expect(
      session.submit("edit", submitOptions()),
    ).rejects.toBeInstanceOf(TurnPartiallyAppliedError);
    expect(await git(root, "rev-parse", "HEAD")).toBe(before.head);
    expect(await git(root, "diff", "--cached")).toBe(before.index);
    expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("edited\n");
    expect(await session.snapshot()).toMatchObject({
      messages: expect.arrayContaining([{ role: "user", content: "edit" }]),
    });
    await session.submit("/commit explicit recovery", submitOptions());
    expect(await git(root, "show", "HEAD:selected.txt")).toBe("edited\n");
  });

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
    const head = async () => (await git(root, "rev-parse", "HEAD")).trim();
    // The edits and their commit survive the reflection limit, so the failure
    // reports them instead of only reporting that the turn failed.
    const failure = await session.submit("fix", submitOptions()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TurnPartiallyAppliedError);
    const partial = failure as TurnPartiallyAppliedError;
    expect(partial.changedPaths).toEqual(["selected.txt"]);
    expect(partial.commit).toBe(await head());
    expect(partial.cause).toMatchObject({
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
    const snapshot = (await session.snapshot()) as {
      messages: { role: string; content: string }[];
    };
    expect(snapshot).toMatchObject({
      phase: "interrupted",
      pendingEdits: [],
      lastPatchCommit: await head(),
    });
    // History records the turn whose edits are still on disk.
    expect(snapshot.messages[0]).toMatchObject({
      role: "user",
      content: "fix",
    });
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant" });
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
      events.indexOf("command-complete"),
    );
    expect(events.indexOf("command-complete")).toBeLessThan(
      events.indexOf("test-start"),
    );

    const git = await GitRepository.open(root);
    const status = await git.status();
    expect(status.modifiedPaths).toEqual(["unrelated.txt"]);
    const log = (await executeFile("git", ["-C", root, "log", "--format=%s"]))
      .stdout;
    expect(log).toContain("Apply Patch edits");
    expect(log).toContain("Checkpoint before Patch edits");

    // Another session owns no commit here, so it must not reset this one's.
    const observer = await service.createSession({
      principal: "test",
      sessionId: "observer",
    });
    await expect(
      observer.submit("/undo", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow(/no Patch commit to undo/);
    expect((await git.status()).head).toBe(status.head);

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
