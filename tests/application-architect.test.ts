import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  ModelCatalog,
  type ModelSettings,
  type SessionState,
} from "../src/index.js";

const executeFile = promisify(execFile);
const roots: string[] = [];
const catalog = ModelCatalog.load({
  settings: [new URL("./fixtures/switch-models.yml", import.meta.url)],
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const response = (text: string) => ({
  actions: [
    { type: "text-delta" as const, text },
    { type: "usage" as const, inputTokens: 10, outputTokens: 5 },
    { type: "finish" as const, reason: "stop" as const },
  ],
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patch-architect-"));
  roots.push(root);
  await executeFile("git", ["init", "--quiet", root]);
  await executeFile("git", ["-C", root, "config", "user.name", "Test"]);
  await executeFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await executeFile("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "value.txt"), "old\n");
  await executeFile("git", ["-C", root, "add", "value.txt"]);
  await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  return root;
}

async function application(
  root: string,
  main: FakeProvider,
  editor: FakeProvider,
) {
  const service = await ConcreteApplicationService.create({
    cwd: root,
    home: root,
    environment: {},
    argv: ["--model", "test/diff-model", "--file", "value.txt"],
    dependencies: {
      catalog: await catalog,
      createProvider: (model: ModelSettings) =>
        model.name === "test/editor-model" ? editor : main,
    },
  });
  return service.createSession({ principal: "test", sessionId: "architect" });
}

describe("production architect handoff", () => {
  it("requires acceptance and transfers editor state, cost, commit, and final history", async () => {
    const root = await repository();
    const main = new FakeProvider([
      response("Change value.txt from old to new."),
    ]);
    const editor = new FakeProvider([
      response(
        "value.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n",
      ),
    ]);
    const session = await application(root, main, editor);
    const accept = vi.fn(() => true);

    const result = await session.runArchitect?.("make it new", {
      signal: new AbortController().signal,
      emit: () => undefined,
      accept,
    });

    expect(accept).toHaveBeenCalledWith("Change value.txt from old to new.");
    expect(result).toMatchObject({
      accepted: true,
      editor: { changedPaths: ["value.txt"], commit: expect.any(String) },
    });
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("new\n");
    const state = (await session.snapshot()) as SessionState;
    expect(state.lastPatchCommit).toBe(
      (result?.editor as { commit: string }).commit,
    );
    expect(state.totalCost).toBe(0.00003);
    expect(state.messages.slice(-4)).toEqual([
      { role: "user", content: "make it new" },
      { role: "assistant", content: "Change value.txt from old to new." },
      { role: "user", content: "I made those changes to the files." },
      { role: "assistant", content: "Ok." },
    ]);
    expect(JSON.stringify(main.requests[0]?.messages)).toContain(
      "expert architect engineer",
    );
    expect(editor.requests[0]?.messages.at(-2)?.content).toBe(
      "Change value.txt from old to new.",
    );
  });

  it("records a denied proposal without constructing the editor", async () => {
    const root = await repository();
    const editor = new FakeProvider([response("unused")]);
    const session = await application(
      root,
      new FakeProvider([response("proposal")]),
      editor,
    );
    await expect(
      session.runArchitect?.("request", {
        signal: new AbortController().signal,
        emit: () => undefined,
        accept: () => false,
      }),
    ).resolves.toMatchObject({ accepted: false });
    expect(editor.requests).toHaveLength(0);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("old\n");
    expect(
      ((await session.snapshot()) as SessionState).messages.slice(-2),
    ).toEqual([
      { role: "user", content: "request" },
      { role: "assistant", content: "proposal" },
    ]);
  });

  it("does not start the editor when acceptance cancels the handoff", async () => {
    const root = await repository();
    const editor = new FakeProvider([response("unused")]);
    const session = await application(
      root,
      new FakeProvider([response("proposal")]),
      editor,
    );
    const controller = new AbortController();
    await expect(
      session.runArchitect?.("request", {
        signal: controller.signal,
        emit: () => undefined,
        accept: () => {
          controller.abort(new Error("cancelled at acceptance"));
          return true;
        },
      }),
    ).rejects.toThrow("cancelled at acceptance");
    expect(editor.requests).toHaveLength(0);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("old\n");
  });
});
